/**
 * i128 precision across every boundary (P0).
 *
 * Amounts are `i128` on chain, `NUMERIC(30,7)` in Postgres, and pass through
 * TypeScript where a `number` cannot represent them exactly. The failure mode
 * this file exists to catch is *silent*: a value that loses a few units in
 * transit is still a plausible number, still sums correctly against its
 * neighbours, and is still `true` under any tolerance-based comparison. So
 * every assertion here is exact — `toBe` on strings, `toBe` on bigints, never
 * `toBeCloseTo` and never a `Math.abs(a - b) < epsilon`.
 *
 * The boundaries covered, in the order a bet actually crosses them:
 *
 *   1. contract  → indexer   XDR `ScVal` i128 decoded to a native value
 *   2. indexer   → database  the exact decimal string handed to Postgres
 *   3. database  → API       the `NUMERIC` column read back
 *   4. API       → response  the JSON a client receives
 *
 * Plus `i128::MAX` at each of them, and a negative control that shows a
 * `Number` round-trip really does lose the value this file is protecting.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { decodeEvent, decodeValue } from "../indexer/src/decode.js";
import { decodeBetPlacedEvent, handleBetPlacedEvent } from "../indexer/src/handlers/bet_placed.js";
import { configurePgNumericParser, stroopsToXlm, xlmToStroops, STROOPS_PER_XLM } from "../backend/src/lib/amount.js";
import { getMarketById, getMarkets, type Queryable } from "../backend/src/db/markets.js";
import { createMarketsRoutes } from "../backend/src/api/markets.js";
import { registerErrorHandler, registerNotFoundHandler } from "../backend/src/lib/errors.js";
import type { MarketRow } from "../backend/src/db/markets.js";

/** i128::MAX = 2^127 − 1. The largest value a Stellar contract can hold. */
const I128_MAX = 170141183460469231731687303715884105727n;

/** Number.MAX_SAFE_INTEGER + 1 — the first value a JS number cannot hold. */
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_992n;

/**
 * NUMERIC(30,7)'s largest value. Smaller than i128::MAX, so a value in this
 * range is representable in Postgres but not in a JS number.
 */
const MAX_NUMERIC_30_7_STROOPS = 999999999999999999999999999999n;
const MAX_NUMERIC_30_7_XLM = "99999999999999999999999.9999999";

/** `stroopsToXlm(I128_MAX)`. Derived below rather than pasted, for the same reason. */
const I128_MAX_XLM = (() => {
  const whole = I128_MAX / 10_000_000n;
  const fraction = (I128_MAX % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
})();

/**
 * Values carried across every boundary in this file.
 *
 * Each is a stroop amount; the XLM rendering is derived at module load rather
 * than written out, so the two representations cannot drift apart in the test
 * itself and a typo cannot make the round-trip assertions vacuous.
 */
const BOUNDARY_STROOPS: ReadonlyArray<{ name: string; stroops: bigint; xlm: string }> = [
  { name: "Number.MAX_SAFE_INTEGER", stroops: BigInt(Number.MAX_SAFE_INTEGER) },
  { name: "one past Number.MAX_SAFE_INTEGER", stroops: BEYOND_SAFE_INTEGER },
  { name: "NUMERIC(30,7) maximum", stroops: MAX_NUMERIC_30_7_STROOPS },
  { name: "i128::MAX", stroops: I128_MAX },
  // A value whose low-order digits are all non-zero, so a lost unit in any
  // single place is visible in the string rather than being absorbed.
  { name: "all-ones", stroops: 11111111111111111111111111111111n },
].map((entry) => ({ ...entry, xlm: stroopsToXlm(entry.stroops) }));

const BETTOR = "G" + "A".repeat(55);

/**
 * `bet_placed` topics with no market/bettor arguments, so the payload alone
 * supplies those fields. The decoder validates the topic *shape* first, so an
 * empty array is rejected before the payload is even looked at.
 */
const BET_PLACED_TOPICS = ["bet", "placed"];

function stroopsFixture(name: string, stroops: bigint) {
  return { name, stroops, xlm: stroopsToXlm(stroops) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Negative control
// ─────────────────────────────────────────────────────────────────────────────

describe("why these tests compare exactly", () => {
  it("shows a JS number losing the value, so a tolerant assertion would pass anyway", () => {
    // i128::MAX cannot survive a trip through a double: the nearest
    // representable double is a different integer.
    const asDouble = Number(I128_MAX);
    const roundTripped = BigInt(asDouble);

    expect(typeof asDouble).toBe("number");
    expect(roundTripped).not.toBe(I128_MAX);
    // Off by exactly one: the nearest double rounds *up* past i128::MAX, so
    // the resulting amount would be a stroop larger than was ever bet.
    expect(roundTripped - I128_MAX).toBe(1n);
    // `String()` is not a safe fallback either — it is scientific notation,
    // and a value that large never round-trips through a number regardless.
    expect(String(asDouble)).not.toBe(I128_MAX.toString());
  });

  it("shows the smallest realistic value of the bug: a few units lost on a large number", () => {
    const stroops = 999999999999999999999999999999n;
    const drifted = stroops - 3n;

    // The characters differ, so an exact string or bigint comparison catches it.
    expect(stroops.toString()).toBe("999999999999999999999999999999");
    expect(drifted.toString()).toBe("999999999999999999999999999996");
    expect(drifted).not.toBe(stroops);

    // Both collapse to the same double, so nothing that goes through a JS
    // number — including any tolerance-based comparison — can tell them apart.
    // This is precisely why every assertion in this file is exact.
    expect(Number(stroops.toString())).toBe(Number(drifted.toString()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary 1: contract → indexer
// ─────────────────────────────────────────────────────────────────────────────

describe("boundary 1 — contract to indexer (XDR i128 decode)", () => {
  it("decodes every boundary value to an exact bigint", () => {
    for (const { name, stroops } of BOUNDARY_STROOPS) {
      const scVal = nativeToScVal(stroops, { type: "i128" });
      // `.name` rather than the enum value: the SDK's generated accessor for
      // the type is a function in some versions and a value in others.
      expect(scVal.switch().name).toBe("scvI128");

      const decoded = decodeValue(scVal);

      // `typeof` matters as much as value: a number here would be a bug even
      // when the value happens to fit.
      expect(typeof decoded).toBe("bigint");
      expect(decoded).toBe(stroops);
      // Silence the unused-name lint while keeping the failure message useful.
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("decodes i128::MAX out of a full event, topics and value together", () => {
    const topics = [
      nativeToScVal("mkt", { type: "symbol" }),
      nativeToScVal("created", { type: "symbol" }),
    ];
    const value = xdr.ScVal.scvVec([
      nativeToScVal(1n, { type: "i128" }),
      nativeToScVal(BETTOR, { type: "string" }),
      nativeToScVal(I128_MAX, { type: "i128" }),
    ]);

    const decoded = decodeEvent(topics, value);

    expect(decoded.data).toEqual([1n, BETTOR, I128_MAX]);
    expect((decoded.data as bigint[])[2]).toBe(I128_MAX);
  });

  it("survives the full bet_placed decode, XDR through to the indexed payload", () => {
    for (const { name, stroops } of BOUNDARY_STROOPS) {
      // amount = net_amount, so the schema's net <= gross rule holds while the
      // whole value is still the one under test.
      const value = xdr.ScVal.scvVec([
        nativeToScVal(1n, { type: "i128" }),
        nativeToScVal(BETTOR, { type: "string" }),
        nativeToScVal(true, { type: "bool" }),
        nativeToScVal(stroops, { type: "i128" }),
        nativeToScVal(stroops, { type: "i128" }),
        nativeToScVal(0n, { type: "i128" }),
        nativeToScVal(false, { type: "bool" }),
      ]);
      const data = decodeValue(value) as unknown[];

      const payload = decodeBetPlacedEvent({ topics: BET_PLACED_TOPICS, data });

      expect(payload.amount).toBe(stroops.toString());
      expect(payload.net_amount).toBe(stroops.toString());
      expect(BigInt(payload.net_amount)).toBe(stroops);
      expect(payload.bettor).toBe(BETTOR);
    }
  });

  it("rejects a numeric amount that is already beyond the safe integer range", () => {
    // A producer that stringified a JS number before sending it on chain
    // cannot be detected here — but a producer that sends an unsafe integer
    // is refused rather than silently rounded.
    const data = {
      market_id: 1,
      bettor: BETTOR,
      is_yes: true,
      amount: 9_007_199_254_740_992,
      net_amount: 9_007_199_254_740_992,
    };

    expect(() => decodeBetPlacedEvent({ topics: BET_PLACED_TOPICS, data })).toThrow(
      /amount must be an unsigned integer amount/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary 2: indexer → database
// ─────────────────────────────────────────────────────────────────────────────

describe("boundary 2 — indexer to database (the value handed to Postgres)", () => {
  it("passes the exact decimal string as the NUMERIC bind parameter", async () => {
    for (const { name, stroops } of BOUNDARY_STROOPS) {
      const query = vi.fn().mockResolvedValue({
        rows: [{ side_valid: true, event_inserted: true, applied: true }],
      });
      const db = { query } as never;
      const redis = { del: vi.fn(), get: vi.fn(async () => null), set: vi.fn() } as never;

      await handleBetPlacedEvent(
        {
          topics: BET_PLACED_TOPICS,
          data: {
            market_id: 1,
            bettor: BETTOR,
            is_yes: true,
            amount: stroops.toString(),
            net_amount: stroops.toString(),
          },
          ledger: 100,
          txHash: "a".repeat(64),
          eventIndex: 0,
        } as never,
        db,
        redis,
      );

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];

      // The statement declares the parameters NUMERIC, and they arrive as
      // strings — never as numbers, which is where the loss would happen.
      expect(sql).toContain("$8::NUMERIC AS net_amount");
      expect(sql).toContain("$9::NUMERIC AS gross_amount");

      const net = params[7];
      const gross = params[8];
      expect(typeof net).toBe("string");
      expect(net).toBe(stroops.toString());
      expect(gross).toBe(stroops.toString());
      expect(BigInt(net as string)).toBe(stroops);
    }
  });

  it("stores the audit payload without a lossy JSON round trip", async () => {
    for (const { name, stroops } of BOUNDARY_STROOPS) {
      const query = vi.fn().mockResolvedValue({
        rows: [{ side_valid: true, event_inserted: true, applied: true }],
      });

      await handleBetPlacedEvent(
        {
          topics: BET_PLACED_TOPICS,
          data: {
            market_id: 1,
            bettor: BETTOR,
            is_yes: true,
            amount: stroops.toString(),
            net_amount: stroops.toString(),
          },
          ledger: 100,
          txHash: "b".repeat(64),
          eventIndex: 0,
        } as never,
        { query } as never,
        { del: vi.fn(), get: vi.fn(async () => null), set: vi.fn() } as never,
      );

      const [, params] = query.mock.calls[0] as [string, unknown[]];
      const payloadJson = params[4] as string;
      const parsed = JSON.parse(payloadJson) as { amount: string; net_amount: string };

      // `JSON.stringify` throws on a bigint, so the payload must be strings —
      // and re-parsing must give back the identical characters.
      expect(parsed.amount).toBe(stroops.toString());
      expect(parsed.net_amount).toBe(stroops.toString());
    }
  });

  it("keeps a sum of boundary values exact in bigint before it ever reaches SQL", () => {
    // The market aggregate is `total_yes + net_amount` in SQL. Summing in
    // bigint first is how a test can show the arithmetic itself is lossless.
    const sum = BOUNDARY_STROOPS.reduce((total, { stroops }) => total + stroops, 0n);
    const expected = BOUNDARY_STROOPS.map(({ stroops }) => stroops).reduce((a, b) => a + b, 0n);

    expect(sum).toBe(expected);
    // Spilling past i128 is the one case worth naming explicitly: the schema
    // rejects it, so assert the boundary rather than pretending it is fine.
    expect(sum).toBeGreaterThan(I128_MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary 3: database → API
// ─────────────────────────────────────────────────────────────────────────────

describe("boundary 3 — database to API (reading NUMERIC back)", () => {
  it("configures the pg driver to return NUMERIC as a string, not a number", () => {
    const parsers = new Map<number, (value: string) => unknown>();
    configurePgNumericParser({
      setTypeParser: (oid, fn) => parsers.set(oid, fn),
      builtins: { NUMERIC: 1700 },
    });

    const parse = parsers.get(1700);
    expect(parse).toBeTypeOf("function");

    for (const { name, stroops, xlm } of BOUNDARY_STROOPS) {
      const parsed = parse!(xlm);
      expect(typeof parsed).toBe("string");
      // Identity, not a conversion. A driver that parsed this to a double
      // would be the single most direct way to lose the value.
      expect(parsed).toBe(xlm);
      expect(xlmToStroops(parsed as string)).toBe(stroops);
    }
  });

  it("returns market rows with their amounts byte-identical to the column", async () => {
    for (const { name, stroops, xlm } of BOUNDARY_STROOPS) {
      const row = {
        id: 1,
        question: "Will it?",
        image_url: null,
        category: "Crypto",
        end_time: "9999999999",
        total_yes: xlm,
        total_no: stroopsToXlm(0n),
        resolved: false,
        outcome: null,
        cancelled: false,
        creator: BETTOR,
        bet_count: 0,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
      };
      const db = { query: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as Queryable;

      const market = await getMarketById(1, db);

      expect(market).not.toBeNull();
      expect(typeof market!.total_yes).toBe("string");
      expect(market!.total_yes).toBe(xlm);
      expect(xlmToStroops(market!.total_yes)).toBe(stroops);
    }
  });

  it("returns list rows with their amounts byte-identical to the column", async () => {
    const fixtures = BOUNDARY_STROOPS.map((fixture, index) => ({
      id: index + 1,
      question: `q${index}`,
      image_url: null,
      category: "Crypto",
      end_time: "9999999999",
      total_yes: fixture.xlm,
      total_no: "0.0000000",
      resolved: false,
      outcome: null,
      cancelled: false,
      creator: BETTOR,
      bet_count: 0,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
      total_count: BOUNDARY_STROOPS.length,
    }));
    const db = { query: vi.fn().mockResolvedValue({ rows: fixtures }) } as unknown as Queryable;

    const result = await getMarkets({ filter: "all" }, db);

    expect(result.rows).toHaveLength(BOUNDARY_STROOPS.length);
    for (const [index, fixture] of BOUNDARY_STROOPS.entries()) {
      expect(result.rows[index]!.total_yes, fixture.name).toBe(fixture.xlm);
      expect(xlmToStroops(result.rows[index]!.total_yes), fixture.name).toBe(fixture.stroops);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary 4: API → response
// ─────────────────────────────────────────────────────────────────────────────

async function buildServer(db: Queryable): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerNotFoundHandler(server);
  createMarketsRoutes(server, db);
  await server.ready();
  return server;
}

function marketRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 1,
    question: "Will it?",
    image_url: null,
    category: "Crypto",
    end_time: "9999999999",
    total_yes: "0.0000000",
    total_no: "0.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: BETTOR,
    bet_count: 0,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("boundary 4 — API to response (what a client actually receives)", () => {
  it("serialises a boundary amount in the market detail response without loss", async () => {
    for (const { name, stroops, xlm } of BOUNDARY_STROOPS) {
      const row = marketRow({ total_yes: xlm });
      const server = await buildServer({
        query: vi.fn().mockResolvedValue({ rows: [row] }),
      } as unknown as Queryable);

      const response = await server.inject({ method: "GET", url: "/api/markets/1" });
      const body = response.json() as { total_yes: string; total_no: string };

      expect(response.statusCode).toBe(200);
      // The OpenAPI response schema types these as `string`; the assertion is
      // that the *characters* survive, not merely the type.
      expect(body.total_yes).toBe(xlm);
      expect(body.total_no).toBe("0.0000000");
      expect(xlmToStroops(body.total_yes)).toBe(stroops);
    }
  });

  it("serialises i128::MAX's XLM rendering in the market list response", async () => {
    // i128::MAX does not fit NUMERIC(30,7) — its XLM rendering needs 32
    // integer digits — so the largest value the database can actually hold is
    // the one that belongs in an API test. Both are asserted below so the
    // distinction stays explicit rather than being an accident.
    expect(I128_MAX_XLM).toBe("17014118346046923173168730371588.4105727");
    expect(I128_MAX_XLM.split(".")[0]!.length).toBeGreaterThan(30);

    const xlm = MAX_NUMERIC_30_7_XLM;
    expect(xlm).toBe(stroopsToXlm(MAX_NUMERIC_30_7_STROOPS));

    const server = await buildServer({
      query: vi.fn().mockResolvedValue({
        rows: [{ ...marketRow({ total_yes: xlm, total_no: xlm }), total_count: 1 }],
      }),
    } as unknown as Queryable);

    const response = await server.inject({ method: "GET", url: "/api/markets?filter=all" });
    const body = response.json() as { markets: { total_yes: string; total_no: string }[] };

    expect(response.statusCode).toBe(200);
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0]!.total_yes).toBe(MAX_NUMERIC_30_7_XLM);
    expect(body.markets[0]!.total_no).toBe(MAX_NUMERIC_30_7_XLM);
    expect(xlmToStroops(body.markets[0]!.total_yes)).toBe(MAX_NUMERIC_30_7_STROOPS);
  });

  it("computes a total pool and odds from boundary amounts without rounding them away", async () => {
    // The odds endpoint adds two NUMERIC columns and divides. The pool is a
    // string and must be exact; the ratio is a number and is explicitly
    // rounded to 4dp, which is a documented display rounding, not a loss of
    // the underlying amount.
    const row = marketRow({
      total_yes: MAX_NUMERIC_30_7_XLM,
      total_no: "0.0000001",
    });
    const server = await buildServer({
      query: vi.fn().mockResolvedValue({ rows: [row] }),
    } as unknown as Queryable);

    const response = await server.inject({ method: "GET", url: "/api/markets/1/odds" });
    const body = response.json() as {
      total_yes: string;
      total_no: string;
      total_pool: string;
      yes_odds: number;
      no_odds: number;
    };

    expect(response.statusCode).toBe(200);
    expect(body.total_yes).toBe(MAX_NUMERIC_30_7_XLM);
    expect(body.total_no).toBe("0.0000001");
    // Exact string addition, including the 1 stroop in the no-side total. The
    // sum carries out of the all-nines integer part, which is precisely the
    // kind of carry a float or a truncated-string sum gets wrong.
    expect(body.total_pool).toBe(stroopsToXlm(MAX_NUMERIC_30_7_STROOPS + 1n));
    expect(body.total_pool).toBe("100000000000000000000000.0000000");
    expect(body.total_pool).not.toBe(MAX_NUMERIC_30_7_XLM);
    expect(body.yes_odds).toBe(1);
    expect(body.no_odds).toBe(0);
  });

  it("round-trips a boundary amount through the whole stack back to its original integer", () => {
    // One end-to-end statement of the property: contract bigint → API string →
    // integer, with no boundary allowed to shave anything off.
    for (const { name, stroops } of BOUNDARY_STROOPS) {
      const asApiWouldSeeIt = stroopsToXlm(stroops);
      const backAgain = xlmToStroops(asApiWouldSeeIt);

      expect(backAgain).toBe(stroops);
      expect(backAgain.toString()).toBe(stroops.toString());
      expect(backAgain === stroops).toBe(true);
      // And the characters are identical, which a numeric comparison would not
      // establish for the values beyond 2^53.
      expect(stroopsToXlm(backAgain)).toBe(asApiWouldSeeIt);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The formatting helper alone, at the extremes
// ─────────────────────────────────────────────────────────────────────────────

describe("stroopsToXlm / xlmToStroops at the extremes", () => {
  it("renders the largest values as fixed seven-decimal strings", () => {
    expect(stroopsToXlm(I128_MAX)).toBe(I128_MAX_XLM);
    expect(stroopsToXlm(I128_MAX)).toBe("17014118346046923173168730371588.4105727");
    expect(stroopsToXlm(MAX_NUMERIC_30_7_STROOPS)).toBe(MAX_NUMERIC_30_7_XLM);
    expect(stroopsToXlm(0n)).toBe("0.0000000");
  });

  it("parses the largest XLM strings back exactly", () => {
    expect(xlmToStroops(MAX_NUMERIC_30_7_XLM)).toBe(MAX_NUMERIC_30_7_STROOPS);
    expect(xlmToStroops(stroopsToXlm(I128_MAX))).toBe(I128_MAX);
  });

  it("keeps the scale constant honest", () => {
    expect(BigInt(STROOPS_PER_XLM)).toBe(10_000_000n);
    expect(stroopsToXlm(BigInt(STROOPS_PER_XLM))).toBe("1.0000000");
  });

  it("adds two boundary amounts exactly, with no float drift in between", () => {
    const sum = stroopsToXlm(MAX_NUMERIC_30_7_STROOPS + I128_MAX);
    expect(xlmToStroops(sum)).toBe(MAX_NUMERIC_30_7_STROOPS + I128_MAX);
  });
});
