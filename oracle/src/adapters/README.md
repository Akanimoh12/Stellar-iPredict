Overview
---
This directory implements the data-adapter layer that maps internal `Market`
objects to external provider queries. Each adapter documents its supported
market shapes, how it maps `market.params` to provider requests, and known
rate-limit / quota characteristics so callers can make quota-safe decisions.

Common conventions
- `crypto` markets: use `params.symbol` (provider-specific) plus `comparator` and `threshold`.
- Optional `params.at` (unix seconds): when present adapters SHOULD attempt to
  resolve the value closest to that timestamp (used to resolve price at exact
  market deadline UTC). If a provider doesn't support historical queries the
  adapter will fall back to a current price query and document the limitation.
- Price adapters check how old a quote is before trusting it, and downweight or
  reject one that is too old. See `docs/ORACLE_ADAPTER_FRESHNESS.md` for the
  per-provider support matrix, the per-adapter bounds, and the list of adapters
  the check does **not** cover.

Adapters
--------

- `coingecko` (CoinGecko API)
  - Files: `coingecko.ts`
  - Mapping: expects `params.symbol` to be the CoinGecko coin id (e.g. "bitcoin").
    Uses `/coins/{id}/market_chart/range` when `params.at` is present (queries a
    small window around the timestamp and picks the closest point). Falls back
    to `/simple/price` when no historical point is available.
  - Freshness: `last_updated_at` on the live path, and the selected point's own
    timestamp on the historical path. A historical quote is judged against the
    instant `params.at` asked for, not against the wall clock.
  - Quota: Free tier is rate-limited; the adapter respects retry/backoff and
    supports an optional API key header. Keep calls infrequent and prefer the
    `rateLimiter` and `responseCache` wrappers when resolving many markets.

- `coinmarketcap` (CoinMarketCap API)
  - Files: `coinmarketcap.ts`
  - Mapping: `params.symbol` should be the CMC symbol. CMC offers historical
    endpoints on paid tiers; current implementation uses the current price
    endpoint. If historical resolution is required for deadlines, prefer
    `coingecko` or record a fixture.
  - Freshness: `last_updated_timestamp` / `last_updated` on each quote.
  - Quota: Strict rate limits on free tiers. API key required for higher
    request volumes.

- `binance` (Binance API)
  - Files: `binance.ts`
  - Mapping: expects `params.symbol` to be a Binance trading pair (e.g.
    `BTCUSDT`). Binance supports klines / historical samples which adapters may
    use to select the price at a specific millisecond timestamp.
  - Freshness: uses `/api/v3/ticker/24hr` and its `closeTime`. The shorter
    `/api/v3/ticker/price` endpoint carries no timestamp at all, so freshness
    would be unverifiable there.
  - Quota: Binance has per-endpoint weight limits; use `rateLimiter`.

- `reuters` (Reuters/NLP feed)
  - Files: `reuters.ts`
  - Mapping: politics/news markets. Uses provider-specific ids in `params.marketId`.
  - Quota: Streaming or paid; treat as higher-cost source.

- `theoddsapi` (sports odds)
  - Files: `theoddsapi.ts`
  - Mapping: sports markets expect provider match ids in `params.marketId`.
  - Quota: Rate-limited; batch lookups where possible.

- `polymarketfeed` (Polymarket public feed)
  - Files: `polymarketfeed.ts`
  - Mapping: politics/polling markets mapped from Polymarket market ids.
  - Quota: Public feed may be rate-limited; cache responses.

- `fixtures` (test / recording adapters)
  - Files: `fixtures.ts`
  - Usage: replay recorded adapter responses for deterministic testing. Fixtures
    are the recommended method when exact historical resolution is required and
    provider quotas are a concern.

Quota-safety
------------
- Use the `rateLimiter` wrapper to throttle concurrent requests to providers.
- Use `responseCache` for repeated queries (especially for identical timestamp
  lookups across many markets).
- Prefer fixtures for CI tests or to verify exact-deadline resolution without
  burning external API quota.

Testing
-------
- Adapter tests live under `oracle/test/` and use mocked `fetch` implementations
  to verify request URLs and parsing logic. Add fixtures for historical samples
  to `oracle/src/adapters/fixtures.ts` and test that `params.at` yields the
  expected behaviour.

If a specific adapter is missing a documented capability (e.g. historical
queries), open an issue and prefer either adding historical support or
marking the limitation in this README.

## Confidence weighting

`AdapterOutcome.confidence` (0-1) decides how much a source's vote counts.
`resolveMarket` aggregates as follows:

1. **Weight** of a source is `clamp(confidence, 0, 1)`. Failed sources carry no vote.
2. **Outcome** is the side (yes/no) with the larger total weight. If every
   source reports `0`, the vote falls back to head-count and the
   `minConfidence` floor sends it to review.
3. **Conflict**: if the losing side holds more than `conflictThreshold` of the
   total weight, the result is `conflict` (or `review` with a queue).
4. **Too close to call**: if both sides have votes and the weighted margin
   `|yes - no| / total` is below `minWeightedMargin` (default `0.1`), the result
   is held with reason code `inconclusive` instead of picking the marginally
   heavier side.
5. **Result confidence** is the mean confidence of successful sources and must
   still meet `minConfidence`.

Adapters derive confidence from real signal quality: distance from the
threshold, quote freshness (`freshness.ts` ceilings), sports final vs.
provisional state, and provider-reported values. Do not hardcode `1`.
