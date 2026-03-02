import {
  rpc,
  Horizon,
  TransactionBuilder,
  Contract,
  Networks,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";
import { NETWORK } from "@/config/network";
import { AppErrorType } from "@/types";
import type { AppError, TransactionResult } from "@/types";

// ── Server singletons ─────────────────────────────────────────────────────────

let _sorobanServer: rpc.Server | null = null;
let _horizonServer: Horizon.Server | null = null;

/**
 * Get a rpc.Server instance for the configured network.
 */
export function getSorobanServer(): rpc.Server {
  if (!_sorobanServer) {
    _sorobanServer = new rpc.Server(NETWORK.sorobanUrl, {
      allowHttp: NETWORK.sorobanUrl.startsWith("http://"),
    });
  }
  return _sorobanServer;
}

/**
 * Get a Horizon.Server instance for the configured network.
 */
export function getHorizonServer(): Horizon.Server {
  if (!_horizonServer) {
    _horizonServer = new Horizon.Server(NETWORK.url);
  }
  return _horizonServer;
}

/**
 * Fetch native XLM balance for an account via Horizon.
 * Returns balance in XLM (human-readable units, e.g. 100.5).
 */
export async function getXlmBalance(publicKey: string): Promise<number> {
  try {
    const server = getHorizonServer();
    const account = await server.loadAccount(publicKey);
    const nativeBalance = account.balances.find(
      (b: { asset_type: string }) => b.asset_type === "native"
    );
    return nativeBalance ? parseFloat((nativeBalance as { balance: string }).balance) : 0;
  } catch {
    return 0;
  }
}

// ── Network passphrase helper ─────────────────────────────────────────────────

function getNetworkPassphrase(): string {
  if (NETWORK.passphrase === Networks.TESTNET) return Networks.TESTNET;
  if (NETWORK.passphrase === Networks.PUBLIC) return Networks.PUBLIC;
  return NETWORK.passphrase;
}

// ── Transaction polling ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30; // 60 seconds total

/**
 * Poll the Soroban RPC getTransaction endpoint until the tx is confirmed
 * (success or failure) or we time out.
 */
async function pollTransaction(
  server: rpc.Server,
  hash: string
): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const response = await server.getTransaction(hash);

    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return response;
    }
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      return response;
    }

    // NOT_FOUND — still pending, wait and retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw createAppError(
    AppErrorType.TIMEOUT,
    "Transaction confirmation timed out",
    `Hash: ${hash} — polled ${MAX_POLL_ATTEMPTS} times`
  );
}

// ── Core: buildAndSendTx ──────────────────────────────────────────────────────

/**
 * Build, simulate, sign, and submit a Soroban contract call transaction.
 *
 * @param publicKey — Caller's Stellar public key
 * @param contractId — Deployed contract address (C...)
 * @param method — Contract function name
 * @param args — Array of xdr.ScVal arguments
 * @param signTransaction — Wallet sign function (XDR in → signed XDR out)
 * @returns TransactionResult with success status and hash or error
 */
export async function buildAndSendTx(
  publicKey: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  signTransaction: (xdr: string) => Promise<string>
): Promise<TransactionResult> {
  const server = getSorobanServer();

  try {
    // 1. Load the source account (for sequence number)
    const sourceAccount = await server.getAccount(publicKey);

    // 2. Build the contract call operation
    const contract = new Contract(contractId);
    const operation = contract.call(method, ...args);

    // 3. Build the transaction
    const tx = new TransactionBuilder(sourceAccount, {
      fee: "10000000", // 1 XLM max fee — adjusted by simulation
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(operation)
      .setTimeout(300) // 5 minutes for wallet review
      .build();

    // 4. Simulate to get resource estimates and auth
    let prepared;
    try {
      prepared = await server.prepareTransaction(tx);
    } catch (simErr) {
      console.error("[iPredict] Simulation/prepare failed:", simErr);
      const simMsg = simErr instanceof Error ? simErr.message : String(simErr);
      return {
        success: false,
        error: `Simulation failed: ${simMsg}`,
      };
    }

    // 5. Sign the prepared transaction
    const txXdr = prepared.toXDR();
    let signedXdr: string;
    try {
      signedXdr = await signTransaction(txXdr);
    } catch (signErr) {
      console.error("[iPredict] Wallet signing failed:", signErr);
      const signMsg = signErr instanceof Error ? signErr.message : extractErrorMessage(signErr);
      return {
        success: false,
        error: `Signing failed: ${signMsg}`,
      };
    }

    // 6. Reconstruct signed transaction and submit
    const signedTx = TransactionBuilder.fromXDR(
      signedXdr,
      getNetworkPassphrase()
    );
    const sendResponse = await server.sendTransaction(signedTx);

    // 7. Check immediate send status
    if (sendResponse.status === "ERROR") {
      console.error("[iPredict] sendTransaction ERROR:", JSON.stringify(sendResponse, null, 2));
      const errorDetail = extractSendError(sendResponse);
      return {
        success: false,
        error: `Transaction rejected: ${errorDetail}`,
      };
    }

    if (sendResponse.status === "TRY_AGAIN_LATER") {
      return {
        success: false,
        error: "Network busy — please try again in a few seconds",
      };
    }

    // 8. Poll for confirmation
    const txResponse = await pollTransaction(server, sendResponse.hash);

    if (
      txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS
    ) {
      return { success: true, hash: sendResponse.hash };
    }

    // Transaction failed on-chain — extract reason
    console.error("[iPredict] Transaction failed on-chain:", JSON.stringify(txResponse, null, 2));
    const onChainError = extractOnChainError(txResponse);
    return {
      success: false,
      hash: sendResponse.hash,
      error: `Transaction failed: ${onChainError}`,
    };
  } catch (err) {
    console.error("[iPredict] buildAndSendTx unexpected error:", err);
    throw classifyError(err);
  }
}

// ── Read-only simulation ──────────────────────────────────────────────────────

/**
 * Simulate a read-only contract call and return the parsed native result.
 * Does NOT submit the transaction — used for view functions (getMarket, etc.).
 *
 * @param publicKey — Any valid Stellar public key (used as tx source for sim)
 * @param contractId — Deployed contract address
 * @param method — Contract function name
 * @param args — Array of xdr.ScVal arguments
 * @returns Parsed native JS value from the contract return
 */
export async function simulateTransaction<T = unknown>(
  publicKey: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<T> {
  const server = getSorobanServer();

  try {
    const sourceAccount = await server.getAccount(publicKey);
    const contract = new Contract(contractId);
    const operation = contract.call(method, ...args);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResponse = await server.simulateTransaction(tx);

    // Check for simulation error
    if (rpc.Api.isSimulationError(simResponse)) {
      throw createAppError(
        AppErrorType.SIMULATION,
        "Simulation failed",
        simResponse.error
      );
    }

    // Extract return value from successful simulation
    if (
      rpc.Api.isSimulationSuccess(simResponse) &&
      simResponse.result
    ) {
      return scValToNative(simResponse.result.retval) as T;
    }

    throw createAppError(
      AppErrorType.SIMULATION,
      "Simulation returned no result"
    );
  } catch (err) {
    if (isAppError(err)) throw err;
    throw classifyError(err);
  }
}

// ── Error classification ──────────────────────────────────────────────────────

/**
 * Extract a useful error message from various error types.
 */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    // AppError shape
    if ("message" in err && typeof (err as { message: unknown }).message === "string") {
      const msg = (err as { message: string }).message;
      const details = "details" in err ? (err as { details: string }).details : "";
      return details ? `${msg}: ${details}` : msg;
    }
    // Try JSON stringification for unknown objects
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Extract error info from a sendTransaction ERROR response.
 */
function extractSendError(response: rpc.Api.SendTransactionResponse): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = response as any;
    if (resp.errorResult) {
      return `Error result: ${JSON.stringify(resp.errorResult)}`;
    }
    if (resp.errorResultXdr) {
      return `Error XDR: ${resp.errorResultXdr}`;
    }
    if (resp.diagnosticEventsXdr && resp.diagnosticEventsXdr.length > 0) {
      return `Diagnostic events: ${resp.diagnosticEventsXdr.length} event(s)`;
    }
  } catch {
    // ignore parse errors
  }
  return response.status;
}

/**
 * Extract error details from a failed on-chain transaction response.
 */
function extractOnChainError(response: rpc.Api.GetTransactionResponse): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = response as any;
    if (resp.resultXdr) {
      const result = resp.resultXdr;
      if (typeof result === "object" && result.result) {
        return `On-chain error: ${JSON.stringify(result.result())}`;
      }
      return `Result XDR present — check Stellar explorer for details`;
    }
  } catch {
    // ignore parse errors
  }
  return "Unknown on-chain error — check Stellar explorer for details";
}

function classifyError(err: unknown): AppError {
  const message = extractErrorMessage(err);
  const lower = message.toLowerCase();

  // Network errors
  if (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("timeout") ||
    lower.includes("aborted")
  ) {
    return createAppError(
      AppErrorType.NETWORK,
      "Network request failed — check your connection",
      message
    );
  }

  // Wallet / signing errors
  if (
    lower.includes("rejected") ||
    lower.includes("denied") ||
    lower.includes("cancelled") ||
    lower.includes("wallet") ||
    lower.includes("sign")
  ) {
    return createAppError(
      AppErrorType.WALLET,
      "Wallet operation cancelled",
      message
    );
  }

  // Simulation errors
  if (
    lower.includes("simulation") ||
    lower.includes("host invocation failed") ||
    lower.includes("contract execution") ||
    lower.includes("restore")
  ) {
    return createAppError(
      AppErrorType.SIMULATION,
      "Contract simulation failed — the contract may have rejected this action",
      message
    );
  }

  // Contract errors (on-chain failures)
  if (
    lower.includes("contract") ||
    lower.includes("invoke") ||
    lower.includes("wasm")
  ) {
    return createAppError(
      AppErrorType.CONTRACT,
      "Contract call failed",
      message
    );
  }

  // Default: show the actual error instead of a generic message
  return createAppError(AppErrorType.NETWORK, message || "Transaction failed", message);
}

function createAppError(
  type: AppErrorType,
  message: string,
  details?: string
): AppError {
  return { type, message, details };
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "message" in err
  );
}
