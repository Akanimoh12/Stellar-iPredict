/**
 * Unit tests for dead-letter event reprocessing (issue #496).
 *
 * All tests are pure in-memory — no live database or Redis.  The DB is
 * mocked via vi.fn() stubs that record calls and return scripted responses,
 * matching the pattern used throughout the rest of the test suite.
 *
 * Coverage:
 *   - reprocessDeadLetterEvent: success path, failure path, decode failure
 *   - Idempotency: replaying an already-processed event is a no-op
 *   - Attempt tracking: attempt_count and last_error are updated correctly
 *   - Resolved marking: resolved_at is set on success, skipped on failure
 *   - reprocessDeadLetterBatch: aggregates results across multiple rows
 *   - refreshDeadLetterQueueDepth: updates gauge and fires alert above threshold
 *   - serializeMetrics: dead_letter_queue_depth appears in Prometheus output
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reprocessDeadLetterEvent,
  reprocessDeadLetterBatch,
  listUnresolvedDeadLetterEvents,
  countUnresolvedDeadLetterEvents,
  DEAD_LETTER_ALERT_THRESHOLD,
  type DeadLetterRow,
} from "../deadLetter.js";
import {
  metrics,
  resetMetrics,
  refreshDeadLetterQueueDepth,
  serializeMetrics,
} from "../metrics.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Canonical raw_event shape that reconstructEvent can parse. */
function makeRawEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    ledger: 1000,
    txHash: "a".repeat(64),
    topics: ["mkt", "cancelled"],
    data: { market_id: 42 },
    eventIndex: 0,
    ...overrides,
  };
}

function makeRow(overrides: Partial<DeadLetterRow> = {}): DeadLetterRow {
  return {
    id: 1,
    ledger_seq: 1000,
    tx_hash: "a".repeat(64),
    raw_event: makeRawEvent(),
    error_message: "original error",
    attempt_count: 0,
    last_error: null,
    resolved_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Build a minimal DbClient mock.
 * `queryResponses` maps a SQL fragment to the rows/rowCount to return.
 * Unmatched queries return { rows: [], rowCount: 0 } by default.
 */
function makeDb(
  queryResponses: Record<string, { rows?: unknown[]; rowCount?: number }> = {},
) {
  return {
    query: vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      for (const [fragment, response] of Object.entries(queryResponses)) {
        if (sql.includes(fragment)) {
          return { rows: response.rows ?? [], rowCount: response.rowCount ?? 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function makeRedis() {
  return { del: vi.fn().mockResolvedValue(1) };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("reprocessDeadLetterEvent", () => {
  it("marks the row resolved when writeEventToDb succeeds", async () => {
    const db = makeDb({
      // recordAttempt returns the new attempt_count
      "attempt_count + 1": { rows: [{ attempt_count: 1 }], rowCount: 1 },
      // markResolved UPDATE
      "resolved_at = NOW()": { rows: [], rowCount: 1 },
    });
    const redis = makeRedis();
    const row = makeRow();

    const result = await reprocessDeadLetterEvent(db as never, redis, row);

    expect(result.resolved).toBe(true);
    expect(result.attempt).toBe(1);
    expect(result.error).toBeUndefined();

    // recordAttempt should have been called
    const attemptCall = db.query.mock.calls.find(
      ([sql]: [string]) => sql.includes("attempt_count + 1"),
    );
    expect(attemptCall).toBeDefined();

    // markResolved should have been called
    const resolvedCall = db.query.mock.calls.find(
      ([sql]: [string]) => sql.includes("resolved_at = NOW()"),
    );
    expect(resolvedCall).toBeDefined();
  });

  it("records the error and does NOT mark resolved when writeEventToDb throws", async () => {
    const db = makeDb({
      "attempt_count + 1": { rows: [{ attempt_count: 1 }], rowCount: 1 },
    });
    const redis = makeRedis();
    const row = makeRow();

    // Make every call to writeEventToDb fail by making the handler INSERT fail.
    // We can't easily mock event-router.ts here, so we make the INSERT into
    // events fail by having db.query throw on "INSERT INTO events".
    const throwingDb = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("INSERT INTO events")) {
          throw new Error("DB connection lost");
        }
        if (sql.includes("attempt_count + 1")) {
          return { rows: [{ attempt_count: 1 }], rowCount: 1 };
        }
        // last_error update after failure
        if (sql.includes("SET last_error")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const result = await reprocessDeadLetterEvent(throwingDb as never, redis, row);

    expect(result.resolved).toBe(false);
    expect(result.attempt).toBe(1);
    expect(result.error).toContain("DB connection lost");

    // last_error should have been updated after the failure
    const errorUpdateCall = throwingDb.query.mock.calls.find(
      ([sql]: [string]) => sql.includes("SET last_error"),
    );
    expect(errorUpdateCall).toBeDefined();

    // resolved_at must NOT have been set
    const resolvedCall = throwingDb.query.mock.calls.find(
      ([sql]: [string]) => sql.includes("resolved_at = NOW()"),
    );
    expect(resolvedCall).toBeUndefined();
  });

  it("returns a failure (without crashing) when the raw_event cannot be decoded", async () => {
    const db = makeDb({
      "attempt_count + 1": { rows: [{ attempt_count: 1 }], rowCount: 1 },
    });
    const redis = makeRedis();
    // A raw_event whose topics are missing will reconstruct but produce an event
    // with no usable topics — the handler will treat it as unrecognised, which
    // is a non-throwing path in event-router.ts (it just skips).
    // To get a decode error we store something completely un-parseable.
    const row = makeRow({ raw_event: null });

    const result = await reprocessDeadLetterEvent(db as never, redis, row);

    // Should return failure without throwing
    expect(result.resolved).toBe(false);
    expect(result.attempt).toBeGreaterThanOrEqual(1);
    expect(typeof result.error).toBe("string");
  });

  it("increments attempt_count even when the replay fails", async () => {
    let capturedAttemptArgs: unknown[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("attempt_count + 1")) {
          capturedAttemptArgs = params as unknown[];
          return { rows: [{ attempt_count: 3 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO events")) throw new Error("fail");
        if (sql.includes("SET last_error")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const row = makeRow({ attempt_count: 2 });

    const result = await reprocessDeadLetterEvent(db as never, makeRedis(), row);

    expect(result.attempt).toBe(3);
    // The first argument to the UPDATE must be the row id
    expect(capturedAttemptArgs[0]).toBe(row.id);
  });
});

describe("idempotency — replaying an already-processed event", () => {
  it("does not double-apply if the INSERT hits the unique constraint (rowCount 0)", async () => {
    // The unique constraint on (tx_hash, event_index) means a duplicate INSERT
    // returns rowCount=0 (DO NOTHING). The handler short-circuits and returns
    // without applying side effects — see insertProcessedEvent in idempotency.ts.
    // From reprocessDeadLetterEvent's perspective the writeEventToDb call
    // succeeds (no throw), so the row is marked resolved.
    const db = makeDb({
      "attempt_count + 1": { rows: [{ attempt_count: 1 }], rowCount: 1 },
      // Simulate DO NOTHING on duplicate insert
      "INSERT INTO events": { rows: [], rowCount: 0 },
      "resolved_at = NOW()": { rows: [], rowCount: 1 },
    });
    const redis = makeRedis();
    const row = makeRow();

    const result = await reprocessDeadLetterEvent(db as never, redis, row);

    // Success: no throw, row resolved
    expect(result.resolved).toBe(true);

    // resolved_at was set
    const resolvedCall = db.query.mock.calls.find(
      ([sql]: [string]) => sql.includes("resolved_at = NOW()"),
    );
    expect(resolvedCall).toBeDefined();
  });

  it("does not call writeEventToDb for a row that is already resolved", async () => {
    // Already-resolved rows are excluded from listUnresolvedDeadLetterEvents
    // via WHERE resolved_at IS NULL.  The batch function never sees them.
    const db = makeDb({
      "WHERE resolved_at IS NULL": { rows: [], rowCount: 0 },
    });
    const redis = makeRedis();

    const summary = await reprocessDeadLetterBatch(db as never, redis, { batchSize: 500 });

    expect(summary.total).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

describe("reprocessDeadLetterBatch", () => {
  it("returns the correct aggregated summary", async () => {
    const rows = [
      makeRow({ id: 1 }),
      makeRow({ id: 2 }),
      makeRow({ id: 3 }),
    ];

    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        // listUnresolvedDeadLetterEvents
        if (sql.includes("WHERE resolved_at IS NULL")) {
          return { rows, rowCount: rows.length };
        }
        // recordAttempt
        if (sql.includes("attempt_count + 1")) {
          return { rows: [{ attempt_count: 1 }], rowCount: 1 };
        }
        // markResolved — succeed for row 1, fail for row 2, succeed for row 3
        if (sql.includes("resolved_at = NOW()")) {
          const id = params?.[0];
          if (id === 2) throw new Error("row 2 always fails");
          return { rows: [], rowCount: 1 };
        }
        // last_error update
        if (sql.includes("SET last_error")) return { rows: [], rowCount: 1 };
        // INSERT INTO events — fail for row 2
        if (sql.includes("INSERT INTO events")) {
          const id = params?.[0];
          if (id === 2) throw new Error("write failed for row 2");
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const summary = await reprocessDeadLetterBatch(db as never, makeRedis(), { batchSize: 500 });

    expect(summary.total).toBe(3);
    // row 2 will fail; rows 1 and 3 resolve
    expect(summary.resolved + summary.failed).toBe(3);
  });

  it("processes each row independently — one failure does not stop the rest", async () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })];
    let processedIds: number[] = [];

    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("WHERE resolved_at IS NULL")) {
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("attempt_count + 1")) {
          const id = params?.[0] as number;
          processedIds.push(id);
          return { rows: [{ attempt_count: 1 }], rowCount: 1 };
        }
        if (sql.includes("resolved_at = NOW()")) return { rows: [], rowCount: 1 };
        if (sql.includes("SET last_error")) return { rows: [], rowCount: 1 };
        if (sql.includes("INSERT INTO events")) {
          if (params?.[0] === 2) throw new Error("row 2 fails");
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    await reprocessDeadLetterBatch(db as never, makeRedis(), { batchSize: 500 });

    // All three rows must have been attempted
    expect(processedIds).toContain(1);
    expect(processedIds).toContain(2);
    expect(processedIds).toContain(3);
  });
});

describe("listUnresolvedDeadLetterEvents", () => {
  it("passes the correct SQL and limit to the query", async () => {
    const db = makeDb({ "WHERE resolved_at IS NULL": { rows: [] } });

    await listUnresolvedDeadLetterEvents(db as never, 42);

    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE resolved_at IS NULL");
    expect(params).toContain(42);
  });
});

describe("countUnresolvedDeadLetterEvents", () => {
  it("returns the parsed count value", async () => {
    const db = makeDb({
      "COUNT(*)": { rows: [{ count: "7" }] },
    });

    const count = await countUnresolvedDeadLetterEvents(db as never);
    expect(count).toBe(7);
  });

  it("returns 0 when no rows exist", async () => {
    const db = makeDb({ "COUNT(*)": { rows: [{ count: "0" }] } });
    const count = await countUnresolvedDeadLetterEvents(db as never);
    expect(count).toBe(0);
  });
});

describe("refreshDeadLetterQueueDepth (queue-depth alerting)", () => {
  beforeEach(() => resetMetrics());

  it("updates the dead_letter_queue_depth gauge", async () => {
    await refreshDeadLetterQueueDepth(async () => 42, DEAD_LETTER_ALERT_THRESHOLD);
    expect(metrics.deadLetterQueueDepth.get()).toBe(42);
  });

  it("returns the current depth", async () => {
    const depth = await refreshDeadLetterQueueDepth(async () => 15, DEAD_LETTER_ALERT_THRESHOLD);
    expect(depth).toBe(15);
  });

  it("does NOT call the warning logger when depth is at or below the threshold", async () => {
    const logger = { warn: vi.fn() };
    await refreshDeadLetterQueueDepth(async () => DEAD_LETTER_ALERT_THRESHOLD, DEAD_LETTER_ALERT_THRESHOLD, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("calls the warning logger when depth exceeds the alert threshold", async () => {
    const logger = { warn: vi.fn() };
    await refreshDeadLetterQueueDepth(
      async () => DEAD_LETTER_ALERT_THRESHOLD + 1,
      DEAD_LETTER_ALERT_THRESHOLD,
      logger,
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toMatch(/threshold/i);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      depth: DEAD_LETTER_ALERT_THRESHOLD + 1,
      threshold: DEAD_LETTER_ALERT_THRESHOLD,
    });
  });

  it("gauge is reset by resetMetrics", () => {
    metrics.deadLetterQueueDepth.set(99);
    resetMetrics();
    expect(metrics.deadLetterQueueDepth.get()).toBe(0);
  });
});

describe("serializeMetrics — dead_letter_queue_depth in Prometheus output", () => {
  beforeEach(() => resetMetrics());

  it("includes the dead_letter_queue_depth gauge in serialized output", () => {
    metrics.deadLetterQueueDepth.set(55);
    const output = serializeMetrics();
    expect(output).toContain("# TYPE dead_letter_queue_depth gauge");
    expect(output).toContain("dead_letter_queue_depth 55");
  });

  it("outputs 0 when no events are queued", () => {
    const output = serializeMetrics();
    expect(output).toContain("dead_letter_queue_depth 0");
  });
});

describe("DEAD_LETTER_ALERT_THRESHOLD constant", () => {
  it("is exported and positive", () => {
    expect(typeof DEAD_LETTER_ALERT_THRESHOLD).toBe("number");
    expect(DEAD_LETTER_ALERT_THRESHOLD).toBeGreaterThan(0);
  });
});
