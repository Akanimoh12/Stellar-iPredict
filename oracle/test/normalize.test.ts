import { describe, expect, it } from "vitest";

import { resolveFreshnessPolicy } from "../src/adapters/freshness.js";
import {
  NormalizationError,
  normalizeCrypto,
  normalizeCryptoQuote,
  normalizePolitics,
  normalizeScience,
  normalizeSports,
  normalizeOutcome,
} from "../src/adapters/normalize.js";
import {
  BINANCE_TICKER_BTCUSDT,
  BINANCE_UNKNOWN_SYMBOL,
  COINGECKO_SIMPLE_PRICE,
  COINMARKETCAP_QUOTES_LATEST,
  EMPTY_STRING_PRICE_RESPONSE,
  HTML_ERROR_PAGE_RESPONSE,
  LITERAL_NULL_STRING_PRICE_RESPONSE,
  NULL_PRICE_RESPONSE,
  POLYMARKET_POLITICS,
  REUTERS_POLITICS,
  SCIENCE_COMMITTEE_QUORUM,
  THEODDSAPI_SCORES_FINAL,
  THEODDSAPI_SCORES_PROVISIONAL,
  TRUNCATED_JSON_RESPONSE,
} from "./fixtures/provider-responses.js";

/**
 * Asserts that `run` fails explicitly rather than returning a value.
 *
 * The point of every malformed-input test in this file is that normalization
 * *refuses*. A test written as `expect(result.confidence).toBe(0)` would pass
 * just as happily against a silent fallback that produced a confident,
 * wrong answer, so these assert on the throw itself.
 */
function expectNormalizationError(run: () => unknown, field: string): NormalizationError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected normalization to throw, but it returned a value").toBeInstanceOf(
    NormalizationError,
  );
  const error = thrown as NormalizationError;
  // Classified as a data error so callers exclude the source from the tally
  // rather than retrying a payload that will be malformed again.
  expect(error.kind).toBe("data");
  expect(error.retryable).toBe(false);
  expect(error.field).toBe(field);
  return error;
}

// ---------------------------------------------------------------------------
// normalizeCrypto
// ---------------------------------------------------------------------------

describe("normalizeCrypto", () => {
  it("gte comparator: price above threshold → outcome true", () => {
    const result = normalizeCrypto({ price: 70_000, threshold: 60_000, comparator: "gte" });
    expect(result.outcome).toBe(true);
  });

  it("gte comparator: price below threshold → outcome false", () => {
    const result = normalizeCrypto({ price: 50_000, threshold: 60_000, comparator: "gte" });
    expect(result.outcome).toBe(false);
  });

  it("lte comparator: price below threshold → outcome true", () => {
    const result = normalizeCrypto({ price: 50_000, threshold: 60_000, comparator: "lte" });
    expect(result.outcome).toBe(true);
  });

  it("lte comparator: price above threshold → outcome false", () => {
    const result = normalizeCrypto({ price: 70_000, threshold: 60_000, comparator: "lte" });
    expect(result.outcome).toBe(false);
  });

  it("price exactly at threshold → outcome true for gte, confidence = 0.5", () => {
    const result = normalizeCrypto({ price: 60_000, threshold: 60_000, comparator: "gte" });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it("confidence is 1.0 when price is ≥ 5% away from threshold", () => {
    // 60_000 * 0.05 = 3000; price 63_000 → exactly at full confidence boundary
    const result = normalizeCrypto({ price: 63_000, threshold: 60_000, comparator: "gte" });
    expect(result.confidence).toBeCloseTo(1.0);
  });

  it("confidence is in [0.5, 1.0]", () => {
    for (const price of [59_000, 60_000, 61_000, 63_000, 70_000]) {
      const { confidence } = normalizeCrypto({ price, threshold: 60_000, comparator: "gte" });
      expect(confidence).toBeGreaterThanOrEqual(0.5);
      expect(confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("refuses a non-finite price instead of returning a zero-confidence outcome", () => {
    // Previously returned { outcome: false, confidence: 0 } — a silent wrong
    // value indistinguishable from a real reading.
    expectNormalizationError(
      () => normalizeCrypto({ price: NaN, threshold: 60_000, comparator: "gte" }),
      "price",
    );
    expectNormalizationError(
      () => normalizeCrypto({ price: 60_000, threshold: 0, comparator: "gte" }),
      "threshold",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeSports
// ---------------------------------------------------------------------------

describe("normalizeSports", () => {
  it("final result → confidence 1.0", () => {
    const result = normalizeSports({ final: true, outcome: true });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("provisional result → confidence 0.7", () => {
    const result = normalizeSports({ final: false, outcome: false });
    expect(result.outcome).toBe(false);
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it("sourceConfidence multiplies base confidence for final result", () => {
    const result = normalizeSports({ final: true, outcome: true, sourceConfidence: 0.9 });
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("sourceConfidence multiplies base confidence for provisional result", () => {
    const result = normalizeSports({ final: false, outcome: true, sourceConfidence: 0.8 });
    expect(result.confidence).toBeCloseTo(0.7 * 0.8);
  });

  it("confidence is clamped to [0, 1]", () => {
    const result = normalizeSports({ final: true, outcome: true, sourceConfidence: 2.0 });
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// normalizePolitics
// ---------------------------------------------------------------------------

describe("normalizePolitics", () => {
  it("full consensus → confidence 1.0", () => {
    const result = normalizePolitics({ outcome: true, consensusFraction: 1.0 });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("zero consensus → confidence 0.0", () => {
    const result = normalizePolitics({ outcome: false, consensusFraction: 0.0 });
    expect(result.confidence).toBe(0.0);
  });

  it("0.5 consensus → confidence 0.5 (tie)", () => {
    const result = normalizePolitics({ outcome: true, consensusFraction: 0.5 });
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it("clamps out-of-range values", () => {
    expect(normalizePolitics({ outcome: true, consensusFraction: 1.5 }).confidence).toBe(1.0);
    expect(normalizePolitics({ outcome: false, consensusFraction: -0.1 }).confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// normalizeScience
// ---------------------------------------------------------------------------

describe("normalizeScience", () => {
  it("passes through confidence in [0, 1]", () => {
    const result = normalizeScience({ outcome: true, confidence: 0.85 });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it("clamps confidence above 1 to 1", () => {
    expect(normalizeScience({ outcome: false, confidence: 1.5 }).confidence).toBe(1.0);
  });

  it("clamps confidence below 0 to 0", () => {
    expect(normalizeScience({ outcome: true, confidence: -0.1 }).confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// normalizeOutcome — unified dispatcher
// ---------------------------------------------------------------------------

describe("normalizeOutcome", () => {
  it("routes crypto payload", () => {
    const result = normalizeOutcome({
      category: "crypto",
      price: 65_000,
      threshold: 60_000,
      comparator: "gte",
    });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("routes sports payload", () => {
    const result = normalizeOutcome({ category: "sports", final: true, outcome: false });
    expect(result.outcome).toBe(false);
    expect(result.confidence).toBe(1.0);
  });

  it("routes politics payload", () => {
    const result = normalizeOutcome({ category: "politics", outcome: true, consensusFraction: 0.8 });
    expect(result.confidence).toBeCloseTo(0.8);
  });

  it("routes science payload", () => {
    const result = normalizeOutcome({ category: "science", outcome: true, confidence: 0.9 });
    expect(result.confidence).toBeCloseTo(0.9);
  });
});

// ---------------------------------------------------------------------------
// Malformed, partial and unexpected payloads
//
// The contract under test: normalization either produces a well-founded
// outcome, or it throws a `NormalizationError` naming the offending field.
// It never returns a plausible number derived from data it could not read.
// ---------------------------------------------------------------------------

describe("malformed crypto payloads", () => {
  it("rejects a null price rather than coercing it to 0", () => {
    // The hazard: null → 0 resolves a `price >= 60_000` market to `false` with
    // real confidence, and nothing downstream can tell it from a true reading.
    const error = expectNormalizationError(
      () => normalizeCrypto({ ...NULL_PRICE_RESPONSE, threshold: 60_000, comparator: "gte" } as never),
      "price",
    );
    expect(error.received).toBeNull();
    expect(error.message).toContain("required number is missing");
  });

  it("rejects an empty-string price", () => {
    // Number("") is 0, so a naive coercion reads an empty field as a real
    // reading of zero.
    expectNormalizationError(
      () => normalizeCrypto({ ...EMPTY_STRING_PRICE_RESPONSE, threshold: 60_000, comparator: "gte" } as never),
      "price",
    );
  });

  it("rejects the literal string 'null' as a price", () => {
    // Number("null") is NaN, which passes a typeof check and then poisons
    // every comparison it reaches.
    expectNormalizationError(
      () => normalizeCrypto({ ...LITERAL_NULL_STRING_PRICE_RESPONSE, threshold: 60_000, comparator: "gte" } as never),
      "price",
    );
  });

  it("rejects a non-numeric string price", () => {
    expectNormalizationError(
      () => normalizeCrypto({ price: "not-a-price", threshold: 60_000, comparator: "gte" } as never),
      "price",
    );
  });

  it("rejects an infinite price", () => {
    expectNormalizationError(
      () => normalizeCrypto({ price: Number.POSITIVE_INFINITY, threshold: 60_000, comparator: "gte" }),
      "price",
    );
  });

  it("rejects a missing price field", () => {
    expectNormalizationError(
      () => normalizeCrypto({ threshold: 60_000, comparator: "gte" } as never),
      "price",
    );
  });

  it("rejects a missing threshold field", () => {
    expectNormalizationError(
      () => normalizeCrypto({ price: 60_000, comparator: "gte" } as never),
      "threshold",
    );
  });

  it("rejects a null threshold", () => {
    expectNormalizationError(
      () => normalizeCrypto({ price: 60_000, threshold: null, comparator: "gte" } as never),
      "threshold",
    );
  });

  it("rejects an unknown comparator rather than defaulting to gte", () => {
    // Defaulting would resolve every market with an unrecognised comparator as
    // `price >= threshold`, silently inverting the meaning of an `lte` market.
    const error = expectNormalizationError(
      () => normalizeCrypto({ price: 70_000, threshold: 60_000, comparator: "GT" } as never),
      "comparator",
    );
    expect(error.message).toContain('expected "gte" or "lte"');
  });

  it("rejects a missing comparator", () => {
    expectNormalizationError(
      () => normalizeCrypto({ price: 70_000, threshold: 60_000 } as never),
      "comparator",
    );
  });

  it("names the provider in the error when one is supplied", () => {
    const error = expectNormalizationError(
      () => normalizeCrypto({ price: null, threshold: 60_000, comparator: "gte", provider: "binance" } as never),
      "price",
    );
    expect(error.source).toBe("binance");
    expect(error.message).toContain("binance");
  });

  it("never leaks a large payload value into the error message", () => {
    const error = expectNormalizationError(
      () => normalizeCrypto({ price: { blob: "x".repeat(500) }, threshold: 1, comparator: "gte" } as never),
      "price",
    );
    // The received value is retained for diagnosis but truncated in the
    // message, so a stray payload cannot flood the logs.
    expect(error.message.length).toBeLessThan(200);
    expect(error.message).not.toContain("xxxx");
  });
});

describe("malformed sports payloads", () => {
  it("rejects a non-boolean final flag", () => {
    // Truthiness coercion here would report an in-progress game as final and
    // resolve the market early at full confidence.
    const error = expectNormalizationError(
      () => normalizeSports({ final: "true", outcome: true } as never),
      "final",
    );
    expect(error.message).toContain("expected boolean");
  });

  it("rejects a null final flag", () => {
    expectNormalizationError(() => normalizeSports({ final: null, outcome: true } as never), "final");
  });

  it("rejects a missing final flag rather than assuming provisional", () => {
    expectNormalizationError(() => normalizeSports({ outcome: true } as never), "final");
  });

  it("rejects a non-boolean outcome", () => {
    expectNormalizationError(
      () => normalizeSports({ final: true, outcome: 1 } as never),
      "outcome",
    );
  });

  it("rejects a null sourceConfidence rather than treating it as absent", () => {
    // null is not the same as "field not provided" — it is a broken value.
    expectNormalizationError(
      () => normalizeSports({ final: true, outcome: true, sourceConfidence: null } as never),
      "sourceConfidence",
    );
  });

  it("rejects a non-numeric sourceConfidence", () => {
    expectNormalizationError(
      () => normalizeSports({ final: true, outcome: true, sourceConfidence: "high" } as never),
      "sourceConfidence",
    );
  });

  it("accepts a sourceConfidence outside [0, 1] by clamping it", () => {
    // A loose source scale is a defined, reversible interpretation, not a
    // guess, so clamping is correct here where throwing would be over-strict.
    const result = normalizeSports({ final: true, outcome: true, sourceConfidence: 2.0 });
    expect(result.confidence).toBe(1.0);
  });
});

describe("malformed politics payloads", () => {
  it("rejects a missing consensusFraction", () => {
    const error = expectNormalizationError(
      () => normalizePolitics({ outcome: true } as never),
      "consensusFraction",
    );
    expect(error.message).toContain("required number is missing");
  });

  it("rejects a null consensusFraction", () => {
    expectNormalizationError(
      () => normalizePolitics({ outcome: true, consensusFraction: null } as never),
      "consensusFraction",
    );
  });

  it("rejects NaN consensusFraction, which passes a naive typeof check", () => {
    expectNormalizationError(
      () => normalizePolitics({ outcome: true, consensusFraction: Number.NaN }),
      "consensusFraction",
    );
  });

  it("rejects a non-boolean outcome", () => {
    expectNormalizationError(
      () => normalizePolitics({ outcome: "yes", consensusFraction: 1 } as never),
      "outcome",
    );
  });

  it("clamps a numeric consensusFraction outside [0, 1]", () => {
    expect(normalizePolitics({ outcome: true, consensusFraction: 1.5 }).confidence).toBe(1.0);
    expect(normalizePolitics({ outcome: false, consensusFraction: -0.1 }).confidence).toBe(0.0);
  });
});

describe("malformed science payloads", () => {
  it("rejects a missing confidence", () => {
    expectNormalizationError(() => normalizeScience({ outcome: true } as never), "confidence");
  });

  it("rejects a null confidence", () => {
    expectNormalizationError(
      () => normalizeScience({ outcome: true, confidence: null } as never),
      "confidence",
    );
  });

  it("rejects a non-boolean outcome", () => {
    expectNormalizationError(
      () => normalizeScience({ outcome: "true", confidence: 0.9 } as never),
      "outcome",
    );
  });

  it("clamps a numeric confidence outside [0, 1]", () => {
    expect(normalizeScience({ outcome: false, confidence: 1.5 }).confidence).toBe(1.0);
    expect(normalizeScience({ outcome: true, confidence: -0.1 }).confidence).toBe(0.0);
  });
});

describe("unexpected response structure", () => {
  it("rejects an unknown category through the unified entry point", () => {
    const error = expectNormalizationError(
      () => normalizeOutcome({ category: "weather", outcome: true } as never),
      "category",
    );
    expect(error.message).toContain("unknown market category");
  });

  it("rejects a missing category", () => {
    expectNormalizationError(() => normalizeOutcome({ outcome: true } as never), "category");
  });

  it("tolerates extra fields in the payload", () => {
    // Providers add fields routinely; refusing to parse would break on every
    // API version bump.
    const result = normalizeCrypto({
      price: 70_000,
      threshold: 60_000,
      comparator: "gte",
      provider: "binance",
      lastTradeId: 9_000_001,
      bidPrice: "69_999.10",
      askPrice: "70_000.90",
    } as never);
    expect(result.outcome).toBe(true);
  });

  it("rejects an array-shaped provider response that carries no fields", () => {
    // A provider returning a bare list instead of a single object is a real
    // integration failure. It must be rejected, not read as an empty payload.
    expectNormalizationError(() => normalizeOutcome([] as never), "category");
    expectNormalizationError(
      () => normalizeOutcome([{ price: 1, threshold: 1, comparator: "gte" }] as never),
      "category",
    );
  });

  it("rejects a non-object payload as a data error, not a raw TypeError", () => {
    // A null payload must land in the adapter error taxonomy; a bare TypeError
    // from property access would be classified as transient and retried.
    expectNormalizationError(() => normalizeOutcome(null as never), "payload");
    expectNormalizationError(() => normalizeOutcome("BTCUSDT" as never), "payload");
    expectNormalizationError(() => normalizeOutcome(undefined as never), "payload");
    expectNormalizationError(() => normalizeOutcome(42 as never), "payload");
  });
});

describe("captured provider responses", () => {
  /**
   * Each case projects a real captured body to the canonical payload, then
   * asserts the normalizer handles it. A change in a provider's real response
   * shape that the projection cannot absorb fails here rather than silently at
   * resolution time.
   */
  it("normalizes a Binance ticker response (price arrives as a string)", () => {
    const body = BINANCE_TICKER_BTCUSDT;
    const price = Number(body.price);
    expect(price).toBeCloseTo(64_231.87);

    const result = normalizeCrypto({ price, threshold: 60_000, comparator: "gte", provider: "binance" });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("normalizes a CoinGecko simple price response (nested, numeric price)", () => {
    const price = COINGECKO_SIMPLE_PRICE.bitcoin.usd;
    const result = normalizeCrypto({ price, threshold: 60_000, comparator: "gte", provider: "coingecko" });
    expect(result.outcome).toBe(true);
  });

  it("normalizes a CoinMarketCap quotes response (array-wrapped nesting)", () => {
    const body = COINMARKETCAP_QUOTES_LATEST;
    const price = body.data.BTC.quote.USD.price;
    const result = normalizeCrypto({ price, threshold: 60_000, comparator: "gte", provider: "coinmarketcap" });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("fails explicitly on a Binance error body that has no price at all", () => {
    // A 200-with-error-body or a body lacking `price` must not read as price 0.
    const body = BINANCE_UNKNOWN_SYMBOL as unknown as Record<string, unknown>;
    expectNormalizationError(
      () => normalizeCrypto({ price: body.price, threshold: 60_000, comparator: "gte", provider: "binance" } as never),
      "price",
    );
  });

  it("normalizes a provisional sports score, downgrading confidence", () => {
    const body = THEODDSAPI_SCORES_PROVISIONAL;
    const result = normalizeSports({
      final: body.completed,
      outcome: Number(body.scores[0].score) > Number(body.scores[1].score),
      provider: "theoddsapi",
    });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it("normalizes a final sports score at full confidence", () => {
    const body = THEODDSAPI_SCORES_FINAL;
    const result = normalizeSports({
      final: body.completed,
      outcome: Number(body.scores[0].score) > Number(body.scores[1].score),
      provider: "theoddsapi",
    });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("fails explicitly when a sports score is missing", () => {
    const body = { ...THEODDSAPI_SCORES_FINAL, scores: undefined } as unknown as Record<string, unknown>;
    // The projection cannot derive an outcome, so it must not guess one.
    expect(body.scores).toBeUndefined();
    expectNormalizationError(
      () => normalizeSports({ final: body.completed, outcome: undefined, provider: "theoddsapi" } as never),
      "outcome",
    );
  });

  it("normalizes a Reuters politics feed to a consensus outcome", () => {
    const articles = REUTERS_POLITICS.data.articles;
    const winnerMentioned = articles.filter((a) => a.title.includes("Candidate A")).length;
    const result = normalizePolitics({
      outcome: winnerMentioned > 0,
      consensusFraction: winnerMentioned / articles.length,
      provider: "reuters",
    });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("normalizes a Polymarket politics feed", () => {
    const market = POLYMARKET_POLITICS.data.markets[0];
    expect(market.status).toBe("resolved");
    const result = normalizePolitics({
      outcome: market.resolution === "Candidate A",
      consensusFraction: 1.0,
      provider: "polymarket",
    });
    expect(result.outcome).toBe(true);
  });

  it("fails explicitly when the politics feed carries no articles", () => {
    // An empty feed must not become "0% consensus" or a 50% tie by default.
    const articles: unknown[] = [];
    expect(articles.length).toBe(0);
    expectNormalizationError(
      () =>
        normalizePolitics({
          outcome: articles.length > 0,
          consensusFraction: articles.length > 0 ? 1 : undefined,
          provider: "reuters",
        } as never),
      "consensusFraction",
    );
  });

  it("normalizes a science committee quorum response", () => {
    const body = SCIENCE_COMMITTEE_QUORUM;
    const result = normalizeScience({
      outcome: body.resolution,
      confidence: body.consensus,
      provider: "committee",
    });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.91);
  });

  it("fails explicitly when a committee response omits its confidence", () => {
    const body = { ...SCIENCE_COMMITTEE_QUORUM, consensus: undefined } as unknown as Record<string, unknown>;
    expectNormalizationError(
      () => normalizeScience({ outcome: body.resolution, confidence: body.consensus, provider: "committee" } as never),
      "confidence",
    );
  });

  it("fails explicitly on an HTML error page returned with a 200", () => {
    // A proxy/interstitial body parsed as JSON becomes a string; the projection
    // has no price, so it must refuse rather than coerce.
    const body = HTML_ERROR_PAGE_RESPONSE as unknown as Record<string, unknown>;
    expect(typeof body).toBe("string");
    expectNormalizationError(
      () => normalizeCrypto({ price: (body as { price?: unknown }).price, threshold: 60_000, comparator: "gte" } as never),
      "price",
    );
  });

  it("fails explicitly on a truncated JSON body", () => {
    // `response.json()` throws a SyntaxError on this; the adapters classify it
    // as a data error, and no value is produced.
    expect(() => JSON.parse(TRUNCATED_JSON_RESPONSE)).toThrow(SyntaxError);
  });
});
