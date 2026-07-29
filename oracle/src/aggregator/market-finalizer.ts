import {
  Address,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import type { CouncilVote } from "./threshold.js";

export class MarketAlreadyFinalizedError extends Error {
  constructor(marketId: string) {
    super(`Market ${marketId} already finalized`);
    this.name = "MarketAlreadyFinalizedError";
  }
}

function boolVal(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: "bool" });
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

export async function persistFinalDecision(
  db: Pool,
  marketId: number,
  decision: boolean,
  txHash: string,
  councilVotes: CouncilVote[],
  submitter: string,
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
        council_votes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        marketId,
        submitter,
        decisionLabel(decision),
        0,
        now,
        "finalized",
        decisionLabel(decision),
        txHash,
        now,
        JSON.stringify(councilVotes),
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
): Promise<string> {
  const txHash = await submitResolutionTransaction(
    server,
    contractId,
    resolverSecret,
    marketId,
    decision,
    networkPassphrase,
  );
  await persistFinalDecision(
    db,
    marketId,
    decision,
    txHash,
    councilVotes,
    Keypair.fromSecret(resolverSecret).publicKey(),
  );
  console.info(
    `Persisted finalized decision for market ${marketId} with tx_hash=${txHash} and decision=${decisionLabel(decision)}`,
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

  const market = response.result.retval ? (response.result.retval as any) : undefined;
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
