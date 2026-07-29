# iPredict Oracle

The resolution layer that decides market outcomes without trusting a single
admin. Built in phases (see [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#part-1--oracle-architecture)):

| Phase | Model | Contract changes |
|---|---|---|
| **1.5** | 4-of-7 Council multisig + off-chain aggregator | none (uses existing `add_resolver`/`resolve_market`) |
| **2** | Optimistic oracle — bonded submissions, challenge window, dispute council | new contract functions & state |
| **Data** | Off-chain data adapters (CoinGecko, Binance, sports, politics) feeding submitters | none |

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## What lives here

- **`aggregator/`** — off-chain service that watches council submissions and
  fires the final on-chain resolution once threshold is met.
- **`adapters/`** — one module per data source; each returns a normalized
  outcome for a given market.
- **`submitter/`** — signs and submits outcomes/bonds on behalf of an oracle
  provider.
- **`monitor/`** — watches oracle events (submissions, challenges, disputes)
  and alerts on stuck/conflicting markets.

> Note: the *contract-side* oracle changes (optimistic oracle state machine,
> bonds, dispute council) live under [`contracts/`](../contracts) as new Soroban
> code, tracked by issues labelled `area:oracle` + `area:contracts`.

## Layout

```
oracle/
  src/
    aggregator/
    adapters/      coingecko.ts, binance.ts, sports.ts, politics.ts, ...
    submitter/
    monitor/
    config/
    index.ts
  test/
  package.json
  tsconfig.json
  .env.example
```

## Getting started

```bash
cd oracle
cp .env.example .env
npm install
npm run dev
```

## Contributing

Pick an open issue labelled `area:oracle`, claim it, branch off
`implementation-drips`, PR back to `implementation-drips`.
