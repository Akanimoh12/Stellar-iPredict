import {
  Account,
  BASE_FEE,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { MarketTotals } from "./recomputeTotals.js";

/** Public, all-zero Strkey used only as a fee-source for read-only simulation. */
const READ_ONLY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Read a market's authoritative pool totals via a read-only Soroban
 * `get_market(u64)` simulation. No transaction is signed or submitted.
 */
export function createOnChainTotalsReader(options: {
  rpcUrl: string;
  networkPassphrase: string;
  marketContractId: string;
  simulationSource?: string;
}): (marketId: string) => Promise<MarketTotals> {
  const server = new rpc.Server(options.rpcUrl);
  const contract = new Contract(options.marketContractId);
  const source = options.simulationSource ?? READ_ONLY_SOURCE;

  return async (marketId: string): Promise<MarketTotals> => {
    const tx = new TransactionBuilder(new Account(source, "0"), {
      fee: BASE_FEE,
      networkPassphrase: options.networkPassphrase,
    })
      .addOperation(contract.call("get_market", nativeToScVal(BigInt(marketId), { type: "u64" })))
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(tx);
    if (!("result" in simulation) || !simulation.result?.retval) {
      throw new Error(`get_market(${marketId}) simulation failed: ${JSON.stringify(simulation)}`);
    }
    const native: unknown = scValToNative(simulation.result.retval);
    const record: Record<string, unknown> = native instanceof Map
      ? Object.fromEntries(native)
      : native !== null && typeof native === "object"
        ? native as Record<string, unknown>
        : {};
    if (record.total_yes === undefined || record.total_no === undefined) {
      throw new Error(`get_market(${marketId}) returned no market totals`);
    }
    const total_yes = record.total_yes;
    const total_no = record.total_no;
    if (
      !["bigint", "string", "number"].includes(typeof total_yes) ||
      !["bigint", "string", "number"].includes(typeof total_no)
    ) {
      throw new Error(`get_market(${marketId}) returned invalid market totals`);
    }
    return { total_yes: total_yes as bigint | string | number, total_no: total_no as bigint | string | number };
  };
}
