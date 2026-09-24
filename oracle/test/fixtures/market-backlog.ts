import {
  Account,
  Keypair,
  StrKey,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import type { CouncilVote } from "../../src/aggregator/threshold.js";

/**
 * In-memory stand-in for everything the production aggregator talks to: the
 * `markets`, `council_votes` and `oracle_submissions` tables, and the Soroban
 * RPC node hosting the market contract (#468).
 *
 * It answers the real SQL and the real transactions `createProductionDependencies`
 * builds, so a backlog test drives the actual `processMarket` — the empty stub
 * that once shipped would leave every market here unresolved. Anything it does
 * not recognise throws, so a new query cannot silently return nothing.
 */

export interface ChainMarketState {
  resolved: boolean;
  cancelled: boolean;
  outcome: boolean;
}

/** Fails a market's RPC calls at one stage while `remaining` is above zero. */
export interface RpcFault {
  stage: "simulate" | "send";
  remaining: number;
  message: string;
}

export interface BacklogMarket {
  id: string;
  /** Scenario name, used in assertion messages. */
  scenario: string;
  /** Unix seconds. */
  endTime: number;
  /** Row in the `markets` table, as the indexer last wrote it. */
  db: { resolved: boolean; cancelled: boolean };
  chain: ChainMarketState;
  votes: CouncilVote[];
  fault?: RpcFault;
}

export interface FinalizedRow {
  marketId: string;
  decision: string;
  txHash: string;
  councilVotes: CouncilVote[];
  /** Correlation id of the aggregator attempt that wrote the row. */
  requestId: string | null;
}

export interface SentTransaction {
  marketId: string;
  outcome: boolean;
  hash: string;
}

export const COUNCIL = ["GCOUNCIL1", "GCOUNCIL2", "GCOUNCIL3", "GCOUNCIL4", "GCOUNCIL5", "GCOUNCIL6", "GCOUNCIL7"];

/** `count` council members voting `outcome`, starting at member `from`. */
export function votes(outcome: boolean, count: number, from = 0): CouncilVote[] {
  return COUNCIL.slice(from, from + count).map((member) => ({ member, outcome }));
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
}

export class BacklogWorld {
  readonly markets = new Map<string, BacklogMarket>();
  /** `oracle_submissions` rows, keyed by market id (the table is UNIQUE on it). */
  readonly finalized = new Map<string, FinalizedRow>();
  /** Rows the backend wrote for HTTP submissions: market id → its request id. */
  readonly backendSubmissions = new Map<string, string>();
  readonly transactions: SentTransaction[] = [];
  /** Market ids of resolve transactions the contract refused (market not open). */
  readonly rejected: string[] = [];
  readonly resolverSecret = Keypair.random().secret();
  readonly contractId = StrKey.encodeContract(Buffer.alloc(32, 7));

  constructor(markets: BacklogMarket[]) {
    for (const market of markets) this.markets.set(market.id, market);
  }

  market(id: string): BacklogMarket {
    const market = this.markets.get(id);
    if (!market) throw new Error(`BacklogWorld: unknown market ${id}`);
    return market;
  }

  addVotes(id: string, extra: CouncilVote[]): void {
    this.market(id).votes.push(...extra);
  }

  /** Markets the expiry query would return at `nowSeconds`, in its order. */
  eligibleAt(nowSeconds: number): BacklogMarket[] {
    return [...this.markets.values()]
      .filter((m) => m.endTime <= nowSeconds && !m.db.resolved && !m.db.cancelled)
      .sort((a, b) => a.endTime - b.endTime || Number(a.id) - Number(b.id));
  }

  pool(): Pool {
    const query = async (text: string, params: unknown[] = []) => this.query(normalizeSql(text), params);
    return { query, end: async () => undefined } as unknown as Pool;
  }

  server(): rpc.Server {
    return {
      getLatestLedger: async () => ({ id: "ledger", sequence: 1, protocolVersion: 22 }),
      getAccount: async (publicKey: string) => new Account(publicKey, "1"),
      simulateTransaction: async (tx: Transaction) => this.simulate(tx),
      prepareTransaction: async (tx: Transaction) => tx,
      sendTransaction: async (tx: Transaction) => this.send(tx),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
    } as unknown as rpc.Server;
  }

  private async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });

    if (sql === "SELECT 1") return result([{ "?column?": 1 }]);

    if (/^SELECT id::text, cancelled(, end_time)? FROM markets WHERE end_time <= \$1 AND resolved = FALSE AND cancelled = FALSE/.test(sql)) {
      let rows = this.eligibleAt(Number(params[0]));
      // Keyset cursor: rows strictly after (end_time, id) of the previous batch.
      if (sql.includes("(end_time, id) > ($3, $4)")) {
        const [afterEnd, afterId] = [Number(params[2]), Number(params[3])];
        rows = rows.filter((m) => m.endTime > afterEnd || (m.endTime === afterEnd && Number(m.id) > afterId));
      }
      if (sql.includes("OFFSET $3")) rows = rows.slice(Number(params[2]));
      if (sql.includes("LIMIT $2")) rows = rows.slice(0, Number(params[1]));
      return result(rows.map((m) => ({ id: m.id, cancelled: m.db.cancelled, end_time: String(m.endTime) })));
    }

    if (sql.startsWith("SELECT COUNT(*)::text AS count FROM markets")) {
      return result([{ count: String(this.eligibleAt(Number(params[0])).length) }]);
    }

    if (sql === "SELECT member, outcome FROM council_votes WHERE market_id = $1") {
      return result(this.market(String(params[0])).votes.map((v) => ({ ...v })));
    }

    if (sql === "SELECT 1 FROM oracle_submissions WHERE market_id = $1") {
      return result(this.hasSubmissionRow(String(params[0])) ? [{ "?column?": 1 }] : []);
    }

    if (sql === "SELECT request_id FROM oracle_submissions WHERE market_id = $1 AND request_id IS NOT NULL") {
      const id = String(params[0]);
      const requestId = this.backendSubmissions.get(id) ?? this.finalized.get(id)?.requestId ?? null;
      return result(requestId ? [{ request_id: requestId }] : []);
    }

    if (sql.startsWith("INSERT INTO oracle_submissions")) {
      const marketId = String(params[0]);
      if (this.hasSubmissionRow(marketId)) throw uniqueViolation();
      // ck_oracle_submissions_outcome_canonical (migration 0017).
      if (params[2] !== "YES" && params[2] !== "NO") {
        throw new Error(`new row violates check constraint "ck_oracle_submissions_outcome_canonical": ${String(params[2])}`);
      }
      this.finalized.set(marketId, {
        marketId,
        decision: String(params[6]),
        txHash: String(params[7]),
        councilVotes: JSON.parse(String(params[9])) as CouncilVote[],
        requestId: (params[10] as string | null | undefined) ?? null,
      });
      return result([]);
    }

    throw new Error(`BacklogWorld: unhandled SQL: ${sql}`);
  }

  /** oracle_submissions is UNIQUE on market_id: one row, whoever wrote it. */
  private hasSubmissionRow(marketId: string): boolean {
    return this.finalized.has(marketId) || this.backendSubmissions.has(marketId);
  }

  private invocation(tx: Transaction): { fn: string; args: unknown[] } {
    const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
    const call = op.func.invokeContract();
    return { fn: call.functionName().toString(), args: call.args().map((arg) => scValToNative(arg)) };
  }

  /** Throws while a fault for this stage has attempts left. */
  private applyFault(market: BacklogMarket, stage: RpcFault["stage"]): void {
    const fault = market.fault;
    if (!fault || fault.stage !== stage || fault.remaining <= 0) return;
    fault.remaining -= 1;
    throw new Error(fault.message);
  }

  private async simulate(tx: Transaction) {
    const { fn, args } = this.invocation(tx);
    if (fn !== "get_market") throw new Error(`BacklogWorld: unexpected simulation of ${fn}`);
    const market = this.market(String(args[0]));
    this.applyFault(market, "simulate");
    // What a real node returns: the contract's Market struct as an ScVal map.
    const retval = nativeToScVal(
      {
        id: BigInt(market.id),
        end_time: BigInt(market.endTime),
        resolved: market.chain.resolved,
        outcome: market.chain.outcome,
        cancelled: market.chain.cancelled,
      },
      { type: { id: ["symbol", "u64"], end_time: ["symbol", "u64"] } },
    );
    return { id: "sim", latestLedger: 1, events: [], _parsed: true, result: { auth: [], retval } };
  }

  private async send(tx: Transaction) {
    const { fn, args } = this.invocation(tx);
    if (fn !== "resolve_market") throw new Error(`BacklogWorld: unexpected transaction ${fn}`);
    const [, rawId, outcome] = args as [string, bigint, boolean];
    const market = this.market(String(rawId));
    this.applyFault(market, "send");

    if (market.chain.resolved || market.chain.cancelled) {
      this.rejected.push(market.id);
      return { status: "ERROR", errorResult: `market ${market.id} is not open` };
    }

    const hash = tx.hash().toString("hex");
    market.chain = { ...market.chain, resolved: true, outcome };
    // The markets row flips to resolved while the aggregator is still working
    // through the rest of its backlog — the worst case for paging. (In
    // production the indexer only does this for oracle/finalized events;
    // resolve_market emits none. See STUCK_MARKET_RUNBOOK.md, cause C8.)
    market.db.resolved = true;
    this.transactions.push({ marketId: market.id, outcome, hash });
    return { status: "PENDING", hash };
  }
}
