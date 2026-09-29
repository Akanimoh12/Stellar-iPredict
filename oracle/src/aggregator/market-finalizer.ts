import {
  Address,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import type { Logger } from "../log.js";
import type { CouncilVote } from "./threshold.js";
import { notifyFinalized, type FinalizeNotifierOptions } from "./finalize-notifier.js";

/** Correlation for one finalization, passed explicitly from processMarket (#467). */
export interface FinalizeTrace {
  correlationId: string;
  /** Backend request id of the HTTP submission for this market, if any. */
  originRequestId?: string;
  /** Logger already bound to the correlation id. */
  logger?: Logger;
}

export class MarketAlreadyFinalizedError extends Error {
  constructor(marketId: string) {
    super(`Market ${marketId} already finalized`);
    this.name = "MarketAlreadyFinalizedError";
  }
}

export class FinalizationOutcomeMismatchError extends Error {
  constructor(marketId: string, intended: boolean, actual: boolean) {
    super(
      `Market ${marketId} is already resolved with outcome ${actual ? "YES" : "NO"}, ` +
        `but this finalization intended ${intended ? "YES" : "NO"}`,
    );
    this.name = "FinalizationOutcomeMismatchError";
  }
}

function boolVal(value: boolean): xdr.ScVal {
  return nativeToScVal(value);
}

function u64Val(value: number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "u64" });
}

function addressVal(value: string): xdr.ScVal {
  return new Address(value).toScVal();
}

function decisionLabel(decision: boolean): string {
  return decision ? "yes" : "no";
}

function signPreparedTransaction(xdrString: string, secretKey: string, networkPassphrase: string): string {
  const keypair = Keypair.fromSecret(secretKey);
  const transaction = TransactionBuilder.fromXDR(xdrString, networkPassphrase);
  transaction.sign(keypair);
  return transaction.toXDR();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function extractSendError(response: rpc.Api.SendTransactionResponse): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = response as any;
  if (payload.errorResult) return `Error result: ${JSON.stringify(payload.errorResult)}`;
  if (payload.errorResultXdr) return `Error XDR: ${payload.errorResultXdr}`;
  return response.status;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitResolutionTransaction(
  server: rpc.Server,
  contractId: string,
  resolverSecret: string,
  marketId: number,
  outcome: boolean,
  networkPassphrase: string = Networks.TESTNET,
  onSubmitted?: (txHash: string) => Promise<void>,
): Promise<string> {
  const signer = Keypair.fromSecret(resolverSecret);
  const sourcePublicKey = signer.publicKey();
  const sourceAccount = await server.getAccount(sourcePublicKey);
  const contract = new Contract(contractId);
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call("resolve_market", addressVal(sourcePublicKey), u64Val(marketId), boolVal(outcome)))
    .setTimeout(300)
    .build();

  const prepared = await server.prepareTransaction(transaction);
  const signedXdr = signPreparedTransaction(prepared.toXDR(), resolverSecret, networkPassphrase);
  const parsedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const response = await server.sendTransaction(parsedTx);

  if (response.status === "ERROR") {
    throw new Error(`Transaction rejected: ${extractSendError(response)}`);
  }

  if (response.status === "TRY_AGAIN_LATER") {
    throw new Error("Network busy — please try again later");
  }

  if (!response.hash) {
    throw new Error("Transaction was submitted successfully but no hash was returned");
  }

  // Persist the hash before confirmation. A crash or timeout after this point
  // can inspect the exact transaction rather than blindly submitting again.
  await onSubmitted?.(response.hash);
  await waitForConfirmation(server, response.hash);
  return response.hash;
}

async function waitForConfirmation(server: rpc.Server, hash: string): Promise<void> {
  const MAX_ATTEMPTS = 30;
  const POLL_INTERVAL_MS = 1_000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const txResponse = await server.getTransaction(hash);
      if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
      if (txResponse.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(txResponse)}`);
      }
    } catch (error) {
      // Keep waiting if the transaction is not yet visible.
      if (attempt === MAX_ATTEMPTS - 1) throw error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for transaction confirmation: ${hash}`);
}

export interface FinalizationAttempt {
  txHash: string;
  outcome: boolean;
  status: "submitted" | "challenged" | "finalized" | "rejected";
}

export async function getFinalizationAttempt(
  db: Pool,
  marketId: number,
): Promise<FinalizationAttempt | null> {
  const result = await db.query<{
    tx_hash: string | null;
    outcome: string;
    status: FinalizationAttempt["status"];
  }>(
    "SELECT tx_hash, outcome, status FROM oracle_submissions WHERE market_id = $1",
    [marketId],
  );
  const row = result.rows[0];
  if (!row?.tx_hash) return null;
  return {
    txHash: row.tx_hash.trim(),
    outcome: row.outcome.toUpperCase() === "YES",
    status: row.status,
  };
}

/**
 * Durable write performed immediately after Soroban accepts the submission
 * and returns a transaction hash, before confirmation polling begins.
 */
export async function recordFinalizationAttempt(
  db: Pool,
  marketId: number,
  decision: boolean,
  txHash: string,
  submitter: string,
  requestId?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO oracle_submissions (
      market_id, submitter, outcome, bond_amount, submitted_at, status,
      decision, tx_hash, request_id
    ) VALUES ($1, $2, $3, 0, NOW(), 'submitted', $4, $5, $6)
    ON CONFLICT (market_id) DO UPDATE SET
      submitter = EXCLUDED.submitter,
      outcome = EXCLUDED.outcome,
      submitted_at = NOW(),
      status = 'submitted',
      decision = EXCLUDED.decision,
      tx_hash = EXCLUDED.tx_hash,
      request_id = COALESCE(EXCLUDED.request_id, oracle_submissions.request_id)
    WHERE oracle_submissions.status <> 'finalized'`,
    [
      marketId,
      submitter,
      decision ? "YES" : "NO",
      decisionLabel(decision),
      txHash,
      requestId ?? null,
    ],
  );
}

async function markFinalDecision(
  db: Pool,
  marketId: number,
  decision: boolean,
  txHash: string,
  councilVotes: CouncilVote[],
  requestId?: string,
): Promise<void> {
  await db.query(
    `UPDATE oracle_submissions
       SET outcome = $2,
           status = 'finalized',
           decision = $3,
           tx_hash = $4,
           finalized_at = NOW(),
           council_votes = $5,
           request_id = COALESCE($6, request_id)
     WHERE market_id = $1`,
    [
      marketId,
      decision ? "YES" : "NO",
      decisionLabel(decision),
      txHash,
      JSON.stringify(councilVotes),
      requestId ?? null,
    ],
  );
}

export async function persistFinalDecision(
  db: Pool,
  marketId: number,
  decision: boolean,
  txHash: string,
  councilVotes: CouncilVote[],
  submitter: string,
  /** Correlation id of the attempt writing the row, stored in request_id (#467). */
  requestId?: string,
): Promise<void> {
  const existing = await db.query("SELECT 1 FROM oracle_submissions WHERE market_id = $1", [marketId]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new MarketAlreadyFinalizedError(String(marketId));
  }

  const now = new Date();
  try {
    await db.query(
      `INSERT INTO oracle_submissions (
        market_id,
        submitter,
        outcome,
        bond_amount,
        submitted_at,
        status,
        decision,
        tx_hash,
        finalized_at,
        council_votes,
        request_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        marketId,
        submitter,
        // `outcome` only accepts the canonical YES/NO since migration 0017;
        // `decision` keeps its documented lowercase label.
        decision ? "YES" : "NO",
        0,
        now,
        "finalized",
        decisionLabel(decision),
        txHash,
        now,
        JSON.stringify(councilVotes),
        requestId ?? null,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MarketAlreadyFinalizedError(String(marketId));
    }
    throw error;
  }
}

export async function finalizeMarketDecision(
  db: Pool,
  server: rpc.Server,
  contractId: string,
  resolverSecret: string,
  marketId: number,
  decision: boolean,
  councilVotes: CouncilVote[],
  networkPassphrase: string = Networks.TESTNET,
  notifierOptions?: FinalizeNotifierOptions,
  onCommitted?: (finalizedAt: Date) => void,
  trace?: FinalizeTrace,
): Promise<string> {
  const submitter = Keypair.fromSecret(resolverSecret).publicKey();
  const existing = await getFinalizationAttempt(db, marketId);

  if (existing) {
    if (existing.outcome !== decision) {
      const state = await queryMarketState(
        server,
        contractId,
        marketId,
        resolverSecret,
        networkPassphrase,
      );
      const actual = state.resolved ? state.outcome : existing.outcome;
      trace?.logger?.error("finalization outcome mismatch", {
        marketId: String(marketId),
        intended: decision,
        actual,
        txHash: existing.txHash,
      });
      throw new FinalizationOutcomeMismatchError(String(marketId), decision, actual);
    }

    const state = await queryMarketState(
      server,
      contractId,
      marketId,
      resolverSecret,
      networkPassphrase,
    );
    if (state.resolved) {
      if (state.outcome !== decision) {
        trace?.logger?.error("on-chain finalization disagrees with intended outcome", {
          marketId: String(marketId),
          intended: decision,
          actual: state.outcome,
          txHash: existing.txHash,
        });
        throw new FinalizationOutcomeMismatchError(
          String(marketId),
          decision,
          state.outcome,
        );
      }

      await markFinalDecision(
        db,
        marketId,
        decision,
        existing.txHash,
        councilVotes,
        trace?.correlationId,
      );
      trace?.logger?.info("reconciled previously submitted finalization", {
        marketId: String(marketId),
        txHash: existing.txHash,
      });
      return existing.txHash;
    }

    const tx = await server.getTransaction(existing.txHash);
    if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      await markFinalDecision(
        db,
        marketId,
        decision,
        existing.txHash,
        councilVotes,
        trace?.correlationId,
      );
      return existing.txHash;
    }

    if (tx.status !== rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        `Recorded finalization transaction ${existing.txHash} is still unresolved; refusing to resubmit market ${marketId}`,
      );
    }
  }

  const txHash = await submitResolutionTransaction(
    server,
    contractId,
    resolverSecret,
    marketId,
    decision,
    networkPassphrase,
    async (submittedHash) => {
      await recordFinalizationAttempt(
        db,
        marketId,
        decision,
        submittedHash,
        submitter,
        trace?.correlationId,
      );
      trace?.logger?.info("persisted finalization transaction hash", {
        marketId: String(marketId),
        txHash: submittedHash,
      });
    },
  );

  await markFinalDecision(
    db,
    marketId,
    decision,
    txHash,
    councilVotes,
    trace?.correlationId,
  );

  const persisted = { marketId: String(marketId), txHash, decision: decisionLabel(decision) };
  if (trace?.logger) {
    trace.logger.info("persisted finalized decision", persisted);
  } else {
    console.info(
      `Persisted finalized decision for market ${marketId} with tx_hash=${txHash} and decision=${decisionLabel(decision)}`,
    );
  }

  try {
    onCommitted?.(new Date());
  } catch (error) {
    console.warn(`Failed to record post-commit finalization metric for market ${marketId}`, error);
  }

  await notifyFinalized(
    {
      marketId: String(marketId),
      decision,
      txHash,
      councilVotes,
      finalizedAt: new Date().toISOString(),
      correlationId: trace?.correlationId,
      originRequestId: trace?.originRequestId,
    },
    { ...notifierOptions, logger: notifierOptions?.logger ?? trace?.logger },
  );

  return txHash;
}

export async function queryMarketState(
  server: rpc.Server,
  contractId: string,
  marketId: number,
  resolverSecret: string,
  networkPassphrase: string = Networks.TESTNET,
): Promise<{ resolved: boolean; outcome: boolean; cancelled: boolean; endTime: number }> {
  const signer = Keypair.fromSecret(resolverSecret);
  const sourceAccount = await server.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call("get_market", u64Val(marketId)))
    .setTimeout(30)
    .build();

  const response = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(response)) {
    throw new Error(`Simulation failed: ${JSON.stringify(response)}`);
  }

  if (!response.result) {
    throw new Error("Simulation returned no result");
  }

  // The contract's Market struct arrives as an ScVal map keyed by field name;
  // reading fields off the raw ScVal yields undefined, which made every market
  // look open and let already-resolved or cancelled ones be sent a resolution.
  const market = response.result.retval ? scValToNative(response.result.retval) : undefined;
  if (!market || typeof market !== "object") {
    throw new Error("Malformed market simulation result");
  }

  return {
    resolved: Boolean((market as { resolved?: unknown }).resolved),
    outcome: Boolean((market as { outcome?: unknown }).outcome),
    cancelled: Boolean((market as { cancelled?: unknown }).cancelled),
    endTime: Number((market as { end_time?: unknown }).end_time ?? 0),
  };
}

/** Reads the contract's enumerable resolver registry for configuration checks. */
export async function queryRegisteredResolvers(
  server: rpc.Server,
  contractId: string,
  resolverSecret: string,
  networkPassphrase: string = Networks.TESTNET,
): Promise<string[]> {
  const signer = Keypair.fromSecret(resolverSecret);
  const sourceAccount = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(new Contract(contractId).call("get_resolvers"))
    .setTimeout(30)
    .build();

  const response = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(response)) {
    throw new Error(`Resolver registry simulation failed: ${JSON.stringify(response)}`);
  }
  if (!response.result?.retval) throw new Error("Resolver registry returned no result");

  const values = response.result.retval.vec();
  if (!values) throw new Error("Resolver registry returned a non-vector result");
  return values.map((value) => Address.fromScVal(value).toString());
}