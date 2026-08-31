import { describe, expect, it, vi } from "vitest";

import { runSeed } from "../seed";

type QueryCall = { sql: string; values?: unknown[] };

/**
 * Runs the seed against a recording mock and returns every INSERT call
 * (SQL + bound values) so tests can assert the exact rows produced.
 */
async function captureInserts(): Promise<QueryCall[]> {
  const inserts: QueryCall[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.trimStart().startsWith("INSERT")) {
      inserts.push({ sql, values });
    }
    return {};
  });

  await runSeed({ query });
  return inserts;
}

describe("seed data verification", () => {
  it("inserts the expected number of markets, bets, and leaderboard rows", async () => {
    const inserts = await captureInserts();

    const marketInserts = inserts.filter((c) =>
      c.sql.includes("INSERT INTO markets"),
    );
    const betInserts = inserts.filter((c) => c.sql.includes("INSERT INTO bets"));
    const leaderboardInserts = inserts.filter((c) =>
      c.sql.includes("INSERT INTO leaderboard"),
    );

    expect(marketInserts).toHaveLength(3);
    expect(betInserts).toHaveLength(4);
    expect(leaderboardInserts).toHaveLength(3);
  });

  it("produces the expected market rows", async () => {
    const inserts = await captureInserts();
    const marketInserts = inserts.filter((c) =>
      c.sql.includes("INSERT INTO markets"),
    );

    const rows = marketInserts.map((c) => c.values);

    expect(rows).toEqual([
      [
        1,
        "Will XLM close above $0.20 by Dec 31, 2026?",
        null,
        "Crypto",
        1798675200,
        "1200.0000000",
        "800.0000000",
        false,
        null,
        false,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        3,
      ],
      [
        2,
        "Will Team Alpha win the championship final?",
        null,
        "Sports",
        1788206400,
        "650.0000000",
        "900.0000000",
        false,
        null,
        false,
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        2,
      ],
      [
        3,
        "Will Candidate Z win the 2026 election?",
        null,
        "Politics",
        1790966400,
        "1500.0000000",
        "1400.0000000",
        true,
        true,
        false,
        "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        4,
      ],
    ]);
  });

  it("produces the expected bet rows", async () => {
    const inserts = await captureInserts();
    const betInserts = inserts.filter((c) => c.sql.includes("INSERT INTO bets"));

    const rows = betInserts.map((c) => c.values);

    expect(rows).toEqual([
      [1, "GUSER00000000000000000000000000000000000000000000000001", "350.0000000", "357.0000000", true, false],
      [1, "GUSER00000000000000000000000000000000000000000000000002", "500.0000000", "510.0000000", false, false],
      [2, "GUSER00000000000000000000000000000000000000000000000003", "400.0000000", "408.0000000", true, false],
      [3, "GUSER00000000000000000000000000000000000000000000000004", "900.0000000", "918.0000000", true, true],
    ]);
  });

  it("produces the expected leaderboard rows", async () => {
    const inserts = await captureInserts();
    const leaderboardInserts = inserts.filter((c) =>
      c.sql.includes("INSERT INTO leaderboard"),
    );

    const rows = leaderboardInserts.map((c) => c.values);

    expect(rows).toEqual([
      ["GUSER00000000000000000000000000000000000000000000000001", "alpha_whale", 120, 3, 1],
      ["GUSER00000000000000000000000000000000000000000000000002", "beta_oracle", 95, 2, 2],
      ["GUSER00000000000000000000000000000000000000000000000003", "gamma_punter", 70, 1, 2],
    ]);
  });

  it("is deterministic across repeated runs", async () => {
    const first = await captureInserts();
    const second = await captureInserts();

    expect(first).toEqual(second);
  });
});
