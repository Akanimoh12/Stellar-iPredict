# Smart Contracts

Reference for the four Soroban contracts in [`contracts/`](../contracts): how they
call each other, the reward and fee model, and their public functions. The
contract source is authoritative; this page is a guide to it. Mainnet addresses
are in the [README](../README.md#deployed-contracts-stellar-mainnet).

- [Contracts](#contracts)
- [Inter-contract call flow](#inter-contract-call-flow)
- [Reward system](#reward-system)
- [Smart contract functions](#smart-contract-functions)
- [Building and testing](#building-and-testing)

## Contracts

| Crate | Responsibility |
|-------|----------------|
| `prediction_market` | Markets, bets, resolution (direct and optimistic oracle), payouts, platform fees |
| `ipredict_token` | The IPREDICT reward token, with multiple authorised minters |
| `referral_registry` | Referral registration, display names, referral fee credit |
| `leaderboard` | Points, win/loss stats and rankings |

Each contract has a single responsibility and is tested on its own. All are
upgradeable; see
[Contract Upgrade Procedure](DEPLOYMENT-GUIDE.md#contract-upgrade-procedure--storage-compatibility-rules)
and [Releasing](RELEASING.md#contracts).

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

## Inter-contract call flow

**Place Bet:** `PredictionMarket.place_bet()` → Transfers XLM via SAC → `ReferralRegistry.credit()` (splits fee: 0.5% to referrer, 1.5% to platform) → `Leaderboard.record_bet()` → `IPredictToken.mint()` (bet participation tokens)

**Resolve Market:** `PredictionMarket.resolve_market()` → Stores outcome onchain

**Claim Reward:** `PredictionMarket.claim()` → Calculates pro-rata payout → Transfers XLM to user → `Leaderboard.add_pts()` (win: 30 pts / lose: 10 pts) → `IPredictToken.mint()` (win: 10 IPRED / lose: 2 IPRED)

**Referral Registration:** `ReferralRegistry.register_referral()` → `Leaderboard.add_bonus_pts()` (5 pts) → `IPredictToken.mint()` (1 IPRED welcome bonus)

## Reward system

| Outcome | XLM Payout | Points | IPREDICT Tokens |
|---------|-----------|--------|-----------------|
| **Win** | Pro-rata share of losing pool | +30 pts | +10 IPRED |
| **Lose** | 0 XLM | +10 pts | +2 IPRED |
| **Cancelled** | Full refund | +10 pts | +2 IPRED |
| **Referral Registration** | — | +5 pts | +1 IPRED |
| **Referred Bet** (referrer earns) | 0.5% of bet | +3 pts | — |

### Payout formula

$$\text{Payout} = \frac{\text{UserBet}}{\text{WinningSidePool}} \times \text{TotalPool}$$

### Fee model

| Component | Rate | Recipient |
|-----------|------|-----------|
| Platform fee | 1.5% | Admin (accumulated, withdrawable) |
| Referral fee | 0.5% | Referrer's XLM wallet |
| **Total** | **2.0%** | Deducted at bet time |

*If bettor has no referrer, full 2% goes to platform.*

## Smart contract functions

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

## Building and testing

Requires Rust 1.85.0 or newer with the `wasm32-unknown-unknown` target and the
Stellar CLI.

```bash
cd contracts
stellar contract build
cargo test --workspace
```

`make test-contracts` from the repository root runs the same suite. Deployment,
with the correct dependency order, is in [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md).
