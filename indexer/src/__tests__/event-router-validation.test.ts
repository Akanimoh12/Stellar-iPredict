/**
 * Schema-validation boundary tests for the event router (issue #499).
 *
 * Every routed event type must have its payload validated against its schema
 * BEFORE handler logic runs. A malformed payload is dead-lettered with a
 * reason naming the failing field — never thrown — so a contract change that
 * silently alters an event shape can neither corrupt derived state nor crash
 * the poll loop.
 *
 * All tests are pure in-memory: the DB is a recording stub and the metrics
 * registry is reset per test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeEventToDb } from "../event-router.js";
import { metrics, resetMetrics } from "../metrics.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const ADDR = "G" + "A".repeat(55);
const OTHER = "G" + "B".repeat(55);

/** Valid payloads, one per routed event type. */
function validPayloadFor(topics: readonly unknown[]): unknown {
  const [domain, action] = topics;
  if (domain === "mkt" && action === "created") {
    return { market_id: 1, question: "Will X win?", category: "Crypto", end_time: 1_700_000_000, creator: ADDR };
  }
  if (domain === "market_resolved" || (domain === "mkt" && action === "resolved")) {
    return { market_id: 1, outcome: true };
  }
  if (domain === "mkt" && action === "cancelled") {
    return { market_id: 1 };
  }
  if (domain === "bet_placed") {
    return { market_id: 1, bettor: ADDR, is_yes: true, amount: "10000000", net_amount: "9800000", fee: "200000", is_increase: false };
  }
  if (domain === "referral" && action === "registered") {
    return { user: ADDR, display_name: "alice", referrer: OTHER };
  }
  if (domain === "referral" && action === "reward") {
    return { referrer: ADDR, points: 3 };
  }
  if (domain === "oracle" && action === "challenged") {
    return { market_id: 1, challenger: OTHER, outcome: false, bond: 100n, submitter: ADDR, submitter_bond: 50n, challenged_at: 1_700_000_000n };
  }
  if (domain === "oracle" && action === "escalated") {
    return { market_id: 1, submitter: ADDR, challenger: OTHER, outcome: true, total_bond: 150n, escalated_at: 1_700_000_000n, council_deadline: 1_700_259_200n };
  }
  if (domain === "oracle" && action === "finalized") {
    return { market_id: 1, outcome: true, challenged: false, submitter: ADDR, challenger: null, submitter_payout: 100n, challenger_payout: 0n, council_fee: 0n, protocol_credit: 0n, finalized_at: 1_700_000_000n };
  }
  throw new Error(`no valid payload fixture for ${String(domain)}:${String(action)}`);
}

/** Malformed payloads, one per routed event type. Each must trip its schema. */
function malformedPayloadFor(topics: readonly unknown[]): unknown {
  const [domain, action] = topics;
  if (domain === "mkt" && action === "created") {
    // `question` is an empty string — schema requires a non-empty string.
    return { market_id: 1, question: "", category: "Crypto", end_time: 1_700_000_000, creator: ADDR };
  }
  if (domain === "market_resolved" || (domain === "mkt" && action === "resolved")) {
    // Negative market_id.
    return { market_id: -5, outcome: true };
  }
  if (domain === "mkt" && action === "cancelled") {
    // Non-numeric market_id.
    return { market_id: "not-a-number" };
  }
  if (domain === "bet_placed") {
    // Bettor is not a Stellar address.
    return { market_id: 1, bettor: "not-an-address", is_yes: true, amount: "100", net_amount: "90" };
  }
  if (domain === "referral" && action === "registered") {
    // User is not a Stellar address.
    return { user: "nope" };
  }
  if (domain === "referral" && action === "reward") {
    // Referrer is not a Stellar address.
    return { referrer: "nope", points: 3 };
  }
  if (domain === "oracle" && action === "challenged") {
    // Challenger is not a Stellar address.
    return { market_id: 1, challenger: "bad", outcome: false, bond: 1n, submitter: ADDR, submitter_bond: 1n, challenged_at: 1n };
  }
  if (domain === "oracle" && action === "escalated") {
    // Missing submitter entirely.
    return { market_id: 1, challenger: OTHER, outcome: true, total_bond: 1n, escalated_at: 1n, council_deadline: 1n };
  }
  if (domain === "oracle" && action === "finalized") {
    // Payload is not even an object — asRecord yields {} and market_id is missing.
    return "not-an-object";
  }
  throw new Error(`no malformed payload fixture for ${String(domain)}:${String(action)}`);
}

const ROUTED_TOPICS: readonly (readonly unknown[])[] = [
  ["mkt", "created"],
  ["market_resolved"],
  ["mkt", "resolved"],
  ["mkt", "cancelled"],
  ["bet_placed"],
  ["referral", "registered"],
  ["referral", "reward"],
  ["oracle", "challenged"],
  ["oracle", "escalated"],
  ["oracle", "finalized"],
];

function makeEvent(topics: readonly unknown[], data: unknown): DecodedContractEvent {
  return { topics, data, ledger: 100, txHash: "a".repeat(64), eventIndex: 0 };
}

function makeDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
}

function makeRedis(): RedisClient {
  return { del: vi.fn().mockResolvedValue(1) };
}

/** The INSERT into dead_letter_events recorded by the stub db, if any. */
function deadLetterCalls(db: ReturnType<typeof makeDb>): Array<{ sql: string; params: readonly unknown[] }> {
  return db.query.mock.calls
    .map(([sql, params]) => ({ sql: sql as string, params: params as readonly unknown[] }))
    .filter((call) => call.sql.includes("dead_letter_events"));
}

beforeEach(() => {
  resetMetrics();
});

describe("schema boundary: every routed event type validates its payload", () => {
  for (const topics of ROUTED_TOPICS) {
    const label = topics.join(":");

    it(`[${label}] accepts its valid payload and dispatches the handler`, async () => {
      const db = makeDb();
      const redis = makeRedis();

      await expect(writeEventToDb(makeEvent(topics, validPayloadFor(topics)), db, redis)).resolves.toBeUndefined();

      // The handler ran (wrote something other than a dead-letter row).
      const nonDeadLetter = db.query.mock.calls.filter(([sql]) => !(sql as string).includes("dead_letter_events"));
      expect(nonDeadLetter.length).toBeGreaterThan(0);
      expect(metrics.eventsProcessed.get()).toBe(1);
      expect(metrics.eventsDeadLettered.get()).toBe(0);
    });

    it(`[${label}] dead-letters a malformed payload with the failing field named, without throwing`, async () => {
      const db = makeDb();
      const redis = makeRedis();

      // The malformed event must never reject — the poll loop keeps running.
      await expect(writeEventToDb(makeEvent(topics, malformedPayloadFor(topics)), db, redis)).resolves.toBeUndefined();

      const deadLetters = deadLetterCalls(db);
      expect(deadLetters).toHaveLength(1);

      const [ledger, txHash, rawEvent, reason] = deadLetters[0].params;
      expect(ledger).toBe(100);
      expect(txHash).toBe("a".repeat(64));
      // The whole raw decoded event is preserved for inspection/replay.
      // (Round-trip the fixture through the same BigInt-safe serialization.)
      const expectedData = JSON.parse(
        JSON.stringify(malformedPayloadFor(topics), (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
      expect(JSON.parse(rawEvent as string)).toMatchObject({ ledger: 100, data: expectedData });

      // The reason names the route AND the failing field with the why.
      const [routeName, ...fieldHint] = (reason as string).replace(/^(\w+) payload failed validation: /, "$1|").split("|");
      expect(reason as string).toContain("failed validation");
      expect(routeName.length).toBeGreaterThan(0);
      expect(fieldHint.join("|").length).toBeGreaterThan(0);

      // No handler write occurred, and the failure is counted as dead-lettered
      // rather than processed.
      const nonDeadLetter = db.query.mock.calls.filter(([sql]) => !(sql as string).includes("dead_letter_events"));
      expect(nonDeadLetter).toHaveLength(0);
      expect(metrics.eventsProcessed.get()).toBe(0);
      expect(metrics.eventsDeadLettered.get()).toBe(1);
    });
  }

  it("names the failing field in the dead-letter reason (e.g. bettor)", async () => {
    const db = makeDb();
    await writeEventToDb(makeEvent(["bet_placed"], malformedPayloadFor(["bet_placed"])), db, makeRedis());

    const reason = deadLetterCalls(db)[0].params[3] as string;
    expect(reason).toContain("bettor");
    expect(reason).toContain("Stellar address");
  });
});

describe("schema boundary: routing invariants", () => {
  it("dead-letters unrecognized event types with a clear reason", async () => {
    const db = makeDb();
    await writeEventToDb(makeEvent(["unknown", "event"], {}), db, makeRedis());

    const deadLetters = deadLetterCalls(db);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].params[3]).toBe("unrecognized event type: unknown:event");
    expect(metrics.eventsDeadLettered.get()).toBe(1);
    expect(metrics.eventsProcessed.get()).toBe(0);
  });

  it("does not crash the poll loop when persisting the dead letter itself fails", async () => {
    const db = makeDb();
    db.query.mockRejectedValueOnce(new Error("dead_letter_events does not exist"));

    await expect(
      writeEventToDb(makeEvent(["mkt", "cancelled"], { market_id: "nope" }), db, makeRedis()),
    ).resolves.toBeUndefined();
  });

  it("keeps every historical market_resolved topic shape routed", async () => {
    for (const topics of [["market_resolved"], ["mkt", "resolved"]]) {
      const db = makeDb();
      const before = metrics.eventsProcessed.get();
      await writeEventToDb(makeEvent(topics, { market_id: 1, outcome: true }), db, makeRedis());
      expect(metrics.eventsProcessed.get()).toBe(before + 1);
    }
  });

  it("dead-letters a bet_placed event whose payload contradicts its topic args", async () => {
    const db = makeDb();
    const event = makeEvent(
      ["bet", "placed", 42, ADDR],
      { market_id: 43, bettor: ADDR, is_yes: true, amount: "100", net_amount: "90" },
    );

    await expect(writeEventToDb(event, db, makeRedis())).resolves.toBeUndefined();

    const reason = deadLetterCalls(db)[0].params[3] as string;
    expect(reason).toContain("market_id does not match its topic value");
    expect(metrics.eventsDeadLettered.get()).toBe(1);
  });

  it("survives dead-lettering an event containing BigInt fields (i128 amounts)", async () => {
    // JSON.stringify throws on BigInt — the dead-letter write must not.
    // (Invalid market_id forces the dead-letter path while bond/timestamp
    // BigInts exercise the serializer.)
    const db = makeDb();
    const event = makeEvent(["oracle", "challenged"], {
      market_id: "not-a-number",
      challenger: OTHER,
      outcome: false,
      bond: 200_0000000n,
      submitter: ADDR,
      submitter_bond: 100_0000000n,
      challenged_at: 1_700_000_000n,
    });

    await expect(writeEventToDb(event, db, makeRedis())).resolves.toBeUndefined();

    const rawEvent = JSON.parse(deadLetterCalls(db)[0].params[2] as string);
    expect(rawEvent.data.bond).toBe("2000000000");
    expect(metrics.eventsDeadLettered.get()).toBe(1);
  });
});
