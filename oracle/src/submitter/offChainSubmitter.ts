import { Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";

export interface DataAdapter {
  name: string;
  fetchOutcome(marketId: string): Promise<{ outcome: boolean; confidence: number } | null>;
}

export interface OffChainSubmitterOptions {
  server: rpc.Server;
  contractId: string;
  networkPassphrase: string;
  submitterKeypair: Keypair;
  adapters: DataAdapter[];
  defaultBondStroops?: bigint;
  dryRun?: boolean;
}

export interface SubmittedOutcomeResult {
  marketId: string;
  outcome: boolean;
  bond: bigint;
  txHash: string;
  submittedAt: string;
  adapterName: string;
  dryRun?: boolean;
}

export interface OffChainSubmitterStore {
  isAlreadySubmitted(marketId: string): Promise<boolean>;
  recordSubmission(result: SubmittedOutcomeResult): Promise<void>;
}

export class OffChainSubmitterService {
  private readonly defaultBond: bigint;

  constructor(
    private readonly options: OffChainSubmitterOptions,
    private readonly store: OffChainSubmitterStore,
  ) {
    this.defaultBond = options.defaultBondStroops ?? 100_0000000n; // 100 XLM default
  }

  async processMarket(marketId: string): Promise<SubmittedOutcomeResult | null> {
    const trimmedId = marketId.trim();
    if (!trimmedId) throw new Error("marketId is required");

    // Prevent double-submit / double-payout path
    if (await this.store.isAlreadySubmitted(trimmedId)) {
      return null;
    }

    let result: { outcome: boolean; confidence: number } | null = null;
    let selectedAdapterName = "";

    for (const adapter of this.options.adapters) {
      try {
        const res = await adapter.fetchOutcome(trimmedId);
        if (res && res.confidence >= 0.8) {
          result = res;
          selectedAdapterName = adapter.name;
          break;
        }
      } catch (err) {
        console.warn(`Adapter ${adapter.name} failed for market ${trimmedId}:`, err);
      }
    }

    if (!result) {
      throw new Error(`No data adapter provided a confident outcome for market ${trimmedId}`);
    }

    const nowIso = new Date().toISOString();

    if (this.options.dryRun) {
      const dryResult: SubmittedOutcomeResult = {
        marketId: trimmedId,
        outcome: result.outcome,
        bond: this.defaultBond,
        txHash: `dry-run-submit-${trimmedId}-${Date.now()}`,
        submittedAt: nowIso,
        adapterName: selectedAdapterName,
        dryRun: true,
      };
      await this.store.recordSubmission(dryResult);
      return dryResult;
    }

    const txHash = await this.submitOutcomeOnChain(trimmedId, result.outcome, this.defaultBond);

    const submissionResult: SubmittedOutcomeResult = {
      marketId: trimmedId,
      outcome: result.outcome,
      bond: this.defaultBond,
      txHash,
      submittedAt: nowIso,
      adapterName: selectedAdapterName,
    };

    await this.store.recordSubmission(submissionResult);
    return submissionResult;
  }

  private async submitOutcomeOnChain(marketId: string, outcome: boolean, bond: bigint): Promise<string> {
    const { server, contractId, networkPassphrase, submitterKeypair } = this.options;
    const caller = submitterKeypair.publicKey();
    const sourceAccount = await server.getAccount(caller);
    const contract = new Contract(contractId);

    const operation = contract.call(
      "submit_outcome",
      new Address(caller).toScVal(),
      nativeToScVal(BigInt(marketId), { type: "u64" }),
      nativeToScVal(outcome, { type: "bool" }),
      nativeToScVal(bond, { type: "i128" }),
    );

    const tx = new TransactionBuilder(sourceAccount, { fee: "100000", networkPassphrase })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(submitterKeypair);

    const response = await server.sendTransaction(prepared);
    if (response.status === "ERROR" || response.status === "TRY_AGAIN_LATER") {
      throw new Error(`submit_outcome failed for market ${marketId}: ${response.status}`);
    }

    return response.hash;
  }
}
