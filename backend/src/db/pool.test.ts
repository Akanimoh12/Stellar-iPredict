/**
 * Tests for queryWithCancel (#475).
 *
 * These exercise the cancellation mechanism against a fake pg-Pool-shaped
 * object rather than a real Postgres connection: we don't have a database
 * in this test environment, and the whole point of `queryWithCancel` is
 * decoupled from any particular SQL — it only cares about (a) discovering
 * the backend pid before the real query starts and (b) issuing
 * `pg_cancel_backend` on a *different* connection when the signal aborts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryWithCancel,
  QueryCancelledError,
  type CancellablePool,
} from "./pool.js";
import {
  getAbandonedQueryCounts,
  resetAbandonedQueryCounts,
} from "../metrics.js";

/** A fake single connection: resolves pg_backend_pid, then hangs on the
 * "real" query until the test decides to resolve or reject it. */
function createFakeClient(pid: number) {
  let resolveQuery!: (value: { rows: unknown[] }) => void;
  let rejectQuery!: (err: unknown) => void;

  const queryCalls: string[] = [];

  const client = {
    query: vi.fn(async (text: string) => {
      queryCalls.push(text);
      if (text === "SELECT pg_backend_pid() AS pid") {
        return { rows: [{ pid }] };
      }
      // The "real" query — held open until the test settles it.
      return new Promise((resolve, reject) => {
        resolveQuery = resolve;
        rejectQuery = reject;
      });
    }),
    release: vi.fn(),
  };

  return {
    client,
    queryCalls,
    settle: () => resolveQuery({ rows: [{ ok: true }] }),
    fail: (err: unknown) => rejectQuery(err),
  };
}

function createFakePool(fakeClient: { client: unknown }) {
  const cancelCalls: unknown[][] = [];
  const pool: CancellablePool = {
    connect: vi.fn(async () => fakeClient.client as never),
    query: vi.fn(async (text: string, params?: unknown[]) => {
      cancelCalls.push([text, params]);
      return { rows: [] } as never;
    }),
  };
  return { pool, cancelCalls };
}

describe("queryWithCancel", () => {
  beforeEach(() => {
    resetAbandonedQueryCounts();
  });

  it("resolves normally and never touches pg_cancel_backend when the signal never aborts", async () => {
    const fake = createFakeClient(111);
    const { pool, cancelCalls } = createFakePool(fake);
    const controller = new AbortController();

    const promise = queryWithCancel(pool, "SELECT 1", [], {
      signal: controller.signal,
      route: "GET /api/markets",
    });

    // Let the pid lookup happen, then resolve the real query.
    await flushMicrotasks();
    fake.settle();

    const result = await promise;
    expect(result.rows).toEqual([{ ok: true }]);
    expect(cancelCalls).toHaveLength(0);
    expect(getAbandonedQueryCounts()).toEqual([]);
  });

  it("issues pg_cancel_backend on a separate connection and rejects with QueryCancelledError when the client disconnects", async () => {
    const fake = createFakeClient(222);
    const { pool, cancelCalls } = createFakePool(fake);
    const controller = new AbortController();

    const promise = queryWithCancel(pool, "SELECT pg_sleep(30)", [], {
      signal: controller.signal,
      route: "GET /api/markets/:id",
    });

    // Let the pid lookup resolve before the client disconnects.
    await flushMicrotasks();

    controller.abort();
    await flushMicrotasks();

    // Postgres would eventually kill the statement; simulate that error.
    fake.fail(new Error("canceling statement due to user request"));

    await expect(promise).rejects.toBeInstanceOf(QueryCancelledError);

    expect(cancelCalls).toEqual([["SELECT pg_cancel_backend($1)", [222]]]);
    expect(getAbandonedQueryCounts()).toEqual([
      { route: "GET /api/markets/:id", count: 1 },
    ]);
  });

  it("rejects immediately without connecting when the signal is already aborted", async () => {
    const fake = createFakeClient(333);
    const { pool } = createFakePool(fake);
    const controller = new AbortController();
    controller.abort();

    await expect(
      queryWithCancel(pool, "SELECT 1", [], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(QueryCancelledError);

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("passes non-cancellation errors through untouched", async () => {
    const fake = createFakeClient(444);
    const { pool, cancelCalls } = createFakePool(fake);
    const controller = new AbortController();

    const promise = queryWithCancel(pool, "SELECT 1", [], {
      signal: controller.signal,
    });

    await flushMicrotasks();
    fake.fail(new Error("syntax error"));

    await expect(promise).rejects.toThrow("syntax error");
    expect(cancelCalls).toHaveLength(0);
  });

  it("releases the client even when the query is cancelled", async () => {
    const fake = createFakeClient(555);
    const { pool } = createFakePool(fake);
    const controller = new AbortController();

    const promise = queryWithCancel(pool, "SELECT 1", [], {
      signal: controller.signal,
    });

    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    fake.fail(new Error("canceled"));

    await expect(promise).rejects.toBeInstanceOf(QueryCancelledError);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
