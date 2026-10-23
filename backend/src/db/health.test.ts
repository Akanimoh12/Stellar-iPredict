import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pool.js", () => ({
  getClient: vi.fn(),
  pool: { query: vi.fn() },
}));

import { checkWriteCapability, withHealthTimeout } from "./health.js";
import { getClient } from "./pool.js";

const getClientMock = vi.mocked(getClient);

beforeEach(() => {
  getClientMock.mockReset();
});

describe("checkWriteCapability", () => {
  it("checks persistent write permission in a transaction that rolls back", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    };
    getClientMock.mockResolvedValue(client as never);

    const result = await checkWriteCapability();

    expect(result).toMatchObject({ ok: true, readOnly: false });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "UPDATE markets SET updated_at = updated_at WHERE FALSE",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("identifies a read-only database", async () => {
    const readOnlyError = Object.assign(
      new Error("cannot execute UPDATE in a read-only transaction"),
      { code: "25006" },
    );
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("UPDATE")) throw readOnlyError;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    getClientMock.mockResolvedValue(client as never);

    const result = await checkWriteCapability();

    expect(result).toMatchObject({ ok: false, readOnly: true });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "UPDATE markets SET updated_at = updated_at WHERE FALSE",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("distinguishes an unavailable database from a read-only database", async () => {
    getClientMock.mockRejectedValue(
      Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    );

    await expect(checkWriteCapability()).resolves.toMatchObject({
      ok: false,
      readOnly: false,
    });
  });
});

describe("withHealthTimeout", () => {
  it("resolves with the check's result when it finishes before the timeout", async () => {
    const result = await withHealthTimeout(Promise.resolve({ ok: true, latencyMs: 1 }), 50);
    expect(result).toEqual({ ok: true, latencyMs: 1 });
  });

  it("resolves unhealthy once the timeout elapses, without waiting on the hung check", async () => {
    const hung = new Promise<{ ok: boolean }>(() => {});
    const result = await withHealthTimeout(hung as Promise<any>, 20);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
