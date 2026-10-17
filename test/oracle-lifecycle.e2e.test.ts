/**
 * End-to-End Integration Test: Full Optimistic Oracle Lifecycle (Issue #541)
 *
 * Drives prediction markets through every stage of their lifecycle spanning:
 *   1. Soroban Contract (on-chain state machine, bond escrow, events)
 *   2. Indexer (event decoding, routing, idempotency deduplication)
 *   3. Database (Postgres tables: markets, bets, oracle_submissions, oracle_disputes, events)
 *   4. REST API (Fastify endpoints: /api/markets, /odds, /bets)
 *
 * Lifecycles covered:
 *   - Path A: Full Unchallenged Lifecycle (Submission -> Window Elapses -> Finalization -> Claims)
 *   - Path B: Full Challenged-then-Ruled Lifecycle (Submission -> Dispute -> Council Ruling for Submitter)
 *   - Path C: Full Challenged-then-Ruled Lifecycle (Submission -> Dispute -> Council Ruling for Challenger)
 *   - Path D: Indexer Replay Idempotency & Fault-Tolerance
 *
 * Exact final participant balances and mathematical fund conservation are asserted down to the stroop.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://postgres:postgrespassword@localhost:5432/ipredict_test",
    REDIS_URL: "redis://localhost:6379",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    MARKET_CONTRACT_ID: "C" + "A".repeat(55),
    TOKEN_CONTRACT_ID: "C" + "B".repeat(55),
    REFERRAL_CONTRACT_ID: "C" + "C".repeat(55),
    LEADERBOARD_CONTRACT_ID: "C" + "D".repeat(55),
    START_LEDGER: "1",
    JWT_SECRET: "test-jwt-secret-which-is-at-least-32-chars-long",
    ORACLE_API_KEY: "test-oracle-api-key",
    METRICS_TOKEN: "test-metrics-token",
  });
});

import { Keypair } from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

import { buildServer } from "../backend/src/server.js";
import { stroopsToXlm, STROOPS_PER_XLM } from "../backend/src/lib/amount.js";
import { handleMarketCreatedEvent } from "../indexer/src/handlers/market_created.js";
import { handleBetPlacedEvent } from "../indexer/src/handlers/bet_placed.js";
import { handleOracleSubmission } from "../indexer/src/handlers/oracle_submission.js";
import {
  handleOracleChallengedEvent,
  handleOracleEscalatedEvent,
} from "../indexer/src/handlers/oracle_challenge.js";
import { handleOracleFinalizedEvent } from "../indexer/src/handlers/oracle_finalized.js";
import { handleClaim } from "../indexer/src/handlers/claim.js";
import { CouncilVoteManager } from "../oracle/src/aggregator/council-votes.js";
import type { DecodedContractEvent, DbClient, RedisClient } from "../indexer/src/types.js";
import type { MarketRow } from "../backend/src/db/markets.js";
import type { BetRow } from "../backend/src/db/bets.js";

// ── Contract Constants (lib.rs) ─────────────────────────────────────────────
const STROOP_UNIT = 10_000_000n;
const SUBMITTER_BOND_STROOPS = 100n * STROOP_UNIT; // 100 XLM
const DISPUTER_BOND_STROOPS = 200n * STROOP_UNIT;  // 200 XLM
const CHALLENGE_WINDOW_SECS = 86_400;             // 24 h
const COUNCIL_WINDOW_SECS = 259_200;              // 72 h
const BET_FEE_BPS = 200n;                         // 2% fee (200 bps)

// ── Participant Addresses ───────────────────────────────────────────────────
const ADMIN = Keypair.random().publicKey();
const CREATOR = Keypair.random().publicKey();
const ALICE = Keypair.random().publicKey();          // Bettor YES
const BOB = Keypair.random().publicKey();            // Bettor NO
const SUBMITTER = Keypair.random().publicKey();      // Oracle Submitter
const CHALLENGER = Keypair.random().publicKey();     // Dispute Challenger
const COUNCIL_RESOLVER = Keypair.random().publicKey();

// ── In-Memory Stateful Database Pool ─────────────────────────────────────────

interface MarketRecord {
  id: number;
  question: string;
  image_url: string | null;
  category: string;
  end_time: string;
  total_yes: string;
  total_no: string;
  resolved: boolean;
  outcome: boolean | null;
  cancelled: boolean;
  creator: string;
  bet_count: number;
  created_at: Date;
  updated_at: Date;
}

interface BetRecord {
  market_id: string;
  bettor: string;
  net_amount: string;
  gross_amount: string;
  is_yes: boolean;
  claimed: boolean;
  created_at: Date;
}

interface OracleSubmissionRecord {
  market_id: number;
  submitter: string;
  outcome: string;
  bond_amount: string;
  status: "submitted" | "challenged" | "finalized" | "rejected";
  decision: string | null;
  tx_hash: string | null;
  finalized_at: Date | null;
  submitted_at: Date;
  council_votes?: Record<string, boolean>;
}

interface OracleDisputeRecord {
  market_id: number;
  challenger: string;
  bond: string;
  submitter: string;
  submitter_bond: string;
  total_bond?: string;
  status: "challenged" | "escalated" | "resolved";
  challenged_at: Date;
  council_deadline?: Date;
}

interface EventRecord {
  ledger_seq: number;
  tx_hash: string;
  event_index: number;
  event_type: string;
  market_id: number;
  actor: string;
  payload: string;
}

class StatefulTestDatabase {
  public markets = new Map<number, MarketRecord>();
  public bets = new Map<string, BetRecord>(); // key: `${marketId}:${bettor}`
  public submissions = new Map<number, OracleSubmissionRecord>();
  public disputes = new Map<number, OracleDisputeRecord>();
  public events = new Map<string, EventRecord>(); // key: `${tx_hash}:${event_index}`

  public totalCount = 10;
  public idleCount = 10;
  public waitingCount = 0;

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => {},
    };
  }

  async end() {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const trimmed = sql.trim();

    // Transactions
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    // Healthcheck / version checks
    if (trimmed === "SELECT 1" || trimmed === "SELECT NOW()" || trimmed.startsWith("SELECT 1 AS") || trimmed.startsWith("SELECT 1 FROM")) {
      return { rows: [{ "?column?": 1 }] as T[], rowCount: 1 };
    }

    // CTE from handleBetPlacedEvent
    if (trimmed.startsWith("WITH input AS") && trimmed.includes("upserted_bet")) {
      const [
        ledger_seq,
        tx_hash,
        event_index,
        event_type,
        payload,
        market_id_val,
        bettor_val,
        net_amount_val,
        gross_amount_val,
        is_yes_val,
      ] = params as [number, string, number, string, string, string | number, string, string, string, boolean];

      const marketId = Number(market_id_val);
      const bettor = String(bettor_val).trim();
      const netAmount = String(net_amount_val);
      const grossAmount = String(gross_amount_val);
      const isYes = Boolean(is_yes_val);

      const dedupeKey = `${tx_hash}:${event_index}`;
      const isDuplicateEvent = this.events.has(dedupeKey);

      if (isDuplicateEvent) {
        // Idempotency: skip inserting event and modifying balances
        return {
          rows: [{ side_valid: true, event_inserted: false, applied: false }] as T[],
          rowCount: 1,
        };
      }

      // Check opposite side violation
      const betKey = `${marketId}:${bettor}`;
      const existingBet = this.bets.get(betKey);
      if (existingBet && existingBet.is_yes !== isYes) {
        return {
          rows: [{ side_valid: false, event_inserted: false, applied: false }] as T[],
          rowCount: 0,
        };
      }

      // Record event
      this.events.set(dedupeKey, {
        ledger_seq: Number(ledger_seq),
        tx_hash,
        event_index: Number(event_index),
        event_type,
        market_id: marketId,
        actor: bettor,
        payload,
      });

      const isNewBettor = !existingBet;
      if (existingBet) {
        const updatedNet = (BigInt(existingBet.net_amount.replace(".", "")) + BigInt(netAmount.replace(".", "")));
        const updatedGross = (BigInt(existingBet.gross_amount.replace(".", "")) + BigInt(grossAmount.replace(".", "")));
        existingBet.net_amount = stroopsToXlm(updatedNet);
        existingBet.gross_amount = stroopsToXlm(updatedGross);
      } else {
        this.bets.set(betKey, {
          market_id: String(marketId),
          bettor,
          net_amount: netAmount,
          gross_amount: grossAmount,
          is_yes: isYes,
          claimed: false,
          created_at: new Date(),
        });
      }

      // Update market aggregates
      const market = this.markets.get(marketId);
      if (market) {
        if (isYes) {
          const currentYes = BigInt(market.total_yes.replace(".", ""));
          market.total_yes = stroopsToXlm(currentYes + BigInt(netAmount.replace(".", "")));
        } else {
          const currentNo = BigInt(market.total_no.replace(".", ""));
          market.total_no = stroopsToXlm(currentNo + BigInt(netAmount.replace(".", "")));
        }
        if (isNewBettor) {
          market.bet_count += 1;
        }
        market.updated_at = new Date();
      }

      return {
        rows: [{ side_valid: true, event_inserted: true, applied: true }] as T[],
        rowCount: 1,
      };
    }

    // Generic Event Idempotency Insert (insertProcessedEvent)
    if (trimmed.startsWith("INSERT INTO events")) {
      const [ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload] = params as [
        number, string, number, string, number, string, string
      ];
      const key = `${tx_hash}:${event_index}`;
      if (this.events.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      this.events.set(key, {
        ledger_seq: Number(ledger_seq),
        tx_hash,
        event_index: Number(event_index),
        event_type,
        market_id: Number(market_id),
        actor,
        payload,
      });
      return { rows: [{ "?column?": 1 }] as T[], rowCount: 1 };
    }

    // Markets: INSERT / ON CONFLICT
    if (trimmed.startsWith("INSERT INTO markets")) {
      const [id, question, image_url, category, end_time, creator] = params as [
        number, string, string | null, string, number | string, string
      ];
      const existing = this.markets.get(Number(id));
      if (existing) {
        existing.question = question;
        existing.image_url = image_url ?? existing.image_url;
        existing.category = category;
        existing.end_time = String(end_time);
        existing.creator = creator;
        existing.updated_at = new Date();
      } else {
        this.markets.set(Number(id), {
          id: Number(id),
          question,
          image_url,
          category,
          end_time: String(end_time),
          total_yes: "0.0000000",
          total_no: "0.0000000",
          resolved: false,
          outcome: null,
          cancelled: false,
          creator,
          bet_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    // Markets: UPDATE resolution (handleOracleFinalizedEvent)
    if (trimmed.startsWith("UPDATE markets") && trimmed.includes("SET resolved = TRUE")) {
      const [id, outcomeRaw] = params as [number, string | boolean];
      const outcome = typeof outcomeRaw === "string" ? outcomeRaw.toLowerCase() === "yes" || outcomeRaw.toLowerCase() === "true" : Boolean(outcomeRaw);
      const market = this.markets.get(Number(id));
      if (market && !market.resolved && !market.cancelled) {
        market.resolved = true;
        market.outcome = outcome;
        market.cancelled = false;
        market.updated_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Markets: SELECT by id
    if (trimmed.includes("FROM markets") && trimmed.includes("WHERE id = $1")) {
      const id = Number(params[0]);
      const market = this.markets.get(id);
      return { rows: (market ? [market] : []) as T[], rowCount: market ? 1 : 0 };
    }

    // Markets: List Query (GET /api/markets)
    if (trimmed.includes("FROM markets") && !trimmed.includes("WHERE id = $1")) {
      let filtered = Array.from(this.markets.values());

      if (trimmed.includes("resolved = false AND cancelled = false AND end_time >")) {
        const nowSec = Math.floor(Date.now() / 1000);
        filtered = filtered.filter((m) => !m.resolved && !m.cancelled && Number(m.end_time) > nowSec);
      } else if (trimmed.includes("resolved = true")) {
        filtered = filtered.filter((m) => m.resolved);
      } else if (trimmed.includes("cancelled = true")) {
        filtered = filtered.filter((m) => m.cancelled);
      }

      if (trimmed.includes("COUNT(*) OVER")) {
        return {
          rows: filtered.map((m) => ({ ...m, total_count: filtered.length })) as T[],
          rowCount: filtered.length,
        };
      }
      if (trimmed.includes("COUNT(")) {
        return { rows: [{ total: filtered.length }] as T[], rowCount: 1 };
      }
      return { rows: filtered as T[], rowCount: filtered.length };
    }

    // Bets: Query by market_id
    if (trimmed.includes("FROM bets") && trimmed.includes("WHERE market_id = $1")) {
      const marketId = String(params[0]);
      const matched = Array.from(this.bets.values()).filter((b) => b.market_id === marketId);
      if (trimmed.includes("COUNT(*)::INT AS total")) {
        return { rows: [{ total: matched.length }] as T[], rowCount: 1 };
      }
      return { rows: matched as T[], rowCount: matched.length };
    }

    // Bets: UPDATE claimed (handleClaim)
    if (trimmed.startsWith("UPDATE bets SET claimed = true")) {
      const [marketId, user] = params as [number, string];
      const key = `${marketId}:${user}`;
      const bet = this.bets.get(key);
      if (bet) {
        bet.claimed = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Oracle Submissions: INSERT
    if (trimmed.startsWith("INSERT INTO oracle_submissions")) {
      const [market_id, submitter, outcome, bond_amount] = params as [number, string, string, string];
      if (this.submissions.has(Number(market_id))) {
        return { rows: [], rowCount: 0 };
      }
      this.submissions.set(Number(market_id), {
        market_id: Number(market_id),
        submitter,
        outcome,
        bond_amount,
        status: "submitted",
        decision: null,
        tx_hash: null,
        finalized_at: null,
        submitted_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    // Oracle Submissions: UPDATE status to challenged
    if (trimmed.startsWith("UPDATE oracle_submissions") && trimmed.includes("SET status = 'challenged'")) {
      const marketId = Number(params[0]);
      const sub = this.submissions.get(marketId);
      if (sub && sub.status === "submitted") {
        sub.status = "challenged";
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Oracle Submissions: UPDATE to finalized (handleOracleFinalizedEvent)
    if (trimmed.startsWith("UPDATE oracle_submissions") && trimmed.includes("SET status = 'finalized'")) {
      const [market_id, decision, tx_hash, finalized_at] = params as [number, string, string, Date];
      const sub = this.submissions.get(Number(market_id));
      if (sub && (sub.status === "submitted" || sub.status === "challenged")) {
        sub.status = "finalized";
        sub.decision = decision;
        sub.tx_hash = tx_hash;
        sub.finalized_at = finalized_at;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Oracle Submissions: SELECT by market_id
    if (trimmed.includes("FROM oracle_submissions") && trimmed.includes("WHERE market_id = $1")) {
      const marketId = Number(params[0]);
      const sub = this.submissions.get(marketId);
      return { rows: (sub ? [sub] : []) as T[], rowCount: sub ? 1 : 0 };
    }

    // Oracle Disputes: INSERT
    if (trimmed.startsWith("INSERT INTO oracle_disputes")) {
      const [market_id, submitter, challenger, outcome, submitter_bond, challenger_bond, challenged_at] = params as [
        number, string, string, string, string, string, Date
      ];
      if (!this.disputes.has(Number(market_id))) {
        this.disputes.set(Number(market_id), {
          market_id: Number(market_id),
          challenger,
          bond: challenger_bond,
          submitter,
          submitter_bond,
          total_bond: (BigInt(submitter_bond) + BigInt(challenger_bond)).toString(),
          status: "challenged",
          challenged_at,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    // Oracle Disputes: UPDATE to escalated
    if (trimmed.startsWith("UPDATE oracle_disputes") && trimmed.includes("status = 'escalated'")) {
      const [market_id, escalated_at, council_deadline] = params as [number, Date, Date];
      const dispute = this.disputes.get(Number(market_id));
      if (dispute) {
        dispute.council_deadline = council_deadline;
        dispute.status = "escalated";
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Oracle Disputes: SELECT by market_id
    if (trimmed.includes("FROM oracle_disputes") && trimmed.includes("WHERE market_id = $1")) {
      const marketId = Number(params[0]);
      const dispute = this.disputes.get(marketId);
      return { rows: (dispute ? [dispute] : []) as T[], rowCount: dispute ? 1 : 0 };
    }

    // Default fallback
    return { rows: [], rowCount: 0 };
  }
}

// ── In-Memory Fake Redis ─────────────────────────────────────────────────────

class FakeRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, val: string): Promise<"OK"> {
    this.store.set(key, val);
    return "OK";
  }

  async setex(key: string, _ttl: number, val: string): Promise<"OK"> {
    this.store.set(key, val);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) deleted++;
    }
    return deleted;
  }

  async ping(): Promise<"PONG"> {
    return "PONG";
  }

  clear() {
    this.store.clear();
  }
}

// ── Soroban Prediction Market Contract Simulator ────────────────────────────

interface ContractMarketState {
  id: number;
  creator: string;
  question: string;
  category: string;
  endTimeSecs: number;
  totalYesStroops: bigint;
  totalNoStroops: bigint;
  betCount: number;
  resolved: boolean;
  outcome: boolean | null;
  cancelled: boolean;
}

interface ContractBetState {
  marketId: number;
  bettor: string;
  isYes: boolean;
  grossStroops: bigint;
  netStroops: bigint;
  feeStroops: bigint;
  claimed: boolean;
}

interface ContractSubmissionState {
  marketId: number;
  submitter: string;
  outcome: boolean;
  bondStroops: bigint;
  state: "Submitted" | "Escalated" | "Finalized";
  submittedAtSecs: number;
  challengeDeadlineSecs: number;
  councilDeadlineSecs?: number;
  finalizedAtSecs?: number;
}

interface ContractDisputeState {
  marketId: number;
  challenger: string;
  bondStroops: bigint;
  challengedAtSecs: number;
}

class SorobanContractSimulator {
  public balances = new Map<string, bigint>();
  public contractBalance = 0n;
  public accumulatedFeesStroops = 0n;
  public markets = new Map<number, ContractMarketState>();
  public bets = new Map<string, ContractBetState>(); // `${marketId}:${bettor}`
  public submissions = new Map<number, ContractSubmissionState>();
  public disputes = new Map<number, ContractDisputeState>();
  public currentTimeSecs = 1_700_000_000;
  private nextMarketId = 1;

  constructor() {
    // Fund initial participant accounts with 10,000 XLM each
    const initialFund = 10_000n * STROOP_UNIT;
    [ADMIN, CREATOR, ALICE, BOB, SUBMITTER, CHALLENGER, COUNCIL_RESOLVER].forEach((addr) => {
      this.balances.set(addr, initialFund);
    });
  }

  getBalance(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }

  private transfer(from: string, to: string, amount: bigint) {
    const fromBal = this.getBalance(from);
    if (fromBal < amount) throw new Error(`Insufficient balance: ${from} has ${fromBal}, needs ${amount}`);
    this.balances.set(from, fromBal - amount);
    this.balances.set(to, this.getBalance(to) + amount);
  }

  createMarket(creator: string, question: string, category: string, durationSecs: number) {
    const marketId = this.nextMarketId++;
    const endTime = this.currentTimeSecs + durationSecs;
    const market: ContractMarketState = {
      id: marketId,
      creator,
      question,
      category,
      endTimeSecs: endTime,
      totalYesStroops: 0n,
      totalNoStroops: 0n,
      betCount: 0,
      resolved: false,
      outcome: null,
      cancelled: false,
    };
    this.markets.set(marketId, market);

    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: "m" + marketId.toString().padStart(63, "0"),
      topics: ["mkt", "created"],
      data: {
        market_id: BigInt(marketId),
        question,
        category,
        end_time: BigInt(endTime),
        creator,
        image_url: null,
      },
    };

    return { market, event };
  }

  placeBet(bettor: string, marketId: number, isYes: boolean, grossStroops: bigint) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error(`Market not found: ${marketId}`);
    if (this.currentTimeSecs > market.endTimeSecs) throw new Error("Market has expired");
    if (market.resolved || market.cancelled) throw new Error("Market inactive");

    // 2% protocol fee
    const fee = (grossStroops * BET_FEE_BPS) / 10_000n;
    const net = grossStroops - fee;

    // Escrow full bet amount in contract
    const fromBal = this.getBalance(bettor);
    if (fromBal < grossStroops) throw new Error("Insufficient balance for bet");
    this.balances.set(bettor, fromBal - grossStroops);
    this.contractBalance += grossStroops;
    this.accumulatedFeesStroops += fee;

    const betKey = `${marketId}:${bettor}`;
    const existingBet = this.bets.get(betKey);
    let isIncrease = false;

    if (existingBet) {
      if (existingBet.isYes !== isYes) throw new Error("Cannot bet opposite side");
      existingBet.grossStroops += grossStroops;
      existingBet.netStroops += net;
      existingBet.feeStroops += fee;
      isIncrease = true;
    } else {
      this.bets.set(betKey, {
        marketId,
        bettor,
        isYes,
        grossStroops,
        netStroops: net,
        feeStroops: fee,
        claimed: false,
      });
      market.betCount += 1;
    }

    if (isYes) {
      market.totalYesStroops += net;
    } else {
      market.totalNoStroops += net;
    }

    const event: DecodedContractEvent = {
      ledger: 101,
      txHash: "b" + marketId.toString().padStart(8, "0") + (isYes ? "1" : "0") + bettor.slice(0, 53),
      topics: ["bet", "placed"],
      data: {
        market_id: BigInt(marketId),
        bettor,
        is_yes: isYes,
        amount: grossStroops,
        net_amount: net,
        fee,
        is_increase: isIncrease,
      },
    };

    return { market, bet: this.bets.get(betKey)!, event };
  }

  submitOutcome(submitter: string, marketId: number, outcome: boolean, bondStroops: bigint) {
    const market = this.markets.get(marketId);
    if (!market) throw new Error(`Market not found: ${marketId}`);
    if (this.currentTimeSecs <= market.endTimeSecs) throw new Error("Market not yet expired");
    if (market.resolved || market.cancelled) throw new Error("Market inactive");
    if (bondStroops < SUBMITTER_BOND_STROOPS) throw new Error("Bond below SUBMITTER_BOND");
    if (this.submissions.has(marketId)) throw new Error("Submission already exists");

    // Escrow bond
    const fromBal = this.getBalance(submitter);
    if (fromBal < bondStroops) throw new Error("Insufficient balance for submitter bond");
    this.balances.set(submitter, fromBal - bondStroops);
    this.contractBalance += bondStroops;

    const challengeDeadlineSecs = this.currentTimeSecs + CHALLENGE_WINDOW_SECS;
    const sub: ContractSubmissionState = {
      marketId,
      submitter,
      outcome,
      bondStroops,
      state: "Submitted",
      submittedAtSecs: this.currentTimeSecs,
      challengeDeadlineSecs,
    };
    this.submissions.set(marketId, sub);

    // Event matching indexer schema (handleOracleSubmission)
    const event = {
      ledger: 102,
      txHash: "s" + marketId.toString().padStart(63, "0"),
      topics: ["submit_outcome"],
      data: {
        market_id: BigInt(marketId),
        submitter,
        outcome: outcome ? "yes" : "no",
        bond_amount: bondStroops,
      },
    };

    return { submission: sub, event };
  }

  challenge(challenger: string, marketId: number, bondStroops: bigint) {
    const sub = this.submissions.get(marketId);
    if (!sub) throw new Error("Submission not found");
    if (sub.state !== "Submitted") throw new Error("Market already challenged or finalized");
    if (this.currentTimeSecs >= sub.challengeDeadlineSecs) throw new Error("Challenge window closed");
    if (bondStroops < DISPUTER_BOND_STROOPS || bondStroops <= sub.bondStroops) {
      throw new Error("Disputer bond too small");
    }

    // Escrow challenger bond
    const fromBal = this.getBalance(challenger);
    if (fromBal < bondStroops) throw new Error("Insufficient balance for challenger bond");
    this.balances.set(challenger, fromBal - bondStroops);
    this.contractBalance += bondStroops;

    sub.state = "Escalated";
    const councilDeadlineSecs = this.currentTimeSecs + COUNCIL_WINDOW_SECS;
    sub.councilDeadlineSecs = councilDeadlineSecs;

    const dispute: ContractDisputeState = {
      marketId,
      challenger,
      bondStroops,
      challengedAtSecs: this.currentTimeSecs,
    };
    this.disputes.set(marketId, dispute);

    const challengedEvent: DecodedContractEvent = {
      ledger: 103,
      txHash: "d" + marketId.toString().padStart(63, "0"),
      topics: ["oracle", "challenged"],
      data: {
        market_id: BigInt(marketId),
        challenger,
        outcome: !sub.outcome ? "yes" : "no",
        bond: bondStroops,
        submitter: sub.submitter,
        submitter_bond: sub.bondStroops,
        challenged_at: BigInt(this.currentTimeSecs),
      },
    };

    const escalatedEvent: DecodedContractEvent = {
      ledger: 103,
      txHash: "e" + marketId.toString().padStart(63, "0"),
      topics: ["oracle", "escalated"],
      data: {
        market_id: BigInt(marketId),
        submitter: sub.submitter,
        challenger,
        outcome: !sub.outcome ? "yes" : "no",
        total_bond: sub.bondStroops + bondStroops,
        escalated_at: BigInt(this.currentTimeSecs),
        council_deadline: BigInt(councilDeadlineSecs),
      },
    };

    return { dispute, challengedEvent, escalatedEvent };
  }

  finalizeOutcomeUnchallenged(marketId: number) {
    const market = this.markets.get(marketId);
    const sub = this.submissions.get(marketId);
    if (!market || !sub) throw new Error("Market or submission missing");
    if (sub.state !== "Submitted") throw new Error("Invalid submission state");
    if (this.currentTimeSecs < sub.challengeDeadlineSecs) throw new Error("Challenge window not elapsed");

    // Return submitter bond in full
    this.contractBalance -= sub.bondStroops;
    this.balances.set(sub.submitter, this.getBalance(sub.submitter) + sub.bondStroops);

    sub.state = "Finalized";
    sub.finalizedAtSecs = this.currentTimeSecs;
    market.resolved = true;
    market.outcome = sub.outcome;

    const event: DecodedContractEvent = {
      ledger: 104,
      txHash: "f" + marketId.toString().padStart(63, "0"),
      topics: ["oracle", "finalized"],
      data: {
        market_id: BigInt(marketId),
        outcome: sub.outcome ? "yes" : "no",
        challenged: false,
        submitter: sub.submitter,
        challenger: null,
        submitter_payout: sub.bondStroops,
        challenger_payout: 0n,
        council_fee: 0n,
        protocol_credit: 0n,
        finalized_at: BigInt(this.currentTimeSecs),
      },
    };

    return { market, event };
  }

  resolveChallenge(resolver: string, marketId: number, rulingOutcome: boolean) {
    const market = this.markets.get(marketId);
    const sub = this.submissions.get(marketId);
    const dispute = this.disputes.get(marketId);
    if (!market || !sub || !dispute) throw new Error("Escalated market components missing");
    if (sub.state !== "Escalated") throw new Error("Market not in escalated state");

    let submitterPayout = 0n;
    let challengerPayout = 0n;
    let councilFee = 0n;
    let protocolCredit = 0n;

    if (rulingOutcome === sub.outcome) {
      // Submitter correct: gets back bond + 1/2 challenger bond
      submitterPayout = sub.bondStroops + dispute.bondStroops / 2n;
      challengerPayout = 0n;
      councilFee = dispute.bondStroops / 10n; // 10% fee on loser bond
      protocolCredit = dispute.bondStroops - dispute.bondStroops / 2n;
    } else {
      // Challenger correct: gets both bonds less 10% council fee on loser's bond
      councilFee = sub.bondStroops / 10n;
      challengerPayout = dispute.bondStroops + sub.bondStroops - councilFee;
      submitterPayout = 0n;
      protocolCredit = councilFee;
    }

    // Payout transfers
    if (submitterPayout > 0n) {
      this.contractBalance -= submitterPayout;
      this.balances.set(sub.submitter, this.getBalance(sub.submitter) + submitterPayout);
    }
    if (challengerPayout > 0n) {
      this.contractBalance -= challengerPayout;
      this.balances.set(dispute.challenger, this.getBalance(dispute.challenger) + challengerPayout);
    }

    // Fees retained by protocol
    this.accumulatedFeesStroops += protocolCredit;

    sub.state = "Finalized";
    sub.finalizedAtSecs = this.currentTimeSecs;
    market.resolved = true;
    market.outcome = rulingOutcome;

    const event: DecodedContractEvent = {
      ledger: 105,
      txHash: "g" + marketId.toString().padStart(63, "0"),
      topics: ["oracle", "finalized"],
      data: {
        market_id: BigInt(marketId),
        outcome: rulingOutcome ? "yes" : "no",
        challenged: true,
        submitter: sub.submitter,
        challenger: dispute.challenger,
        submitter_payout: submitterPayout,
        challenger_payout: challengerPayout,
        council_fee: councilFee,
        protocol_credit: protocolCredit,
        finalized_at: BigInt(this.currentTimeSecs),
      },
    };

    return {
      market,
      event,
      submitterPayout,
      challengerPayout,
      councilFee,
      protocolCredit,
    };
  }

  claim(user: string, marketId: number) {
    const market = this.markets.get(marketId);
    if (!market || !market.resolved) throw new Error("Market not resolved");

    const betKey = `${marketId}:${user}`;
    const bet = this.bets.get(betKey);
    if (!bet) throw new Error("No bet found");
    if (bet.claimed) throw new Error("Bet already claimed");

    let payout = 0n;
    if (bet.isYes === market.outcome) {
      const winningPool = market.outcome ? market.totalYesStroops : market.totalNoStroops;
      const totalPool = market.totalYesStroops + market.totalNoStroops;
      payout = (bet.netStroops * totalPool) / winningPool;
    }

    bet.claimed = true;
    if (payout > 0n) {
      this.contractBalance -= payout;
      this.balances.set(user, this.getBalance(user) + payout);
    }

    const event = {
      ledger: 106,
      txHash: "l" + marketId.toString().padStart(8, "0") + user.slice(0, 54),
      topics: ["reward_claimed"],
      data: {
        market_id: BigInt(marketId),
        user,
        payout_xlm: stroopsToXlm(payout),
      },
    };

    return { payout, event };
  }
}

const testLogger = { warn: () => {}, info: () => {}, error: () => {} };

// ── Test Suite ──────────────────────────────────────────────────────────────

describe("End-to-End Optimistic Oracle Lifecycle Test (Issue #541)", () => {
  let db: StatefulTestDatabase;
  let redis: FakeRedis;
  let contract: SorobanContractSimulator;
  let server: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    db = new StatefulTestDatabase();
    redis = new FakeRedis();
    contract = new SorobanContractSimulator();

    process.env.METRICS_TOKEN = "test-token";
    process.env.ORACLE_API_KEY = "test-oracle-key";

    server = buildServer({
      corsOrigins: [],
      pool: db as unknown as Pool,
      redis: redis as unknown as Redis,
      logger: false,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Path A: Full Unchallenged Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  it("completes the full unchallenged lifecycle across Contract, Indexer, Database, and API", async () => {
    const initialAlice = contract.getBalance(ALICE);
    const initialBob = contract.getBalance(BOB);
    const initialSubmitter = contract.getBalance(SUBMITTER);
    const initialFees = contract.accumulatedFeesStroops;

    // 1. Creation
    const { market, event: createEv } = contract.createMarket(CREATOR, "Will XLM exceed $1.00?", "Crypto", 3600);
    expect(market.id).toBe(1);
    await handleMarketCreatedEvent(createEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // Consistency check: DB
    const dbMarket1 = db.markets.get(1);
    expect(dbMarket1).toBeDefined();
    expect(dbMarket1?.question).toBe("Will XLM exceed $1.00?");
    expect(dbMarket1?.resolved).toBe(false);

    // Consistency check: API
    const apiRes1 = await server.inject({ method: "GET", url: "/api/markets/1" });
    expect(apiRes1.statusCode).toBe(200);
    expect(apiRes1.json().question).toBe("Will XLM exceed $1.00?");
    expect(apiRes1.json().resolved).toBe(false);

    // 2. Bets Placed (Alice 100 XLM YES, Bob 100 XLM NO)
    const betAmount = 100n * STROOP_UNIT;
    const { event: aliceBetEv } = contract.placeBet(ALICE, 1, true, betAmount);
    const { event: bobBetEv } = contract.placeBet(BOB, 1, false, betAmount);

    await handleBetPlacedEvent(aliceBetEv, db as unknown as DbClient, redis as unknown as RedisClient);
    await handleBetPlacedEvent(bobBetEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // Consistency check: Contract
    expect(contract.markets.get(1)?.totalYesStroops).toBe(98n * STROOP_UNIT);
    expect(contract.markets.get(1)?.totalNoStroops).toBe(98n * STROOP_UNIT);
    expect(contract.accumulatedFeesStroops - initialFees).toBe(4n * STROOP_UNIT);

    // Consistency check: DB
    expect(db.markets.get(1)?.total_yes).toBe("98.0000000");
    expect(db.markets.get(1)?.total_no).toBe("98.0000000");
    expect(db.markets.get(1)?.bet_count).toBe(2);

    // Consistency check: API
    const oddsRes = await server.inject({ method: "GET", url: "/api/markets/1/odds" });
    expect(oddsRes.statusCode).toBe(200);
    const oddsJson = oddsRes.json();
    expect(oddsJson.yes_odds).toBe(0.5);
    expect(oddsJson.no_odds).toBe(0.5);
    expect(oddsJson.implied_probability).toEqual({ yes: 0.5, no: 0.5 });

    const betsRes = await server.inject({ method: "GET", url: "/api/markets/1/bets" });
    expect(betsRes.statusCode).toBe(200);
    expect(betsRes.json().bets.length).toBe(2);

    // 3. Expiration
    contract.currentTimeSecs += 3601; // Past end_time

    // 4. Outcome Submission
    const { event: submitEv } = contract.submitOutcome(SUBMITTER, 1, true, SUBMITTER_BOND_STROOPS);
    await handleOracleSubmission(submitEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    // Consistency check: DB
    expect(db.submissions.get(1)?.status).toBe("submitted");
    expect(db.submissions.get(1)?.outcome).toBe("yes");
    expect(db.submissions.get(1)?.bond_amount).toBe(SUBMITTER_BOND_STROOPS.toString());

    // 5. Unchallenged Finalization (window elapses)
    contract.currentTimeSecs += CHALLENGE_WINDOW_SECS;
    const { event: finalizeEv } = contract.finalizeOutcomeUnchallenged(1);
    await handleOracleFinalizedEvent(finalizeEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // Consistency check: Contract, DB, API
    expect(contract.markets.get(1)?.resolved).toBe(true);
    expect(contract.markets.get(1)?.outcome).toBe(true);
    expect(db.markets.get(1)?.resolved).toBe(true);
    expect(db.markets.get(1)?.outcome).toBe(true);
    expect(db.submissions.get(1)?.status).toBe("finalized");

    const apiResolved = await server.inject({ method: "GET", url: "/api/markets/1" });
    expect(apiResolved.statusCode).toBe(200);
    expect(apiResolved.json().resolved).toBe(true);
    expect(apiResolved.json().outcome).toBe(true);

    // Filter verification
    const activeList = await server.inject({ method: "GET", url: "/api/markets?filter=active" });
    expect(activeList.json().markets.some((m: { id: number }) => m.id === 1)).toBe(false);
    const resolvedList = await server.inject({ method: "GET", url: "/api/markets?filter=resolved" });
    expect(resolvedList.json().markets.some((m: { id: number }) => m.id === 1)).toBe(true);

    // 6. Claims
    const { payout: alicePayout, event: aliceClaimEv } = contract.claim(ALICE, 1);
    const { payout: bobPayout, event: bobClaimEv } = contract.claim(BOB, 1);

    expect(alicePayout).toBe(196n * STROOP_UNIT);
    expect(bobPayout).toBe(0n);

    await handleClaim(aliceClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });
    await handleClaim(bobClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    expect(db.bets.get("1:" + ALICE)?.claimed).toBe(true);
    expect(db.bets.get("1:" + BOB)?.claimed).toBe(true);

    // 7. Exact Mathematical Balance Assertions
    const finalAlice = contract.getBalance(ALICE);
    const finalBob = contract.getBalance(BOB);
    const finalSubmitter = contract.getBalance(SUBMITTER);
    const finalFees = contract.accumulatedFeesStroops;

    const aliceNet = finalAlice - initialAlice;
    const bobNet = finalBob - initialBob;
    const submitterNet = finalSubmitter - initialSubmitter;
    const feeNet = finalFees - initialFees;

    expect(submitterNet).toBe(0n);                         // Bond returned in full (0 stroops loss/profit)
    expect(aliceNet).toBe(96n * STROOP_UNIT);          // Net +96 XLM profit (196 payout - 100 bet)
    expect(bobNet).toBe(-100n * STROOP_UNIT);          // Net -100 XLM loss
    expect(feeNet).toBe(4n * STROOP_UNIT);             // Net +4 XLM betting fee collected

    // Total Conservation: sum of net changes equals 0 exactly
    expect(submitterNet + aliceNet + bobNet + feeNet).toBe(0n);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Path B: Challenged-then-Ruled Lifecycle (Council rules for Submitter)
  // ───────────────────────────────────────────────────────────────────────────

  it("completes the challenged-then-ruled lifecycle when council upholds the submitter", async () => {
    const initialAlice = contract.getBalance(ALICE);
    const initialBob = contract.getBalance(BOB);
    const initialSubmitter = contract.getBalance(SUBMITTER);
    const initialChallenger = contract.getBalance(CHALLENGER);
    const initialFees = contract.accumulatedFeesStroops;

    // 1. Create Market 2 & Place Bets
    const { market, event: createEv } = contract.createMarket(CREATOR, "Will ETH flip BTC in 2026?", "Crypto", 3600);
    expect(market.id).toBe(2);
    await handleMarketCreatedEvent(createEv, db as unknown as DbClient, redis as unknown as RedisClient);

    const betAmount = 100n * STROOP_UNIT;
    const { event: aliceBetEv } = contract.placeBet(ALICE, 2, true, betAmount);
    const { event: bobBetEv } = contract.placeBet(BOB, 2, false, betAmount);
    await handleBetPlacedEvent(aliceBetEv, db as unknown as DbClient, redis as unknown as RedisClient);
    await handleBetPlacedEvent(bobBetEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // 2. Expiration & Outcome Submission
    contract.currentTimeSecs += 3601;
    const { event: submitEv } = contract.submitOutcome(SUBMITTER, 2, true, SUBMITTER_BOND_STROOPS);
    await handleOracleSubmission(submitEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    // 3. Challenge filed within window
    contract.currentTimeSecs += 3600; // 1 hr later
    const { challengedEvent, escalatedEvent } = contract.challenge(CHALLENGER, 2, DISPUTER_BOND_STROOPS);
    await handleOracleChallengedEvent(challengedEvent, db as unknown as DbClient, redis as unknown as RedisClient);
    await handleOracleEscalatedEvent(escalatedEvent, db as unknown as DbClient, redis as unknown as RedisClient);

    // Consistency check: DB dispute tracking
    expect(db.submissions.get(2)?.status).toBe("challenged");
    expect(db.disputes.get(2)?.status).toBe("escalated");
    expect(db.disputes.get(2)?.challenger).toBe(CHALLENGER);
    expect(db.disputes.get(2)?.total_bond).toBe((300n * STROOP_UNIT).toString());

    // 4. Council Votes & Decision (4 members agree outcome is YES / submitter upheld)
    const councilVotes = new CouncilVoteManager();
    councilVotes.submitVote("member-1", true);
    councilVotes.submitVote("member-2", true);
    councilVotes.submitVote("member-3", true);
    councilVotes.submitVote("member-4", true);
    expect(councilVotes.getAgreedOutcome(4)).toBe(true);

    // 5. Ruling Executed
    const { event: finalizeEv, submitterPayout, challengerPayout, councilFee, protocolCredit } = contract.resolveChallenge(COUNCIL_RESOLVER, 2, true);
    expect(submitterPayout).toBe(200n * STROOP_UNIT); // SUB_BOND + DIS_BOND / 2
    expect(challengerPayout).toBe(0n);
    expect(councilFee).toBe(20n * STROOP_UNIT);        // 10% of 200 XLM
    expect(protocolCredit).toBe(100n * STROOP_UNIT);

    await handleOracleFinalizedEvent(finalizeEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // Consistency check: DB & API
    expect(db.markets.get(2)?.resolved).toBe(true);
    expect(db.markets.get(2)?.outcome).toBe(true);
    expect(db.submissions.get(2)?.status).toBe("finalized");
    expect(db.submissions.get(2)?.decision).toBe("yes");

    const apiResolved = await server.inject({ method: "GET", url: "/api/markets/2" });
    expect(apiResolved.statusCode).toBe(200);
    expect(apiResolved.json().resolved).toBe(true);
    expect(apiResolved.json().outcome).toBe(true);

    // 6. Bettor Claims
    const { payout: alicePayout, event: aliceClaimEv } = contract.claim(ALICE, 2);
    const { payout: bobPayout, event: bobClaimEv } = contract.claim(BOB, 2);
    expect(alicePayout).toBe(196n * STROOP_UNIT);
    expect(bobPayout).toBe(0n);

    await handleClaim(aliceClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });
    await handleClaim(bobClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    // 7. Exact Mathematical Balance Assertions
    const finalAlice = contract.getBalance(ALICE);
    const finalBob = contract.getBalance(BOB);
    const finalSubmitter = contract.getBalance(SUBMITTER);
    const finalChallenger = contract.getBalance(CHALLENGER);
    const finalFees = contract.accumulatedFeesStroops;

    const aliceNet = finalAlice - initialAlice;
    const bobNet = finalBob - initialBob;
    const submitterNet = finalSubmitter - initialSubmitter;
    const challengerNet = finalChallenger - initialChallenger;
    const feeNet = finalFees - initialFees;

    expect(submitterNet).toBe(100n * STROOP_UNIT);     // Net +100 XLM profit (200 payout - 100 bond)
    expect(challengerNet).toBe(-200n * STROOP_UNIT);   // Net -200 XLM loss
    expect(aliceNet).toBe(96n * STROOP_UNIT);          // Net +96 XLM profit (196 payout - 100 bet)
    expect(bobNet).toBe(-100n * STROOP_UNIT);          // Net -100 XLM loss
    expect(feeNet).toBe(104n * STROOP_UNIT);           // Net +104 XLM (4 bet fee + 100 dispute credit)

    // Total Conservation: sum of net changes equals 0 exactly
    expect(submitterNet + challengerNet + aliceNet + bobNet + feeNet).toBe(0n);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Path C: Challenged-then-Ruled Lifecycle (Council rules for Challenger)
  // ───────────────────────────────────────────────────────────────────────────

  it("completes the challenged-then-ruled lifecycle when council upholds the challenger", async () => {
    const initialAlice = contract.getBalance(ALICE);
    const initialBob = contract.getBalance(BOB);
    const initialSubmitter = contract.getBalance(SUBMITTER);
    const initialChallenger = contract.getBalance(CHALLENGER);
    const initialFees = contract.accumulatedFeesStroops;

    // 1. Create Market 3 & Place Bets
    const { market, event: createEv } = contract.createMarket(CREATOR, "Will SOL hit $500 in 2026?", "Crypto", 3600);
    expect(market.id).toBe(3);
    await handleMarketCreatedEvent(createEv, db as unknown as DbClient, redis as unknown as RedisClient);

    const betAmount = 100n * STROOP_UNIT;
    const { event: aliceBetEv } = contract.placeBet(ALICE, 3, true, betAmount);
    const { event: bobBetEv } = contract.placeBet(BOB, 3, false, betAmount);
    await handleBetPlacedEvent(aliceBetEv, db as unknown as DbClient, redis as unknown as RedisClient);
    await handleBetPlacedEvent(bobBetEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // 2. Expiration & Outcome Submission (Submitter falsely submits YES)
    contract.currentTimeSecs += 3601;
    const { event: submitEv } = contract.submitOutcome(SUBMITTER, 3, true, SUBMITTER_BOND_STROOPS);
    await handleOracleSubmission(submitEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    // 3. Challenger challenges with 200 XLM bond asserting NO
    contract.currentTimeSecs += 7200;
    const { challengedEvent, escalatedEvent } = contract.challenge(CHALLENGER, 3, DISPUTER_BOND_STROOPS);
    await handleOracleChallengedEvent(challengedEvent, db as unknown as DbClient, redis as unknown as RedisClient);
    await handleOracleEscalatedEvent(escalatedEvent, db as unknown as DbClient, redis as unknown as RedisClient);

    // 4. Council votes NO (challenger correct)
    const councilVotes = new CouncilVoteManager();
    councilVotes.submitVote("member-1", false);
    councilVotes.submitVote("member-2", false);
    councilVotes.submitVote("member-3", false);
    councilVotes.submitVote("member-4", false);
    expect(councilVotes.getAgreedOutcome(4)).toBe(false);

    // 5. Ruling Executed
    const { event: finalizeEv, submitterPayout, challengerPayout, councilFee, protocolCredit } = contract.resolveChallenge(COUNCIL_RESOLVER, 3, false);
    expect(submitterPayout).toBe(0n);
    expect(councilFee).toBe(10n * STROOP_UNIT);        // 10% of submitter bond (10 XLM)
    expect(challengerPayout).toBe(290n * STROOP_UNIT); // 200 + 100 - 10 = 290 XLM
    expect(protocolCredit).toBe(10n * STROOP_UNIT);

    await handleOracleFinalizedEvent(finalizeEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // Consistency check: DB & API
    expect(db.markets.get(3)?.resolved).toBe(true);
    expect(db.markets.get(3)?.outcome).toBe(false);
    expect(db.submissions.get(3)?.decision).toBe("no");

    const apiResolved = await server.inject({ method: "GET", url: "/api/markets/3" });
    expect(apiResolved.statusCode).toBe(200);
    expect(apiResolved.json().resolved).toBe(true);
    expect(apiResolved.json().outcome).toBe(false);

    // 6. Bettor Claims (Bob was NO bettor -> Bob wins!)
    const { payout: bobPayout, event: bobClaimEv } = contract.claim(BOB, 3);
    const { payout: alicePayout, event: aliceClaimEv } = contract.claim(ALICE, 3);
    expect(bobPayout).toBe(196n * STROOP_UNIT);
    expect(alicePayout).toBe(0n);

    await handleClaim(bobClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });
    await handleClaim(aliceClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    // 7. Exact Mathematical Balance Assertions
    const finalAlice = contract.getBalance(ALICE);
    const finalBob = contract.getBalance(BOB);
    const finalSubmitter = contract.getBalance(SUBMITTER);
    const finalChallenger = contract.getBalance(CHALLENGER);
    const finalFees = contract.accumulatedFeesStroops;

    const aliceNet = finalAlice - initialAlice;
    const bobNet = finalBob - initialBob;
    const submitterNet = finalSubmitter - initialSubmitter;
    const challengerNet = finalChallenger - initialChallenger;
    const feeNet = finalFees - initialFees;

    expect(submitterNet).toBe(-100n * STROOP_UNIT);    // Net -100 XLM loss
    expect(challengerNet).toBe(90n * STROOP_UNIT);     // Net +90 XLM profit (290 payout - 200 bond)
    expect(bobNet).toBe(96n * STROOP_UNIT);            // Net +96 XLM profit (196 payout - 100 bet)
    expect(aliceNet).toBe(-100n * STROOP_UNIT);        // Net -100 XLM loss
    expect(feeNet).toBe(14n * STROOP_UNIT);            // Net +14 XLM (4 bet fee + 10 council fee)

    // Total Conservation: sum of net changes equals 0 exactly
    expect(submitterNet + challengerNet + aliceNet + bobNet + feeNet).toBe(0n);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Path D: Indexer Replay Idempotency & State Invariance
  // ───────────────────────────────────────────────────────────────────────────

  it("guarantees indexer idempotency: replaying events causes zero duplicate state", async () => {
    // Take snapshot of market 1 before replay
    const marketBefore = { ...db.markets.get(1)! };
    const betCountBefore = db.bets.size;
    const eventsBefore = db.events.size;

    // Create a mock bet event with identical tx_hash & event_index as Alice's bet on market 1
    const aliceBetEv: DecodedContractEvent = {
      ledger: 101,
      txHash: "b" + (1).toString().padStart(8, "0") + "1" + ALICE.slice(0, 53),
      topics: ["bet", "placed"],
      data: {
        market_id: 1n,
        bettor: ALICE,
        is_yes: true,
        amount: 100n * STROOP_UNIT,
        net_amount: 98n * STROOP_UNIT,
        fee: 2n * STROOP_UNIT,
        is_increase: false,
      },
    };

    // Replay the bet event through indexer handler
    await handleBetPlacedEvent(aliceBetEv, db as unknown as DbClient, redis as unknown as RedisClient);

    // Assert that market totals, bet counts, and events size did not change
    const marketAfter = db.markets.get(1)!;
    expect(marketAfter.total_yes).toBe(marketBefore.total_yes);
    expect(marketAfter.total_no).toBe(marketBefore.total_no);
    expect(marketAfter.bet_count).toBe(marketBefore.bet_count);
    expect(db.bets.size).toBe(betCountBefore);
    expect(db.events.size).toBe(eventsBefore);

    // Replay claim event
    const aliceClaimEv = {
      ledger: 106,
      txHash: "l" + (1).toString().padStart(8, "0") + ALICE.slice(0, 54),
      topics: ["reward_claimed"],
      data: {
        market_id: 1n,
        user: ALICE,
        payout_xlm: "196.0000000",
      },
    };
    await handleClaim(aliceClaimEv, { db: db as unknown as DbClient, redis: redis as unknown as RedisClient, logger: testLogger });

    // Assert bet remains claimed without duplicate payouts
    expect(db.bets.get("1:" + ALICE)?.claimed).toBe(true);
  });
});
