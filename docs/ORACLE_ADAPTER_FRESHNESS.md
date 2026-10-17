# Oracle adapter quote freshness

Issue #744.

A price adapter that returns `confidence: 1` for whatever number the provider
sent will happily resolve a market against a quote that a caching layer, an
edge PoP, or an upstream outage froze minutes or hours ago. The number is
plausible, the comparison against the threshold is arithmetically correct, and
the resolution is wrong — and nothing in the adapter output says so, because
before this change there was no freshness check at all.

This document is the operator-facing half: what is checked, what is
configurable, which providers cannot be checked, and how to alert on it.

## The model

`oracle/src/adapters/freshness.ts` compares the provider's own observation
time against a per-adapter policy and produces one of four verdicts:

| Verdict | Meaning | Effect on the outcome |
|---|---|---|
| `fresh` | Timestamped, inside the soft bound | Confidence unchanged. |
| `stale` | Timestamped, past the soft bound, inside the hard bound | Confidence capped at `staleConfidence` (default `0.5`). |
| `expired` | Timestamped, past the hard bound | Adapter throws `StaleQuoteError`; resolution falls through to the next source. |
| `untimestamped` | Provider sent no timestamp at all | Confidence capped at `untimestampedConfidence` (default `0.5`). |

The caps are deliberately **below the resolution confidence floor**
(`DEFAULT_CATEGORY_CONFIG.crypto.minConfidence` is `0.7`). That is what
satisfies the requirement that a stale response must not resolve a market at
full confidence: a downweighted quote lands under the floor, so
`resolveMarket` returns `status: "review"` with no `outcome` and enqueues it
for a human rather than settling it.

The `outcome` boolean is still computed from the number the provider sent.
Freshness governs how much the oracle will *stake* on an answer, not whether
an answer exists — the market question is still answered, just not
automatically.

## Configuration

Every bound is per-adapter and settable two ways. Constructor options are the
lower level; environment variables win, so an operator can tighten or widen a
deployment's bound without a code change.

| Variable | Default | Meaning |
|---|---|---|
| `<PREFIX>_FRESHNESS_MAX_AGE_MS` | `120000` | Hard bound. Older than this and the adapter rejects the quote. |
| `<PREFIX>_FRESHNESS_STALE_AFTER_MS` | `30000` | Soft bound. Older than this and the quote is downweighted. Clamped to `MAX_AGE_MS`. |
| `<PREFIX>_FRESHNESS_STALE_CONFIDENCE` | `0.5` | Confidence ceiling for a stale quote. |
| `<PREFIX>_FRESHNESS_UNTIMESTAMPED_CONFIDENCE` | `0.5` | Confidence ceiling for a quote with no timestamp. |

`<PREFIX>` is the adapter id upper-cased, prefixed with `ORACLE_`:

- `ORACLE_BINANCE_…`
- `ORACLE_COINMARKETCAP_…`
- `ORACLE_COINGECKO_…`

An unparseable value is a startup error, not a silent fallback. A typo in
`ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS=sixty` that quietly used the default
would reintroduce exactly the blind spot the setting exists to close.

Setting only `MAX_AGE_MS` leaves the downweight window at its default rather
than collapsing it onto the hard bound. Collapsing it would mean a stale quote
is rejected outright instead of downweighted and sent to review — a strictly
coarser outcome than the policy is meant to express.

## Provider support matrix

This is the part that is easy to overstate, so it is stated exactly.

| Adapter | Endpoint | Field read | Verifiable? |
|---|---|---|---|
| `binance` | `/api/v3/ticker/24hr` | `closeTime` | **Yes** |
| `coinmarketcap` | `/v2/cryptocurrency/quotes/latest` | `last_updated_timestamp`, `last_updated` | **Yes** |
| `coingecko` (live) | `/simple/price` | `last_updated_at` | **Yes**, when present in the response |
| `coingecko` (historical) | `/coins/{id}/market_chart/range` | the selected point's own timestamp | **Yes** |
| `reuters`, `theoddsapi`, `polymarketfeed`, `fixtures` | — | — | **No** — see below |

### Why Binance changed endpoints

`GET /api/v3/ticker/price` is the obvious endpoint and the wrong one. Its
entire response is `{ symbol, price }`. There is no observation time in it, so
there is nothing to check, and a quote served from a cache is byte-for-byte
identical to a live one.

`GET /api/v3/ticker/24hr` returns the same rolling-window price as
`lastPrice` and adds `closeTime` — the moment the window that price belongs to
closed. That is the field the adapter reads. The price value is unchanged
(`lastPrice` is the same last-traded price the short endpoint returns), so
this is a strict improvement in what can be verified, at a slightly higher
request weight.

### Known limitations

These are not covered by the check, and pretending otherwise would be worse
than the gap:

- **`reuters`, `theoddsapi`, `polymarketfeed`.** These return event results —
  a score, an odds snapshot, a resolution status — not a continuously-quoted
  price. They have no provider timestamp wired in and no freshness policy, so
  they return confidence exactly as they did before this change. Adding a
  check to them means deciding what "current" means for a one-shot event
  result, which is a different question from the one this issue asks.
- **`fixtures`.** Replayed recordings are as old as the recording. They are
  for tests and audits, not production resolution, and a freshness bound on
  them would only produce confusing failures.
- **CoinGecko without `last_updated_at`.** The field is present on the public
  response but a plan or proxy could omit it. The adapter handles that: the
  quote becomes `untimestamped` and is capped, rather than being trusted.

### Where a quote is checked against the wrong clock

CoinGecko's historical path is judged against **the instant the market asked
about**, not `Date.now()`. A market resolving on last Tuesday's close is
*supposed* to see last Tuesday's price; measured against the wall clock every
historical resolution would be stale by construction. Live quotes from all
three adapters are measured against the wall clock as normal.

## Alerting on persistent staleness

`StalenessTracker` keeps a rolling per-adapter window (15 min by default) of
quote verdicts. `staleAdapterReports()` returns an entry for an adapter whose
window shows sustained non-freshness — at least `minNotFresh` (3) not-fresh
observations *and* at least `minRatio` (50%) of the window. A single stale
response is noise; a run of them is a provider serving a cached tape.

`staleDataAlerts()` renders those reports as alert payloads, and the monitor's
`AlertType` carries `oracle.adapter.stale_data`. The payload distinguishes two
conditions an operator must not confuse:

- `status: "untimestamped"` — the provider never tells us how old its numbers
  are. A permanent, documented limitation; fix the mapping or accept the
  downweight.
- `status: "stale" | "expired"` — the provider *did* tell us and the answer was
  too old. That points at a caching or outage problem upstream.

`windowFullyNotFresh` is called out separately because it cannot be explained
away as a slow poll: every single sample in the window was unusable.

Adapters report into a process-wide registry (`stalenessRegistry.ts`) on every
resolution, so the aggregator — the process that actually resolves prices — is
the one that holds the window. The monitor runs as a separate process and does
not see it; a deployment that wants the monitor to raise this needs the
aggregator to publish the reports, which is not wired yet. Until then, read
`staleAdapterReports()` in-process and alert from the aggregator, or watch
for the tell-tale in the resolution record: `freshness.status` is on every
`AdapterOutcome` and survives onto the review queue.

## What is verified where

| Property | Test |
|---|---|
| A stale quote is held for review, not resolved | `test/adapter-freshness-resolution.test.ts` |
| An expired quote falls through to the next source | `test/adapter-freshness-resolution.test.ts` |
| Per-adapter bounds, via options and via env | `test/binance-adapter.test.ts`, `test/coinmarketcap-adapter.test.ts`, `test/coingecko-adapter.test.ts` |
| Timestamp extraction across all three provider shapes | `test/freshness.test.ts` |
| Sustained-staleness detection and alerting | `test/freshness.test.ts` |
