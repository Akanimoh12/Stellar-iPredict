/**
 * Token Balance Tracking Handler
 *
 * Tracks IPRED token mint and transfer events to maintain accurate balance snapshots
 * in the token_balances table.
 *
 * ## Design Decision: On-Chain Event Tracking vs SAC Balance Queries
 *
 * This handler tracks token balances by indexing on-chain events (mint, transfer)
 * rather than querying the Stellar Asset Contract (SAC) balance() method on-demand.
 *
 * ### Rationale for Event-Based Tracking:
 *
 * 1. **Performance**: Avoids RPC calls for every balance query. Profile pages and
 *    leaderboards can read directly from PostgreSQL without hitting Soroban RPC.
 *
 * 2. **Historical Data**: Maintains balance snapshots with timestamps, enabling
 *    time-series analysis and historical balance queries.
 *
 * 3. **Consistency**: Aligns with existing indexer architecture (markets, bets,
 *    leaderboard all use event-based indexing).
 *
 * 4. **Scalability**: Reduces load on Soroban RPC as user base grows. At 10,000+
 *    users, querying balances on-demand would create significant RPC pressure.
 *
 * 5. **Offline Capability**: Database remains queryable even if RPC is down or
 *    slow, improving frontend reliability.
 *
 * ### SAC Reconciliation:
 *
 * For full accuracy, a periodic reconciliation job can query the SAC contract's
 * balance() method for all known addresses and compare against indexed balances.
 * This detects any missed events or indexer gaps.
 *
 * Reconciliation script location: `indexer/src/reconcile-token-balances.ts`
 *
 * ### Event Types Handled:
 *
 * - **token_mint**: Credits newly minted tokens to recipient address
 * - **token_transfer**: Debits sender, credits recipient atomically
 *
 * ### Idempotency:
 *
 * All balance updates use the existing event deduplication system via
 * `insertProcessedEvent()`. Events are only processed once, even if the indexer
 * replays ledgers during backfill.
 *
 * ### Cache Invalidation:
 *
 * Redis keys are invalidated on balance changes:
 * - `token_balance:{address}` - Individual balance cache
 * - `stats:global` - Global stats cache (if it includes token supply)
 * - `leaderboard:*` - Leaderboard caches (if sorted by token holdings)
 */

import type { DecodedEvent, HandlerContext } from "./types.js";
import { insertProcessedEvent } from "./idempotency.js";

export const TOKEN_MINT_TOPIC = "token_mint";
export const TOKEN_TRANSFER_TOPIC = "token_transfer";

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

interface TokenMintPayload {
  to: string;
  amount: string;
}

interface TokenTransferPayload {
  from: string;
  to: string;
  amount: string;
}

type RawTokenMintPayload = {
  to?: unknown;
  user?: unknown;
  amount?: unknown;
};

type RawTokenTransferPayload = {
  from?: unknown;
  to?: unknown;
  amount?: unknown;
};

function normalizeAmount(amount: unknown): string {
  if (typeof amount === "bigint") return amount.toString();
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
    return String(amount);
  if (typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount)) return amount;
  throw new Error("Token amount must be a non-negative numeric value");
}

function validateAddress(address: unknown, fieldName: string): string {
  if (typeof address !== "string" || !STELLAR_ADDRESS.test(address)) {
    throw new Error(`${fieldName} must be a valid Stellar public key`);
  }
  return address;
}

export function decodeTokenMint(event: DecodedEvent): TokenMintPayload {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  ) {
    throw new Error("token_mint payload must be an object");
  }

  const payload = event.data as RawTokenMintPayload;
  const to = payload.to ?? payload.user;

  return {
    to: validateAddress(to, "token_mint recipient"),
    amount: normalizeAmount(payload.amount),
  };
}

export function decodeTokenTransfer(event: DecodedEvent): TokenTransferPayload {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  ) {
    throw new Error("token_transfer payload must be an object");
  }

  const payload = event.data as RawTokenTransferPayload;

  return {
    from: validateAddress(payload.from, "token_transfer sender"),
    to: validateAddress(payload.to, "token_transfer recipient"),
    amount: normalizeAmount(payload.amount),
  };
}

/**
 * Handles token mint events by crediting newly minted tokens to the recipient.
 *
 * Updates the token_balances table with idempotent INSERT ON CONFLICT logic.
 * If the address doesn't exist, creates a new row. If it exists, increments the balance.
 */
export async function handleTokenMint(
  event: DecodedEvent,
  context: HandlerContext,
): Promise<void> {
  const payload = decodeTokenMint(event);

  const inserted = await insertProcessedEvent(context.db, {
    event,
    eventType: TOKEN_MINT_TOPIC,
    actor: payload.to,
    payload,
  });
  if (!inserted) return;

  await context.db.query(
    `INSERT INTO token_balances (address, balance, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (address) DO UPDATE
     SET balance = token_balances.balance + EXCLUDED.balance,
         updated_at = NOW()`,
    [payload.to, payload.amount],
  );

  // Invalidate caches
  await context.redis?.del(
    `token_balance:${payload.to}`,
    "stats:global",
    "leaderboard:top20",
  );

  context.logger.info?.("Token mint processed", {
    to: payload.to,
    amount: payload.amount,
    ledger: event.ledger,
    txHash: event.txHash,
  });
}

/**
 * Handles token transfer events by debiting the sender and crediting the recipient.
 *
 * Uses a database transaction to ensure atomic balance updates. If either update
 * fails, both are rolled back.
 *
 * Edge case: If sender balance would go negative, logs a warning but allows the
 * transfer (as the on-chain contract already validated and executed it). This
 * indicates an indexer gap or missed mint event.
 */
export async function handleTokenTransfer(
  event: DecodedEvent,
  context: HandlerContext,
): Promise<void> {
  const payload = decodeTokenTransfer(event);

  const inserted = await insertProcessedEvent(context.db, {
    event,
    eventType: TOKEN_TRANSFER_TOPIC,
    actor: payload.from,
    payload,
  });
  if (!inserted) return;

  // Use transaction to ensure atomic debit/credit
  await context.db.query("BEGIN");
  try {
    // Debit sender
    await context.db.query(
      `INSERT INTO token_balances (address, balance, updated_at)
       VALUES ($1, -$2, NOW())
       ON CONFLICT (address) DO UPDATE
       SET balance = token_balances.balance - $2,
           updated_at = NOW()`,
      [payload.from, payload.amount],
    );

    // Credit recipient
    await context.db.query(
      `INSERT INTO token_balances (address, balance, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (address) DO UPDATE
       SET balance = token_balances.balance + EXCLUDED.balance,
           updated_at = NOW()`,
      [payload.to, payload.amount],
    );

    await context.db.query("COMMIT");
  } catch (error) {
    await context.db.query("ROLLBACK");
    throw error;
  }

  // Check if sender balance went negative (indicates indexer gap)
  const result = (await context.db.query(
    `SELECT balance FROM token_balances WHERE address = $1`,
    [payload.from],
  )) as { rows: Array<{ balance: string }> };
  const senderBalance = result.rows[0]?.balance;
  if (senderBalance && parseFloat(senderBalance) < 0) {
    context.logger.warn("Token transfer resulted in negative sender balance", {
      from: payload.from,
      to: payload.to,
      amount: payload.amount,
      senderBalance,
      ledger: event.ledger,
      txHash: event.txHash,
      note: "This indicates a missed mint event or indexer gap. Consider running reconciliation.",
    });
  }

  // Invalidate caches
  await context.redis?.del(
    `token_balance:${payload.from}`,
    `token_balance:${payload.to}`,
    "stats:global",
    "leaderboard:top20",
  );

  context.logger.info?.("Token transfer processed", {
    from: payload.from,
    to: payload.to,
    amount: payload.amount,
    ledger: event.ledger,
    txHash: event.txHash,
  });
}

/**
 * Generic token event handler that routes to mint or transfer based on event topic.
 */
export async function handleTokenEvent(
  event: DecodedEvent,
  context: HandlerContext,
): Promise<void> {
  const [topic] = event.topics;

  if (topic === TOKEN_MINT_TOPIC) {
    await handleTokenMint(event, context);
  } else if (topic === TOKEN_TRANSFER_TOPIC) {
    await handleTokenTransfer(event, context);
  } else {
    context.logger.warn("Unknown token event topic", {
      topic,
      topics: event.topics,
      ledger: event.ledger,
      txHash: event.txHash,
    });
  }
}
