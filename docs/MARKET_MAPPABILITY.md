# Market mappability validation

Issue #745.

A market whose question cannot be mapped to a provider query — an unrecognised
ticker, a category no adapter serves, a symbol no provider lists — cannot be
resolved by *any* adapter. Before this change that was discovered when the
market expired: resolution is already urgent, the market holds user stakes, and
the only available action is manual intervention under time pressure.

## The three things this fixes

### 1. An unmappable market is identified at creation, not at expiry

`validateMarketMappability` and `assertMarketMappable`
(`oracle/src/adapters/mappability.ts`) answer "can anything resolve this?" and,
when the answer is no, say why and what to do about it. Call `assertMarketMappable`
wherever a market is created or imported; it throws `UnmappableMarketError`
carrying the market id, the reason, and the remedy.

The check works with **no adapters loaded**, which is the point: at creation
time the oracle may not be running. It runs off a
`MarketMappabilityRegistry` of known provider symbols and served categories, and
consults live adapters when they are available.

### 2. Existing unmappable markets are reported

Creation-time validation cannot see markets that already exist, and it cannot
see a symbol a provider delists *after* creation. The sweep covers both:

```bash
npm run --prefix oracle run sweep:unmappable -- --source https://api.example.com
```

It reads candidates from `GET /api/markets/unmappable` — open, un-cancelled
markets ordered by `end_time` ascending, so the most urgent lead. Markets
already past `end_time` and still unresolved come first of all: they are the
ones holding stakes with no resolution path.

Output, most urgent first:

```
Checked 3 open market(s).

  market 2  [Crypto]  EXPIRED 2h ago
    why:  No configured provider lists "NOPEUSDT"
    fix:  Add the provider's own symbol to MARKET_MAPPABILITY_OVERRIDES .symbols, …
    what: Will NOPE reach $1?
```

Exit code is 1 when anything is found, so it can gate a release. Run it from
cron (daily is enough) and before any deploy.

### 3. A mapping can be added without a redeploy

`MARKET_MAPPABILITY_OVERRIDES` — a JSON string in the environment, or a JSON
file at `MARKET_MAPPABILITY_OVERRIDES_FILE`. The file is re-read on **every**
lookup, so an operator can drop it into a mounted volume and it takes effect
without restarting anything. A snapshot taken at process start would be no
better than no override for exactly the case the override exists for.

```jsonc
{
  // Add a symbol a provider does list but the defaults do not carry.
  "symbols": { "binance": ["TONUSDT"], "coinmarketcap": ["TON"] },

  // Add a category an adapter serves but the defaults do not list.
  "categories": ["entertainment"],

  // Remove a symbol a provider has delisted but the defaults still claim.
  // `unsupported` wins over `symbols`, so a symbol cannot be both.
  "unsupported": { "binance": ["DEADUSDT"] }
}
```

A **malformed** override throws with the offending source named. A silently
ignored override looks exactly like "the override applied and had no effect",
which is the most confusing outcome available.

In-process equivalents, for code that has the registry: `addSymbols()` and
`addCategory()`.

## Why the resolution result now carries a reason

`resolveMarket` returns a `reason` on every result. Without it,
`status: "unresolvable"` reads as "try again later" — and for an unmappable
market, trying again can never help. With it:

| `reason.code` | Means |
|---|---|
| `unmappable` | No adapter can *ever* resolve this. Carries the mappability verdict and its remedy. |
| `all-sources-failed` | Adapters were queried and every one errored. Transient; retry is reasonable. |
| `insufficient-agreement` | Fewer sources succeeded than `minAgreement` requires. |
| `conflicting-outcomes` | Sources disagreed past `conflictThreshold`. |
| `low-confidence` | Resolved, but below `minConfidence`; held for review. |
| `cancelled` | A provider reported the event cannot settle normally. |
| `resolved` | Ordinary resolution. |

Set `checkMappability: false` to skip the check for callers that already
validated at creation.

## Known limitation: params are not stored

Market→adapter params (`symbol`, `comparator`, `threshold`) exist **only** in
the oracle's in-memory market objects. They are not in the `market_created`
contract event, and `markets` has no column for them. A query of the database
cannot tell you what any given market should be resolved against.

So with only `id`, `question` and `category`, a market cannot be classified as
mappable or unmappable. The sweep reports such a market as
`reason: "unknown-params"` — *unclassified*, needing a human — and prints a
warning rather than a clean bill of health:

```
WARNING: no --params supplied. Market→adapter params are not stored in the database,
         so every market below is UNCLASSIFIED rather than known-unmappable. …
```

Supply them to get a real classification:

```bash
npm run --prefix oracle run sweep:unmappable -- \
  --source https://api.example.com \
  --params /etc/ipredict/market-params.json
```

```jsonc
// market id → adapter params
{
  "1": { "symbol": "BTCUSDT", "comparator": "gte", "threshold": 100000 },
  "2": { "symbol": "TONUSDT",  "comparator": "lte", "threshold": 2 }
}
```

This gap is itself worth closing — persisting params at `market_created` time
would make the sweep conclusive and would also give the aggregator a durable
source instead of re-deriving them. That is a schema and contract change, so it
is out of scope here, and is recorded here rather than glossed over.

**Creation-time validation is unaffected**: it runs where the params are still
in hand, which is exactly the point of doing it at creation.

## Category form

Postgres stores `Crypto`; the adapter layer uses `crypto`. The validator
normalises (`normalizeCategory`), because without it the sweep rejects every row
in `markets` for an "unsupported category" and reports the whole table as
broken. Overrides match case-insensitively too.

## The symbol table

`DEFAULT_MAPPABLE_SYMBOLS` is deliberately short — the instruments the platform
actually creates markets for. It is not an attempt to enumerate every
instrument a provider lists: that would go stale weekly and would still not
answer the real question, which is "will *an adapter this deployment runs*
accept this?". Overrides are the escape hatch for everything else.

A registry only claims symbols for adapters that are actually configured, so a
binance-only deployment does not consider a CoinMarketCap-only symbol resolvable
just because it appears somewhere in the defaults.

## What is tested where

| Property | Test |
|---|---|
| The unmappable case: unknown symbol, unsupported category, missing params | `test/mappability.test.ts` |
| Rejection at creation, with the remedy attached | `test/mappability.test.ts` |
| Overrides, including no-redeploy re-read and malformed input | `test/mappability.test.ts` |
| The sweep: urgency ordering, expiry, windowing, params absent | `test/mappability.test.ts` |
| The diagnosis reaching `resolveMarket` | `test/mappability.test.ts` |
| The candidate endpoint | `backend/src/api/markets.test.ts` |
