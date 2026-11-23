import { Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AggregatorMetrics, ORACLE_RESOLUTION_LAG_H_METRIC } from "../aggregator/metrics.js";

export interface ResolveMarketResult {
  marketId: string;
  outcome: boolean;
  txHash: string;
  dryRun?: boolean;
  /**
   * Hours between market expiry and finalization, recorded as
   * `oracle_resolution_lag_h`. Present only when `endTime` was provided.
   */
  lagHours?: number;
}

/** Builds, signs, and submits the on-chain resolution, returning the confirmed tx hash. */
export interface OnChainSubmitter {
  submitResolution(marketId: string, outcome: boolean): Promise<string>;
}

export type MarketResolvedLookup = (marketId: string) => Promise<boolean>;
export type ResolveMarketRecorder = (result: ResolveMarketResult) => Promise<void>;
export type RetryAlertHandler = (marketId: string, attempt: number, error: unknown) => void;

export interface ResolveMarketDependencies {
  submitter: OnChainSubmitter;
  /** Reads durable (DB/on-chain) state — must reflect prior resolutions across restarts. */
  isAlreadyResolved: MarketResolvedLookup;
  recordResult: ResolveMarketRecorder;
  /** Called before each retry so callers can wire up alerting. */
  onRetry?: RetryAlertHandler;
  maxRetries?: number;
  /** Base linear backoff between retries, in ms (attempt * this value). */
  retryBackoffMs?: number;
  /** When true, runs validation/recording without submitting on-chain. */
  dryRun?: boolean;
  /**
   * Optional metrics collector. When provided, a successful resolution records
   * `oracle_resolution_lag_h` (hours from market expiry to finalization).
   * Requires `endTime` to be supplied to `resolveMarketOnChain`.
   */
  metrics?: AggregatorMetrics;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

export type ResolutionSubmissionFailureKind =
  | "expired"
  | "sequence"
  | "ambiguous"
  | "rejected";

export class ResolutionSubmissionError extends Error {
  constructor(
    public readonly kind: ResolutionSubmissionFailureKind,
    message: string,
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "ResolutionSubmissionError";
  }

  get mayHaveLanded(): boolean {
    return this.kind === "ambiguous";
  }
}

export function classifyResolutionFailure(value: unknown): ResolutionSubmissionFailureKind {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  if (/expired|tx_too_late|too[ _-]?late|ledger.*bound/i.test(text)) return "expired";
  if (/tx_bad_seq|bad[ _-]?seq|sequence/i.test(text)) return "sequence";
  return "rejected";
}

/**
 * Submits the final `resolve_market` transaction for a market once council
 * threshold has been reached.
 *
 * Idempotent: checks durable state via `isAlreadyResolved` before
 * submitting, so a crash/restart or a duplicate finalizer trigger never
 * double-resolves a market. Transient submission failures are retried with
 * linear backoff; `onRetry` fires on every failed attempt so the caller can
 * alert, and the final error is thrown once retries are exhausted.
 *
 * When `deps.metrics` and `endTime` are provided, a successful resolution
 * records `oracle_resolution_lag_h` on the metrics collector so the lag
 * from market expiry to on-chain finalization is observable.
 *
 * @param deps      - injected dependencies (submitter, store, optional metrics)
 * @param marketId  - market to resolve
 * @param outcome   - oracle ruling (true = "yes", false = "no")
 * @param endTime   - market expiry as Unix seconds; required for lag recording
 */
export async function resolveMarketOnChain(
  deps: ResolveMarketDependencies,
  marketId: string,
  outcome: boolean,
  endTime?: number,
): Promise<ResolveMarketResult | null> {
  const trimmedId = marketId.trim();
  if (!trimmedId) throw new Error("marketId is required");

  if (await deps.isAlreadyResolved(trimmedId)) return null;

  if (deps.dryRun) {
    const resolvedAt = Math.floor(Date.now() / 1_000);
    let lagHours: number | undefined;
    if (deps.metrics && endTime !== undefined) {
      const entry = deps.metrics.recordResolution(trimmedId, endTime, resolvedAt);
      lagHours = entry.lagHours;
    }
    const result: ResolveMarketResult = {
      marketId: trimmedId,
      outcome,
      txHash: `dry-run-${trimmedId}-${Date.now()}`,
      dryRun: true,
      ...(lagHours !== undefined ? { lagHours } : {}),
    };
    await deps.recordResult(result);
    return result;
  }

  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const txHash = await deps.submitter.submitResolution(trimmedId, outcome);
      const resolvedAt = Math.floor(Date.now() / 1_000);
      let lagHours: number | undefined;
      if (deps.metrics && endTime !== undefined) {
        const entry = deps.metrics.recordResolution(trimmedId, endTime, resolvedAt);
        lagHours = entry.lagHours;
      }
      const result: ResolveMarketResult = {
        marketId: trimmedId,
        outcome,
        txHash,
        ...(lagHours !== undefined ? { lagHours } : {}),
      };
      await deps.recordResult(result);
      return result;
    } catch (error) {
      lastError = error;
      deps.onRetry?.(trimmedId, attempt, error);

      // A timeout or other ambiguous result may have landed. Re-check durable
      // state before any retry so we never double-resolve after losing the RPC
      // confirmation response.
      if (
        error instanceof ResolutionSubmissionError &&
        error.mayHaveLanded &&
        (await deps.isAlreadyResolved(trimmedId))
      ) {
        if (!error.txHash) return null;
        const resolvedAt = Math.floor(Date.now() / 1_000);
        let lagHours: number | undefined;
        if (deps.metrics && endTime !== undefined) {
          lagHours = deps.metrics.recordResolution(trimmedId, endTime, resolvedAt).lagHours;
        }
        const recovered: ResolveMarketResult = {
          marketId: trimmedId,
          outcome,
          txHash: error.txHash,
          ...(lagHours !== undefined ? { lagHours } : {}),
        };
        await deps.recordResult(recovered);
        return recovered;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * retryBackoffMs));
      }
    }
  }

  throw new Error(
    `resolve_market failed for market ${trimmedId} after ${maxRetries} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 45; // 90 seconds total

/** Real Stellar SDK-backed `OnChainSubmitter`, mirroring the wallet-signed flow in frontend/src/services/soroban.ts but signing server-side with the resolver key. */
export function createStellarSubmitter(options: {
  server: rpc.Server;
  contractId: string;
  networkPassphrase: string;
  resolverKeypair: Keypair;
  maxRebuildAttempts?: number;
}): OnChainSubmitter {
  const {
    server,
    contractId,
    networkPassphrase,
    resolverKeypair,
    maxRebuildAttempts = 3,
  } = options;

  async function pollUntilTerminal(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await server.getTransaction(hash);
      if (response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return response;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new ResolutionSubmissionError(
      "ambiguous",
      `resolve_market confirmation timed out for tx ${hash}`,
      hash,
    );
  }

  return {
    async submitResolution(marketId, outcome) {
      const caller = resolverKeypair.publicKey();
      const sourceAccount = await server.getAccount(caller);

      const contract = new Contract(contractId);
      const operation = contract.call(
        "resolve_market",
        new Address(caller).toScVal(),
        nativeToScVal(BigInt(marketId), { type: "u64" }),
        nativeToScVal(outcome),
      );
      let lastError: unknown;

      for (let rebuildAttempt = 1; rebuildAttempt <= maxRebuildAttempts; rebuildAttempt += 1) {
        try {
          // Fetching the source account inside the loop is deliberate: every
          // rebuild receives a fresh sequence number and a fresh ledger bound.
          const sourceAccount = await server.getAccount(caller);
          const operation = new Contract(contractId).call(
            "resolve_market",
            new Address(caller).toScVal(),
            nativeToScVal(BigInt(marketId), { type: "u64" }),
            nativeToScVal(outcome),
          );

          const tx = new TransactionBuilder(sourceAccount, {
            fee: "100000",
            networkPassphrase,
          })
            .addOperation(operation)
            .setTimeout(300)
            .build();

          const prepared = await server.prepareTransaction(tx);
          prepared.sign(resolverKeypair);

          const sendResponse = await server.sendTransaction(prepared);
          if (sendResponse.status === "TRY_AGAIN_LATER") {
            throw new ResolutionSubmissionError(
              "ambiguous",
              `resolve_market network response was inconclusive for market ${marketId}`,
            );
          }
          if (sendResponse.status === "ERROR") {
            const kind = classifyResolutionFailure(sendResponse);
            throw new ResolutionSubmissionError(
              kind,
              `resolve_market rejected for market ${marketId}: ${JSON.stringify(sendResponse)}`,
            );
          }

          const confirmation = await pollUntilTerminal(sendResponse.hash);
          if (confirmation.status === rpc.Api.GetTransactionStatus.SUCCESS) {
            return sendResponse.hash;
          }

          const kind = classifyResolutionFailure(confirmation);
          if (
            (kind === "expired" || kind === "sequence") &&
            rebuildAttempt < maxRebuildAttempts
          ) {
            lastError = new ResolutionSubmissionError(
              kind,
              `resolve_market ${kind} failure; rebuilding transaction`,
              sendResponse.hash,
            );
            continue;
          }

          throw new ResolutionSubmissionError(
            kind,
            `resolve_market failed on-chain for market ${marketId}: ${confirmation.status}`,
            sendResponse.hash,
          );
        } catch (error) {
          lastError = error;
          const kind =
            error instanceof ResolutionSubmissionError
              ? error.kind
              : classifyResolutionFailure(error);

          if (
            (kind === "expired" || kind === "sequence") &&
            rebuildAttempt < maxRebuildAttempts
          ) {
            continue;
          }

          if (error instanceof ResolutionSubmissionError) throw error;
          throw new ResolutionSubmissionError(
            kind,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      throw new Error(
        `resolve_market exhausted ${maxRebuildAttempts} rebuild attempt(s): ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  };
}