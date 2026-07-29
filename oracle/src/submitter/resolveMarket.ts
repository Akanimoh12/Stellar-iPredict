import { Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";

export interface ResolveMarketResult {
  marketId: string;
  outcome: boolean;
  txHash: string;
  dryRun?: boolean;
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
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/**
 * Submits the final `resolve_market` transaction for a market once council
 * threshold has been reached.
 *
 * Idempotent: checks durable state via `isAlreadyResolved` before
 * submitting, so a crash/restart or a duplicate finalizer trigger never
 * double-resolves a market. Transient submission failures are retried with
 * linear backoff; `onRetry` fires on every failed attempt so the caller can
 * alert, and the final error is thrown once retries are exhausted.
 */
export async function resolveMarketOnChain(
  deps: ResolveMarketDependencies,
  marketId: string,
  outcome: boolean,
): Promise<ResolveMarketResult | null> {
  const trimmedId = marketId.trim();
  if (!trimmedId) throw new Error("marketId is required");

  if (await deps.isAlreadyResolved(trimmedId)) return null;

  if (deps.dryRun) {
    const result: ResolveMarketResult = {
      marketId: trimmedId,
      outcome,
      txHash: `dry-run-${trimmedId}-${Date.now()}`,
      dryRun: true,
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
      const result: ResolveMarketResult = { marketId: trimmedId, outcome, txHash };
      await deps.recordResult(result);
      return result;
    } catch (error) {
      lastError = error;
      deps.onRetry?.(trimmedId, attempt, error);
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
}): OnChainSubmitter {
  const { server, contractId, networkPassphrase, resolverKeypair } = options;

  async function pollUntilTerminal(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await server.getTransaction(hash);
      if (response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return response;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`resolve_market confirmation timed out for tx ${hash}`);
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
        nativeToScVal(outcome, { type: "bool" }),
      );

      const tx = new TransactionBuilder(sourceAccount, { fee: "100000", networkPassphrase })
        .addOperation(operation)
        .setTimeout(300)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(resolverKeypair);

      const sendResponse = await server.sendTransaction(prepared);
      if (sendResponse.status === "ERROR") {
        throw new Error(`resolve_market rejected for market ${marketId}: ${sendResponse.status}`);
      }
      if (sendResponse.status === "TRY_AGAIN_LATER") {
        throw new Error(`resolve_market: network busy for market ${marketId}`);
      }

      const confirmation = await pollUntilTerminal(sendResponse.hash);
      if (confirmation.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`resolve_market failed on-chain for market ${marketId}: ${confirmation.status}`);
      }

      return sendResponse.hash;
    },
  };
}
