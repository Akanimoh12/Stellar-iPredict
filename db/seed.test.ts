import { describe, expect, it, vi } from "vitest";

import { runSeed } from "./seed";

describe("runSeed", () => {
  it("uses transaction and conflict-safe inserts", async () => {
    const query = vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(
      async () => ({})
    );

    await runSeed({ query });

    expect(query).toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const allSql = query.mock.calls
      .map((call) => String(call[0]))
      .join("\n");

    expect(allSql).toContain("CREATE TABLE IF NOT EXISTS markets");
    expect(allSql).toContain("CREATE TABLE IF NOT EXISTS bets");
    expect(allSql).toContain("CREATE TABLE IF NOT EXISTS leaderboard");
    expect(allSql).toContain("CREATE TABLE IF NOT EXISTS oracle_submissions");
    expect(allSql).toContain("CREATE TABLE IF NOT EXISTS oracle_disputes");
    expect(allSql).toContain("CREATE TABLE IF NOT EXISTS council_votes");
    expect(allSql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(allSql).toContain("ON CONFLICT (market_id, bettor) DO UPDATE");
    expect(allSql).toContain("ON CONFLICT (address) DO UPDATE");
    expect(allSql).toContain("ON CONFLICT (market_id) DO UPDATE");
    expect(allSql).toContain("ON CONFLICT (market_id, member) DO UPDATE");
  });

  it("rolls back on error", async () => {
    let call = 0;
    const query = vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async (sql: string) => {
      call += 1;
      if (call === 3) {
        throw new Error("boom");
      }
      return { sql };
    });

    await expect(runSeed({ query })).rejects.toThrow("boom");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});