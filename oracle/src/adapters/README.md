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

Adapters
--------

- `coingecko` (CoinGecko API)
  - Files: `coingecko.ts`
  - Mapping: expects `params.symbol` to be the CoinGecko coin id (e.g. "bitcoin").
    Uses `/coins/{id}/market_chart/range` when `params.at` is present (queries a
    small window around the timestamp and picks the closest point). Falls back
    to `/simple/price` when no historical point is available.
  - Quota: Free tier is rate-limited; the adapter respects retry/backoff and
    supports an optional API key header. Keep calls infrequent and prefer the
    `rateLimiter` and `responseCache` wrappers when resolving many markets.

- `coinmarketcap` (CoinMarketCap API)
  - Files: `coinmarketcap.ts`
  - Mapping: `params.symbol` should be the CMC symbol. CMC offers historical
    endpoints on paid tiers; current implementation uses the current price
    endpoint. If historical resolution is required for deadlines, prefer
    `coingecko` or record a fixture.
  - Quota: Strict rate limits on free tiers. API key required for higher
    request volumes.

- `binance` (Binance API)
  - Files: `binance.ts`
  - Mapping: expects `params.symbol` to be a Binance trading pair (e.g.
    `BTCUSDT`). Binance supports klines / historical samples which adapters may
    use to select the price at a specific millisecond timestamp.
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
