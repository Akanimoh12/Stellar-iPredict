import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { config } from "./config/index.js";
import { pool } from "./db.js";

// Helper to detect 429 Rate Limit error
export function isRateLimitError(err: any): boolean {
  if (!err) return false;
  const status = err.status || err.response?.status || err.response?.statusText;
  if (status === 429) return true;
  const msg = String(err).toLowerCase();
  return msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit");
}

// Retry wrapper with exponential backoff
export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries = 5,
  delay = 1000
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isRateLimitError(error) && retries > 0) {
      console.warn(`[backfill] Rate limited (429). Retrying in ${delay}ms... (Retries left: ${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

// Parse and write a single event to the database
export async function writeEventToDb(
  ledgerSeq: number,
  txHash: string,
  topics: any[],
  data: any
): Promise<void> {
  const eventName = String(topics[0]);

  // Write to audit events table first (if possible)
  try {
    const marketId = topics[1] ? Number(topics[1]) : (data?.market_id ? Number(data.market_id) : null);
    const actor = topics[2] ? String(topics[2]) : (data?.user ? String(data.user) : null);
    await pool.query(
      `INSERT INTO events (ledger_seq, tx_hash, event_type, market_id, actor, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [ledgerSeq, txHash, eventName, marketId, actor, JSON.stringify(data)]
    );
  } catch (err) {
    // Audit table might not exist in target database, fail silently but log
    console.debug("Optional events audit logging skipped:", (err as Error).message);
  }

  // Handle specific event actions
  if (eventName === "market_created" || (eventName === "mkt" && topics[1] === "created")) {
    const marketId = data.id ?? data[0] ?? (topics[1] ? Number(topics[1]) : 0);
    const question = data.question ?? data[1] ?? "";
    const category = data.category ?? data[2] ?? "Other";
    const endTime = data.end_time ?? data[3] ?? 0;
    const creator = data.creator ?? data[4] ?? "";
    await pool.query(
      `INSERT INTO markets (id, question, category, end_time, creator)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [marketId, question, category, endTime, creator]
    );
  } else if (eventName === "market_resolved" || (eventName === "mkt" && topics[1] === "resolved")) {
    const marketId = topics[1] ?? data.market_id ?? data[0];
    const outcome = data.outcome ?? data[1] ?? false;
    await pool.query(
      `UPDATE markets SET resolved=true, outcome=$2, updated_at=NOW()
       WHERE id=$1`,
      [marketId, outcome]
    );
  } else if (eventName === "market_cancelled") {
    const marketId = topics[1] ?? data.market_id;
    await pool.query(
      `UPDATE markets SET cancelled=true, updated_at=NOW()
       WHERE id=$1`,
      [marketId]
    );
  } else if (eventName === "bet_placed" || eventName === "bet") {
    const marketId = topics[1] ?? data.market_id ?? data[0];
    const bettor = topics[2] ?? data.bettor ?? data.user ?? data[1];
    const netAmount = data.net_amount ?? data.amount ?? data.net ?? data[2] ?? 0;
    const grossAmount = data.gross_amount ?? data.gross ?? netAmount;
    const isYes = data.is_yes ?? data[3] ?? true;

    await pool.query(
      `INSERT INTO bets (market_id, bettor, net_amount, gross_amount, is_yes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (market_id, bettor) DO UPDATE
       SET net_amount = bets.net_amount + EXCLUDED.net_amount,
           gross_amount = bets.gross_amount + EXCLUDED.gross_amount`,
      [marketId, bettor, netAmount, grossAmount, isYes]
    );
  }
}

// Historical backfill main entry point
export async function runBackfill(): Promise<number> {
  const server = new rpc.Server(config.SOROBAN_RPC_URL);

  console.log(`[backfill] Fetching current network head ledger...`);
  const latestLedgerResponse = await fetchWithRetry<rpc.Api.GetLatestLedgerResponse>(async () => {
    return await server.getLatestLedger();
  });
  const headLedger = latestLedgerResponse.sequence;

  console.log(`[backfill] Network head ledger is ${headLedger}. Starting backfill from ${config.START_LEDGER}...`);

  let currentLedger = config.START_LEDGER;
  let cursor: string | undefined = undefined;

  while (currentLedger <= headLedger) {
    const request: rpc.Api.GetEventsRequest = cursor
      ? {
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          cursor,
          limit: config.EVENTS_PER_PAGE,
        }
      : {
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          startLedger: currentLedger,
          limit: config.EVENTS_PER_PAGE,
        };

    console.log(
      `[backfill] Fetching events page: ${
        cursor ? `cursor=${cursor}` : `startLedger=${currentLedger}`
      } (limit=${config.EVENTS_PER_PAGE})`
    );

    const response: rpc.Api.GetEventsResponse = await fetchWithRetry<rpc.Api.GetEventsResponse>(async (): Promise<rpc.Api.GetEventsResponse> => {
      return await server.getEvents(request);
    });
    const events = response.events || [];

    if (events.length === 0) {
      console.log(`[backfill] Page returned 0 events. latestLedger=${response.latestLedger}`);
      if (response.latestLedger >= headLedger) {
        currentLedger = response.latestLedger;
        break;
      }
      currentLedger = response.latestLedger + 1;
      cursor = undefined; // reset cursor as we are advancing startLedger
      continue;
    }

    console.log(`[backfill] Processing ${events.length} events...`);
    for (const event of events) {
      const topics = event.topic.map((t: any) => scValToNative(t));
      const data = scValToNative(event.value);
      await writeEventToDb(event.ledger, event.txHash, topics, data);
    }

    const lastEventLedger = events[events.length - 1].ledger;
    currentLedger = lastEventLedger;
    cursor = response.cursor;

    console.log(`[backfill] Processed events up to ledger ${lastEventLedger}`);

    if (lastEventLedger >= headLedger) {
      break;
    }
  }

  console.log(`[backfill] Completed backfill up to ledger ${currentLedger}`);
  return currentLedger;
}
