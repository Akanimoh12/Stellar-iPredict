# iPredict

**Predict. Win or Lose — You Always Earn.**

A decentralized prediction market on **Stellar/Soroban** where users bet XLM on YES/NO outcomes, winners split the pool, and **every participant** earns points + IPREDICT tokens — whether they win or lose. Fully onchain referral system and leaderboard drive viral growth.

![CI/CD](https://github.com/Akanimoh12/iPredict/actions/workflows/ci.yml/badge.svg)
![Stellar](https://img.shields.io/badge/Stellar-Soroban-7C3AED?logo=stellar&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Overview

- Users bet XLM on YES/NO prediction markets
- Winners split the pool (minus 2% fee: 1.5% platform + 0.5% referrer)
- **All participants earn rewards** — winners AND losers
- IPREDICT token minted as reward via inter-contract calls
- Onchain referral system: register a display name + referrer, earn 0.5% + 3 bonus points on every bet your referrals place
- Referral registration bonus: 5 points + 1 IPREDICT token as welcome gift
- No referrer? Platform keeps the full 2% fee — sustainable revenue model
- Onchain leaderboard ranked by points — shows display names instead of wallet addresses
- Social sharing: share your bet on X, Telegram, WhatsApp after placing a bet

### Why Stellar?

- **5-second finality** — bets confirm instantly
- **< $0.01 fees** — micro-bets of 1 XLM are practical
- **Rust/Soroban contracts** — type-safe, no reentrancy
- **Built-in asset support** — XLM native + custom tokens via SAC

---

## Reward System

Every user who participates in a resolved market earns rewards, regardless of outcome. This keeps users engaged and coming back.

| Outcome | Points | IPREDICT Tokens |
|---------|--------|-----------------|
| **Win** (correct prediction) | **30 points** | **10 IPREDICT** |
| **Loss** (wrong prediction) | **10 points** | **2 IPREDICT** |
| **Referral Registration** | **5 points** | **1 IPREDICT** |

### Payout Formula (Winners Only)

```
Each Bet:     2% fee deducted at bet time
              → 1.5% kept by platform (AccumulatedFees)
              → 0.5% sent to referrer (+ 3 bonus pts)
              → If no referrer: full 2% kept by platform
Net Amount:   Amount - 2% fee (enters the pool)
Total Pool:   All net YES bets + All net NO bets
User Payout:  (User Net Bet / Winning Side Net Total) × Total Pool
```

> **Split fee model:** The 2% is collected once at bet time. **1.5% stays in the contract** as platform revenue (`AccumulatedFees`, withdrawable by admin). **0.5% goes to the user's referrer** (+ 3 bonus points per referred bet). If the user has **no referrer**, the full 2% stays as platform revenue. No additional fee at claim time.

### Worked Example

```
Market: "Will XLM hit $0.50 by Friday?"

Total bets placed: 800 XLM (before fee)
  → 2% fee deducted at bet time: 16 XLM total
  → Fee split: ~12 XLM platform (1.5%) + ~4 XLM to referrers (0.5%)
     (unregistered users’ 0.5% also goes to platform → platform keeps more)
  → Net pool: 784 XLM (490 YES + 294 NO)

Outcome: YES wins ✅

Alice bet 50 XLM on YES (winner) — has referrer Bob:
  → Total fee: 1 XLM (2%)
     → 0.75 XLM (1.5%) → AccumulatedFees (platform keeps)
     → 0.25 XLM (0.5%) → sent to Bob (her referrer) + Bob earns 3 pts
  → Net bet: 49 XLM entered the YES pool
  → Payout: (49/490) × 784 = 78.4 XLM  (+56.8% profit)
  → Earns:  30 points + 10 IPREDICT tokens

Alice later increased her position with another 20 XLM on YES:
  → Total fee: 0.4 XLM (2%)
     → 0.30 XLM (1.5%) → platform  |  0.10 XLM (0.5%) → Bob + 3 pts
  → Additional net: 19.6 XLM added to her YES position (total: 68.6 XLM)
  → Total payout recalculated with her combined position

Dave bet 30 XLM on NO (loser) — has a referrer:
  → Total fee: 0.6 XLM (2%)
     → 0.45 XLM (1.5%) → platform  |  0.15 XLM (0.5%) → referrer + 3 pts
  → Net bet: 29.4 XLM entered the NO pool
  → Payout: 0 XLM (lost his bet)
  → Earns:  10 points + 2 IPREDICT tokens  ← still rewarded!

Dave tried to bet YES on the same market:
  → REJECTED — cannot bet on opposite side of existing position

Eve bet 20 XLM on YES, never registered (no referrer):
  → Total fee: 0.4 XLM (2%) → ALL stays as platform revenue
     → 0.30 XLM (1.5%) → AccumulatedFees
     → 0.10 XLM (0.5%) → also AccumulatedFees (no referrer → platform keeps full 2%)
  → Net bet: 19.6 XLM entered the YES pool
```

### Referral Registration Bonus

Users can optionally register a **display name** and a **referrer**. On registration they receive a **welcome bonus** of 5 points + 1 IPREDICT token. If no referrer is provided, the user has no custom referrer and the full 2% fee on their bets stays as platform revenue. Display names appear on the leaderboard instead of raw wallet addresses.

---

## Core Features

| Feature | Description |
|---------|-------------|
| **Prediction Markets** | Admin creates YES/NO markets with cover images and deadlines |
| **XLM Betting** | Users stake XLM on their prediction — can increase position on the same side, but cannot bet both sides |
| **Auto Payout** | Winners claim proportional share of the pool |
| **Points + Tokens for All** | Win = 30 pts + 10 IPREDICT, Lose = 10 pts + 2 IPREDICT |
| **IPREDICT Token** | Platform token minted via inter-contract call on claim |
| **Onchain Leaderboard** | Top 50 ranked by points — shows display name if registered |
| **Referral with Display Name** | Register a display name + optional referrer, earn 5 pts + 1 IPREDICT welcome bonus |
| **Platform Fee: 1.5% guaranteed** | Platform always keeps at least 1.5% — full 2% when user has no referrer |
| **Social Sharing** | Share your bet on X, Telegram, WhatsApp with one tap after betting |
| **Market Browser** | Filter by active, ending soon, resolved, cancelled with search and sort |
| **Market Images** | Each market has a cover image for visual appeal |
| **Activity Feed** | Live stream of bets and claims via Soroban events |
| **Mobile-First Design** | Fully responsive with sticky rounded navbar |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Rust / Soroban SDK 20.x |
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind CSS |
| Wallet | Freighter, xBull, Albedo via `@creit.tech/stellar-wallets-kit` |
| Stellar SDK | `@stellar/stellar-sdk` |
| Icons | `react-icons` (Feather SVG set) |
| Hosting | Vercel |
| CI/CD | GitHub Actions |

---

## Smart Contract Architecture

Four Soroban contracts connected via inter-contract calls:

```
┌──────────────────────────────────────────┐
│            iPredict System               │
│                                          │
│  ┌──────────────────┐                    │
│  │ PredictionMarket │  (core logic)      │
│  └───────┬──────────┘                    │
│          │ inter-contract calls          │
│    ┌─────┼──────────┐                    │
│    ▼     ▼          ▼                    │
│  ┌─────┐ ┌────────┐ ┌──────────────┐    │
│  │Refer│ │Leader- │ │  IPREDICT    │    │
│  │ral  │ │board   │ │  Token       │    │
│  └─────┘ └────────┘ └──────────────┘    │
└──────────────────────────────────────────┘
```

### Inter-Contract Flow

```
place_bet(market_id, YES, 100 XLM)
  ├─ Deduct 2% fee: 2 XLM (1.5% platform + 0.5% referrer)
  ├─ Transfer 100 XLM → contract (SAC)
  ├─ Add 1.5 XLM to AccumulatedFees (platform revenue)
  ├─ ReferralRegistry.credit(user, 0.5 XLM)   ← inter-contract
  │   └─ If custom referrer: send 0.5 XLM + 3 pts to referrer
  │   └─ If no referrer: returns false → market contract adds to AccumulatedFees (full 2%)
  ├─ If new bet: store bet (net 98 XLM); if existing same-side bet: add 98 XLM to position
  └─ Leaderboard.record_bet(user)             ← inter-contract

resolve_market(market_id, YES)
  └─ Mark market resolved onchain

cancel_market(market_id)  ← admin can cancel if event voided
  └─ Refund net bet amounts to all bettors (2% fee already distributed, not refunded)

claim(market_id)  ← called by ALL users (winners + losers)
  ├─ If winner: transfer payout from total pool (no additional fee deducted)
  ├─ Leaderboard.add_pts(user, 30 or 10)      ← inter-contract
  └─ IPredictToken.mint(user, 10 or 2)        ← inter-contract

register_referral("CryptoKing", referrer?)  ← optional but incentivized
  ├─ Store display name (shown on leaderboard)
  ├─ Assign referrer (if provided; otherwise no custom referrer → full 2% stays as platform fee)
  ├─ Leaderboard.add_bonus_pts(user, 5)       ← inter-contract (welcome bonus — no win/loss impact)
  └─ IPredictToken.mint(user, 1)              ← inter-contract (welcome token)
```

### Key Contract Functions

| Contract | Function | Description |
|----------|----------|-------------|
| **Market** | `create_market` | Admin creates YES/NO market with image |
| **Market** | `place_bet` | User bets XLM (or increases existing position on same side), 2% fee split: 1.5% platform + 0.5% referrer |
| **Market** | `resolve_market` | Admin declares outcome |
| **Market** | `claim` | User claims rewards (winners get XLM + tokens, losers get tokens) |
| **Market** | `cancel_market` | Admin cancels market, refunds net bet amounts to all bettors |
| **Market** | `withdraw_fees` | Admin withdraws accumulated platform fees |
| **Token** | `mint` | Mint IPREDICT tokens to user (called by Market contract) |
| **Referral** | `register_referral` | Register display name + optional referrer, earn 5 pts + 1 IPREDICT welcome bonus |
| **Referral** | `credit` | Route 0.5% to referrer + 3 bonus pts (returns bool; false = no referrer, caller keeps fee) |
| **Referral** | `get_display_name` | Return user's display name (used on leaderboard) |
| **Leaderboard** | `add_pts` | Award 30 (win) or 10 (loss) points |
| **Leaderboard** | `add_bonus_pts` | Award welcome bonus points without affecting win/loss counters |
| **Leaderboard** | `get_top_players` | Get sorted top-N ranking with display names |

---

## Frontend Pages

| Page | Purpose |
|------|---------|
| **Landing** | Hero, featured markets, how-it-works, stats |
| **Markets** | Browse/filter/search all markets |
| **Market Detail** | Bet panel, odds bar, countdown, activity feed |
| **Leaderboard** | Top 50 by points with win rates |
| **Profile** | Bet history, points, IPREDICT balance, referral link |
| **Admin** | Create markets, resolve outcomes, cancel markets, withdraw platform fees |

---

## Deployment

```bash
# Build & deploy contracts
stellar contract build
stellar contract deploy --wasm target/.../prediction_market.wasm --network testnet
stellar contract deploy --wasm target/.../ipredict_token.wasm --network testnet
stellar contract deploy --wasm target/.../referral_registry.wasm --network testnet
stellar contract deploy --wasm target/.../leaderboard.wasm --network testnet

# Initialize with inter-contract links
stellar contract invoke --id $MARKET_ID --network testnet \
  -- initialize --admin $ADMIN --token $TOKEN_ID \
  --referral $REFERRAL_ID --leaderboard $LEADERBOARD_ID

# Frontend
npm install && npm run dev     # development
npm run build                  # production → Vercel auto-deploys
```

---

## User Acquisition (20 Users in 24h)

| Channel | Action |
|---------|--------|
| Twitter/X | Thread with screenshots + demo link |
| Stellar Discord | Share in #showcase |
| Referral chain | First 5 users refer 2+ each (0.5% + 3 pts per bet incentive) |
| Telegram | Nigerian crypto groups |
| Direct | WhatsApp friends with faucet link |

**Seed markets before launch:** XLM price predictions, sports, pop culture, crypto events — things people have strong opinions on.

---

## Roadmap

- **Feb 2026 (MVP):** Markets, betting, claim, IPREDICT token rewards, referrals, leaderboard
- **v2:** User-created markets, oracle auto-resolution, categories
- **v3:** IPREDICT governance staking, mobile app, cross-chain deposits
- **v4:** Mainnet launch with real XLM

---

## License

MIT

---

*Built on Stellar/Soroban — Level 5 Black Belt MVP*  
*Author: Akanimoh | 2026*
