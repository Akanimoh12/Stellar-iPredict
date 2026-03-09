<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="iPredict logo" />
</p>

<h1 align="center">iPredict — Prediction Market on Stellar</h1>

<p align="center">
  <a href="https://github.com/AkanEf);/ipredict-stellar/actions"><img src="https://img.shields.io/github/actions/workflow/status/AkanEf);/ipredict-stellar/ci.yml?branch=main&label=CI&logo=github" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Stellar-Soroban-blue?logo=stellar" alt="Stellar" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/tests-207%20passing-brightgreen" alt="Tests" />
</p>

> **Predict. Win or Lose — You Always Earn.** Decentralized prediction market on Stellar with near-zero fees and 5-second finality.

---

## Live Demo

**Frontend:** [https://ipredict-stellar.vercel.app](https://ipredict-stellar.vercel.app)

## Demo Video

🎬 [Watch Full MVP Flow on Loom](https://loom.com/share/ipredict-demo) — *Wallet connect → browse markets → place bet → view leaderboard → claim reward → referral flow*

##   Testnet Contracts
| Contract | Address | Explorer |
|----------|---------|----------|
| Prediction Market | `CDN6UUYR62ACCGLTKIJGJQ32MX27MKFBOS2S5E3CIYHS47FH6SVGX43P` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDN6UUYR62ACCGLTKIJGJQ32MX27MKFBOS2S5E3CIYHS47FH6SVGX43P) |
| IPREDICT Token | `CAIRYPO7H6JVWMWXVXWA3PJLH3TRLS7DBM2Q7ZLALI3RK2RAVC4B45ZY` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAIRYPO7H6JVWMWXVXWA3PJLH3TRLS7DBM2Q7ZLALI3RK2RAVC4B45ZY) | |
| Referral Registry | `CDGIN4AXHM3RU5MM73C5OMH5FQOTPN6EBDSNB347VC2MOG42IW4CWK22` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDGIN4AXHM3RU5MM73C5OMH5FQOTPN6EBDSNB347VC2MOG42IW4CWK22) |
| Leaderboard | `CAKIT7M76AGRG4JWSGP43SA53B2OUQDXXMVQDD3B7S24HR3OKTAX522C` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAKIT7M76AGRG4JWSGP43SA53B2OUQDXXMVQDD3B7S24HR3OKTAX522C) | 
---

## Features

- **Binary Prediction Markets** — Bet YES or NO on any question with XLM
- **Inclusive Reward System** — Both winners AND losers earn points + IPREDICT tokens
- **Onchain Referral Program** — Share your link, earn 0.5% of every referred bet + bonus points
- **Real-Time Leaderboard** — Rankings by points, volume, and win rate from onchain data
- **Social Sharing** — One-tap sharing to X, Telegram, WhatsApp after every bet
- **4 Independent Smart Contracts** — Single responsibility, independently testable
- **Near-Zero Fees** — Only 2% total (1.5% platform + 0.5% referrer)
- **5-Second Finality** — Instant settlement on Stellar/Soroban
- **Mobile-First Design** — Fully responsive glassmorphic UI
- **Non-Custodial** — Your keys, your funds. Smart contracts handle everything

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Next.js 14 Frontend                        │
│  (App Router • Tailwind CSS • Stellar Wallets Kit)             │
└──────────────┬──────────────┬──────────────┬──────────────┬─────┘
               │              │              │              │
        Soroban RPC      Soroban RPC    Soroban RPC    Soroban RPC
               │              │              │              │
  ┌────────────▼──┐ ┌────────▼────┐ ┌───────▼──────┐ ┌────▼────────┐
  │  Prediction   │ │  IPREDICT   │ │   Referral   │ │ Leaderboard │
  │    Market     │ │    Token    │ │   Registry   │ │             │
  │               │ │             │ │              │ │             │
  │ create_market │ │ mint        │ │ register     │ │ add_pts     │
  │ place_bet ────┼─┼─► mint ◄───┼─┤ credit ──────┼─┤ record_bet  │
  │ resolve    ───┼─┼─► mint     │ │ get_referrer │ │ get_stats   │
  │ claim      ───┼─┼─► mint     │ │ get_earnings │ │ get_top     │
  │ cancel        │ │ transfer   │ │ is_registered│ │ get_rank    │
  │ withdraw_fees │ │ balance    │ │              │ │             │
  └───────────────┘ └────────────┘ └──────────────┘ └─────────────┘
```

### Inter-Contract Call Flow

**Place Bet:** `PredictionMarket.place_bet()` → Transfers XLM via SAC → `ReferralRegistry.credit()` (splits fee: 0.5% to referrer, 1.5% to platform) → `Leaderboard.record_bet()` → `IPredictToken.mint()` (bet participation tokens)

**Resolve Market:** `PredictionMarket.resolve_market()` → Stores outcome onchain

**Claim Reward:** `PredictionMarket.claim()` → Calculates pro-rata payout → Transfers XLM to user → `Leaderboard.add_pts()` (win: 30 pts / lose: 10 pts) → `IPredictToken.mint()` (win: 10 IPRED / lose: 2 IPRED)

**Referral Registration:** `ReferralRegistry.register_referral()` → `Leaderboard.add_bonus_pts()` (5 pts) → `IPredictToken.mint()` (1 IPRED welcome bonus)

---

## Reward System

| Outcome | XLM Payout | Points | IPREDICT Tokens |
|---------|-----------|--------|-----------------|
| **Win** | Pro-rata share of losing pool | +30 pts | +10 IPRED |
| **Lose** | 0 XLM | +10 pts | +2 IPRED |
| **Cancelled** | Full refund | +10 pts | +2 IPRED |
| **Referral Registration** | — | +5 pts | +1 IPRED |
| **Referred Bet** (referrer earns) | 0.5% of bet | +3 pts | — |

### Payout Formula

$$\text{Payout} = \frac{\text{UserBet}}{\text{WinningSidePool}} \times \text{TotalPool}$$

### Fee Model

| Component | Rate | Recipient |
|-----------|------|-----------|
| Platform fee | 1.5% | Admin (accumulated, withdrawable) |
| Referral fee | 0.5% | Referrer's XLM wallet |
| **Total** | **2.0%** | Deducted at bet time |

*If bettor has no referrer, full 2% goes to platform.*

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Smart Contracts** | Rust + Soroban SDK | 1.85.0 / 20.3.1 |
| **Frontend** | Next.js (App Router) | 14.2.35 |
| **UI** | React + Tailwind CSS | 18.3.1 / 3.4.17 |
| **Language** | TypeScript | 5.7.3 |
| **Wallet** | Stellar Wallets Kit | Freighter, xBull, Albedo |
| **Testing** | Vitest + Testing Library | 2.1.9 |
| **Contract Testing** | `#[test]` + soroban-sdk testutils | — |
| **CI/CD** | GitHub Actions | Node 18/20 + Rust |
| **Deployment** | Vercel (frontend) + Stellar Testnet | — |

---

## Project Structure

```
ipredict-stellar/
├── .github/workflows/ci.yml       # CI pipeline (2 jobs)
├── contracts/
│   ├── Cargo.toml                  # Workspace manifest
│   ├── prediction_market/          # Core market logic (36 tests)
│   ├── ipredict_token/             # Platform token (11 tests)
│   ├── referral_registry/          # Referral tracking (13 tests)
│   └── leaderboard/                # Rankings + stats (10 tests)
├── frontend/
│   ├── public/                     # Favicon, OG image
│   ├── src/
│   │   ├── app/                    # Next.js pages (7 routes)
│   │   ├── components/             # 30+ React components
│   │   │   ├── layout/             # Navbar, Footer, MobileMenu
│   │   │   ├── market/             # MarketCard, BettingPanel, OddsBar…
│   │   │   ├── leaderboard/        # LeaderboardTable, Tabs, PlayerRow
│   │   │   ├── profile/            # BetHistory, PointsCard, Referral…
│   │   │   ├── social/             # ShareBetButton, SocialShareModal
│   │   │   ├── wallet/             # WalletConnect, WalletModal
│   │   │   ├── admin/              # CreateMarket, Resolve, Stats
│   │   │   └── ui/                 # Spinner, Skeleton, Toast, Badge…
│   │   ├── hooks/                  # useMarket, useWallet, useBet…
│   │   ├── services/               # Soroban RPC service layer
│   │   ├── utils/                  # Helpers, cache, formatting
│   │   ├── config/                 # Network constants
│   │   └── types/                  # TypeScript interfaces
│   ├── __tests__/                  # 9 test suites (137 tests)
│   └── .env.local.example          # Environment template
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT-GUIDE.md
│   ├── USER-FEEDBACK.md
│   └── ITERATION-LOG.md
└── README.md
```

---

## Getting Started

### Prerequisites

- **Rust** ≥ 1.85.0 with `wasm32-unknown-unknown` target
- **Node.js** ≥ 18
- **Stellar CLI** (`stellar-cli` or `soroban-cli`)
- **Freighter Wallet** browser extension (for testnet interaction)

### Setup

```bash
# Clone
git clone https://github.com/AkanEf);/ipredict-stellar.git
cd ipredict-stellar

# Build smart contracts
cd contracts
stellar contract build
cargo test   # 70 tests

# Setup frontend
cd ../frontend
cp .env.local.example .env.local
# Edit .env.local with your deployed contract IDs
npm install
npm test     # 137 tests
npm run build
npm run dev  # http://localhost:3000
```

### Deploy Contracts (Testnet)

See [docs/DEPLOYMENT-GUIDE.md](docs/DEPLOYMENT-GUIDE.md) for the full step-by-step deployment guide with correct dependency order.

---

## Deployed Contracts

| Contract | Address | Explorer |
|----------|---------|----------|
| Prediction Market | `CDN6UUYR62ACCGLTKIJGJQ32MX27MKFBOS2S5E3CIYHS47FH6SVGX43P` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDN6UUYR62ACCGLTKIJGJQ32MX27MKFBOS2S5E3CIYHS47FH6SVGX43P) |
| IPREDICT Token | `CAIRYPO7H6JVWMWXVXWA3PJLH3TRLS7DBM2Q7ZLALI3RK2RAVC4B45ZY` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAIRYPO7H6JVWMWXVXWA3PJLH3TRLS7DBM2Q7ZLALI3RK2RAVC4B45ZY) |
| Referral Registry | `CDGIN4AXHM3RU5MM73C5OMH5FQOTPN6EBDSNB347VC2MOG42IW4CWK22` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDGIN4AXHM3RU5MM73C5OMH5FQOTPN6EBDSNB347VC2MOG42IW4CWK22) |
| Leaderboard | `CAKIT7M76AGRG4JWSGP43SA53B2OUQDXXMVQDD3B7S24HR3OKTAX522C` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAKIT7M76AGRG4JWSGP43SA53B2OUQDXXMVQDD3B7S24HR3OKTAX522C) |

> **Network:** Stellar Testnet | **Admin:** `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD` | **10 seed markets** pre-loaded

---

## Testing

### Summary

| Suite | Tests | Status |
|-------|-------|--------|
| **Prediction Market** (Rust) | 36 | ✅ All passing |
| **Referral Registry** (Rust) | 13 | ✅ All passing |
| **IPREDICT Token** (Rust) | 11 | ✅ All passing |
| **Leaderboard** (Rust) | 10 | ✅ All passing |
| **Frontend Helpers** | 49 | ✅ All passing |
| **Frontend Cache** | 20 | ✅ All passing |
| **BettingPanel Component** | 13 | ✅ All passing |
| **MarketCard Component** | 10 | ✅ All passing |
| **LeaderboardTable Component** | 10 | ✅ All passing |
| **Navbar Component** | 7 | ✅ All passing |
| **WalletConnect Component** | 6 | ✅ All passing |
| **Market Service** | 12 | ✅ All passing |
| **Leaderboard Service** | 10 | ✅ All passing |
| **Total** | **207** | **✅ All passing** |

### Run Tests

```bash
# Rust contract tests
cd contracts && cargo test

# Frontend tests
cd frontend && npm test

# Frontend tests with coverage
cd frontend && npx vitest run --coverage
```

---

## CI/CD Pipeline

GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push to `main`/`develop` and every PR to `main`.

### Job 1: `lint-test-build`
- **Matrix:** Node.js 18, 20
- **Steps:** `npm ci` → `npm test` → `npm run build`
- **Artifacts:** Production build uploaded on Node 20

### Job 2: `contract-check`
- **Toolchain:** Rust stable + `wasm32-unknown-unknown` target
- **Steps:** `cargo check --workspace` → `cargo test --workspace`
- **Cache:** Cargo registry + target directory cached

---

## User Validation

### Testnet Users

| # | Wallet Address | Action | Date |
|---|---------------|--------|------|
| 1 | `GDHQ...SMSMD` | Created markets, placed bets | — |
| 2 | *pending* | — | — |
| 3 | *pending* | — | — |
| 4 | *pending* | — | — |
| 5 | *pending* | — | — |

*Wallets verifiable on [Stellar Expert Testnet Explorer](https://stellar.expert/explorer/testnet)*

### Feedback & Iteration

See [docs/USER-FEEDBACK.md](docs/USER-FEEDBACK.md) for the full feedback log.

**Iteration Summary:** After initial testnet deployment, user feedback on loading states led to replacing spinner-only loading indicators with content-aware skeleton placeholders across leaderboard, profile, and market detail pages — improving perceived performance and reducing layout shift.

---

## Smart Contract Functions

### Prediction Market

| Function | Description |
|----------|-------------|
| `initialize(admin, token, referral, leaderboard, xlm_sac)` | One-time setup with linked contracts |
| `create_market(admin, question, image_url, duration_secs)` | Create new prediction market |
| `place_bet(user, market_id, is_yes, amount)` | Place or increase bet (2% fee deducted) |
| `resolve_market(admin, market_id, outcome)` | Admin resolves with YES/NO outcome |
| `cancel_market(admin, market_id)` | Cancel market, enable refunds |
| `claim(user, market_id)` | Claim payout + points + tokens |
| `withdraw_fees(admin)` | Admin withdraws accumulated platform fees |
| `get_market(market_id)` | Read market data |
| `get_bet(market_id, user)` | Read user's bet on market |
| `get_market_count()` | Total markets created |
| `get_odds(market_id)` | Current YES/NO percentages |
| `get_market_bettors(market_id)` | List all bettors on a market |
| `get_accumulated_fees()` | Total unclaimed platform fees |

### IPREDICT Token

| Function | Description |
|----------|-------------|
| `initialize(admin, name, symbol, decimals)` | One-time token setup |
| `set_minter(minter)` | Authorize address to mint (multi-minter) |
| `remove_minter(minter)` | Revoke minting rights |
| `mint(minter, to, amount)` | Mint tokens (authorized minters only) |
| `transfer(from, to, amount)` | Transfer tokens between accounts |
| `burn(from, amount)` | Burn tokens |
| `balance(account)` | Get token balance |
| `total_supply()` | Total tokens minted |
| `name()` / `symbol()` / `decimals()` | Token metadata |

### Referral Registry

| Function | Description |
|----------|-------------|
| `initialize(admin, market, token, leaderboard, xlm_sac)` | One-time setup |
| `register_referral(user, display_name, referrer?)` | Register with optional referrer |
| `credit(caller, user, referral_fee)` | Credit referral fee (called by market contract) |
| `get_referrer(user)` | Get user's referrer address |
| `get_display_name(user)` | Get registered display name |
| `get_referral_count(user)` | Number of referrals |
| `get_earnings(user)` | Total referral earnings |
| `has_referrer(user)` / `is_registered(user)` | Status checks |

### Leaderboard

| Function | Description |
|----------|-------------|
| `initialize(admin, market, referral)` | One-time setup |
| `add_pts(caller, user, points, is_winner)` | Add win/loss points + update stats |
| `add_bonus_pts(caller, user, points)` | Add bonus points (no stat inflation) |
| `record_bet(caller, user)` | Increment total bets count |
| `get_points(user)` | Get user's total points |
| `get_stats(user)` | Full player stats (points, bets, wins, losses) |
| `get_top_players(limit)` | Sorted leaderboard |
| `get_rank(user)` | User's current rank |

---

## Roadmap

| Phase | Timeline | Milestone |
|-------|----------|-----------|
| **Foundation** | Feb 2026 | MVP launch, testnet, core markets |
| **Growth** | Q2 2026 | User-created markets, oracle resolution, categories |
| **Token Utility** | Q3 2026 | IPREDICT staking, governance, reward tiers |
| **Scale** | Q4 2026 | Mainnet launch, mobile app, cross-chain bridges |

---

## License

[MIT](LICENSE)

---

## Author

Built by **Akan** for the Stellar Build-a-10M-Startup challenge.

- Stellar Admin Wallet: `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD`
