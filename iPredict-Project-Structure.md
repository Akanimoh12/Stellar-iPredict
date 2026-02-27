# iPredict — Project Structure & Architecture

> A comprehensive project structure and development guide for building the iPredict prediction market MVP on Stellar/Soroban. **No code implementation** — this document defines the folder structure, file responsibilities, component flow, contract architecture, and development patterns.

---

## Root Folder Structure

```
ipredict-stellar/
├── .github/
│   └── workflows/
│       └── ci.yml
├── contracts/
│   ├── Cargo.toml              # [workspace] — all 4 contract crates
│   ├── prediction_market/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       └── test.rs
│   ├── ipredict_token/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       └── test.rs
│   ├── referral_registry/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       └── test.rs
│   └── leaderboard/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           └── test.rs
├── frontend/
│   ├── public/
│   │   ├── favicon.ico
│   │   ├── og-image.png
│   │   └── images/
│   │       └── markets/
│   │           ├── xlm-price.png
│   │           ├── bitcoin.png
│   │           ├── football.png
│   │           ├── crypto-event.png
│   │           └── default-market.png
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   ├── globals.css
│   │   │   ├── providers.tsx
│   │   │   ├── markets/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   ├── leaderboard/
│   │   │   │   └── page.tsx
│   │   │   ├── profile/
│   │   │   │   └── page.tsx
│   │   │   └── admin/
│   │   │       └── page.tsx
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Navbar.tsx
│   │   │   │   ├── Footer.tsx
│   │   │   │   └── MobileMenu.tsx
│   │   │   ├── market/
│   │   │   │   ├── MarketCard.tsx
│   │   │   │   ├── MarketGrid.tsx
│   │   │   │   ├── MarketFilters.tsx
│   │   │   │   ├── BettingPanel.tsx
│   │   │   │   ├── OddsBar.tsx
│   │   │   │   ├── CountdownTimer.tsx
│   │   │   │   └── MarketImage.tsx
│   │   │   ├── leaderboard/
│   │   │   │   ├── LeaderboardTable.tsx
│   │   │   │   ├── LeaderboardTabs.tsx
│   │   │   │   └── PlayerRow.tsx
│   │   │   ├── profile/
│   │   │   │   ├── BetHistory.tsx
│   │   │   │   ├── PointsCard.tsx
│   │   │   │   ├── TokenBalance.tsx
│   │   │   │   └── ReferralStats.tsx
│   │   │   ├── social/
│   │   │   │   ├── ShareBetButton.tsx
│   │   │   │   └── SocialShareModal.tsx
│   │   │   ├── wallet/
│   │   │   │   ├── WalletConnect.tsx
│   │   │   │   └── WalletModal.tsx
│   │   │   ├── admin/
│   │   │   │   ├── CreateMarketForm.tsx
│   │   │   │   ├── ResolveMarketPanel.tsx
│   │   │   │   └── PlatformStats.tsx
│   │   │   └── ui/
│   │   │       ├── Spinner.tsx
│   │   │       ├── Skeleton.tsx
│   │   │       ├── TxProgress.tsx
│   │   │       ├── Toast.tsx
│   │   │       ├── Badge.tsx
│   │   │       └── EmptyState.tsx
│   │   ├── hooks/
│   │   │   ├── useMarkets.ts
│   │   │   ├── useMarket.ts
│   │   │   ├── useBet.ts
│   │   │   ├── useClaim.ts
│   │   │   ├── useLeaderboard.ts
│   │   │   ├── useReferral.ts
│   │   │   ├── useToken.ts
│   │   │   ├── useProfile.ts
│   │   │   └── useWallet.tsx
│   │   ├── services/
│   │   │   ├── soroban.ts
│   │   │   ├── market.ts
│   │   │   ├── token.ts
│   │   │   ├── referral.ts
│   │   │   ├── leaderboard.ts
│   │   │   ├── events.ts
│   │   │   └── cache.ts
│   │   ├── config/
│   │   │   └── network.ts
│   │   ├── types/
│   │   │   └── index.ts
│   │   ├── utils/
│   │   │   ├── helpers.ts
│   │   │   └── share.ts
│   │   ├── wallet/
│   │   │   ├── kit.ts
│   │   │   └── types.ts
│   │   └── __tests__/
│   │       ├── helpers.test.ts
│   │       ├── cache.test.ts
│   │       ├── market.test.ts
│   │       ├── leaderboard.test.ts
│   │       ├── components/
│   │       │   ├── Navbar.test.tsx
│   │       │   ├── MarketCard.test.tsx
│   │       │   ├── BettingPanel.test.tsx
│   │       │   ├── LeaderboardTable.test.tsx
│   │       │   └── WalletConnect.test.tsx
│   │       └── test-setup.ts
│   ├── next.config.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── postcss.config.js
│   ├── tailwind.config.ts
│   ├── .npmrc
│   └── .env.local
├── docs/
│   ├── ARCHITECTURE.md
│   ├── USER-FEEDBACK.md
│   ├── DEPLOYMENT-GUIDE.md
│   └── ITERATION-LOG.md
├── .gitignore
├── README.md
└── LICENSE
```

---

## Smart Contracts — Structure & Flow

### Contract Workspace

Each contract is an independent Rust crate under a shared Cargo workspace:

```
contracts/
├── Cargo.toml        # [workspace] members = ["prediction_market", "ipredict_token", "referral_registry", "leaderboard"]
└── <contract_name>/
    ├── Cargo.toml    # crate-type = ["cdylib"], soroban-sdk = "20.3.1"
    └── src/
        ├── lib.rs    # #![no_std], contract logic, events, inter-contract calls
        └── test.rs   # #![cfg(test)], comprehensive test coverage
```

The workspace `Cargo.toml` ensures consistent dependency versions across all 4 contracts and enables `cargo build --workspace` / `cargo test --workspace`.

**Cargo.toml pattern (all 4 contracts):**
- `[lib]` → `crate-type = ["cdylib"]`
- `[dependencies]` → `soroban-sdk = "20.3.1"`
- `[dev-dependencies]` → `soroban-sdk = { version = "20.3.1", features = ["testutils"] }`
- `[profile.release]` → `opt-level = "z"`, `lto = true`, `panic = "abort"`, `strip = "symbols"`

### Contract 1: `prediction_market` — Core Logic

**Storage keys** (via `#[contracttype] enum DataKey`):
- `Admin` — admin address
- `MarketCount` — u64
- `Market(u64)` — Market struct
- `Bet(u64, Address)` — Bet struct per (market_id, user) — **one side per user per market** (users can increase their position with additional bets on the same side, but cannot bet on the opposite side)
- `BettorCount(u64)` — u32 count of unique bettors per market
- `BettorAt(u64, u32)` — Address at index for market (bounded enumeration, avoids unbounded Vec that would hit Soroban storage limits on popular markets)
- `TokenContract` — IPREDICT token contract address
- `ReferralContract` — ReferralRegistry contract address
- `LeaderboardContract` — Leaderboard contract address
- `AccumulatedFees` — i128 (platform fees accumulated from bets, withdrawable by admin)

**Structs:**
- `Market` — id, question, image_url, end_time, total_yes, total_no, resolved, outcome, cancelled, creator, bet_count
- `Bet` — amount, is_yes, claimed

> **Fee model (single 2% fee — split for sustainable revenue):** A 2% fee is deducted **once** at bet time. The fee is split: **1.5% (150 bps) stays in the contract as platform revenue** (`AccumulatedFees`) and **0.5% (50 bps) is sent to the user's referrer** via `ReferralRegistry.credit()`. The referrer also earns **3 bonus points** per referred bet. If the user has **no custom referrer**, the full 2% stays in the contract as platform revenue (no XLM leaves). There is **no additional fee at claim time**. User bets 100 XLM → 1.5 XLM kept by contract + 0.5 XLM sent to referrer (+ 3 pts) → 98 XLM enters the pool. Winners split the **entire pool** with no further deduction. Admin can withdraw accumulated platform fees via `withdraw_fees()`.

**Functions:**

| Function | Access | Flow |
|----------|--------|------|
| `initialize(admin, token_id, referral_id, leaderboard_id)` | Admin | Store admin + linked contract addresses + set `AccumulatedFees = 0` |
| `create_market(question, image_url, duration_secs)` | Admin | Increment MarketCount, store new Market with auto-incremented ID, emit `market_created` event |
| `place_bet(user, market_id, is_yes, amount)` | Public | `user.require_auth()` → validate market active + not expired + not cancelled + amount >= 1 XLM (minimum bet) + user hasn’t already bet on this market → calculate fees: `total_fee = amount * 200 / 10000` (2%), `platform_fee = amount * 150 / 10000` (1.5%), `referral_fee = total_fee - platform_fee` (0.5%), `net = amount - total_fee` → SAC transfer: full `amount` XLM from user → contract → add `platform_fee` to `AccumulatedFees` → inter-contract call `ReferralRegistry.credit(user, referral_fee)` → registry checks if user has custom referrer internally: if yes, sends 0.5% to referrer + 3 bonus pts; if no, returns false and `place_bet` adds `referral_fee` to `AccumulatedFees` (platform keeps full 2%) → store Bet with `net` amount, add user to `BettorAt` index, increment `BettorCount`, update market totals with `net` → inter-contract call `Leaderboard.record_bet(user)` → emit `bet_placed` event |
| `resolve_market(market_id, outcome)` | Admin | Validate market exists + not resolved + not cancelled + past deadline → set resolved=true, outcome → emit `market_resolved` event |
| `cancel_market(market_id)` | Admin | Validate market exists + not resolved → set cancelled=true → iterate `BettorAt` entries → refund each bettor’s net amount via SAC transfer → emit `market_cancelled` event. Note: the 2% fee (platform + referral portions) already distributed at bet time is NOT refunded |
| `claim(user, market_id)` | Public | `user.require_auth()` → validate market resolved + not cancelled + user has bet + not claimed → determine if winner → if winner: calculate payout = `(user_net_bet / winning_side_total) × total_pool` (entire pool, no additional fee), transfer XLM → inter-contract call `Leaderboard.add_pts(user, 30, true)` + `IPredictToken.mint(user, 10_0000000)` → if loser: inter-contract call `Leaderboard.add_pts(user, 10, false)` + `IPredictToken.mint(user, 2_0000000)` → mark claimed → emit `reward_claimed` event |
| `get_market(market_id)` | View | Return Market struct |
| `get_bet(market_id, user)` | View | Return Bet struct |
| `get_market_count()` | View | Return total markets created |
| `get_odds(market_id)` | View | Calculate YES% and NO% from net totals |
| `get_market_bettors(market_id)` | View | Return Vec of bettor addresses using `BettorCount` + `BettorAt` indexed reads |
| `get_accumulated_fees()` | View | Return current `AccumulatedFees` balance |
| `withdraw_fees(admin)` | Admin | `admin.require_auth()` → transfer `AccumulatedFees` XLM to admin → reset `AccumulatedFees` to 0 → emit `fees_withdrawn` event |

**Inter-contract calls (same pattern as green-belt `env.invoke_contract`):**
- `place_bet` → calls `ReferralRegistry.credit()` + `Leaderboard.record_bet()`
- `claim` → calls `Leaderboard.add_pts()` + `IPredictToken.mint()`

**Events emitted:**
- `market_created` — (market_id, question, end_time)
- `bet_placed` — (market_id, user, is_yes, amount, net_amount, fee, is_increase)
- `market_resolved` — (market_id, outcome)
- `market_cancelled` — (market_id, refunded_count)
- `reward_claimed` — (market_id, user, payout_xlm, points, tokens)
- `fees_withdrawn` — (admin, amount)

**Tests in `test.rs`:**
- Initialize contract with linked addresses
- Create market successfully
- Place YES bet and verify net amount (after 2% fee) added to totals
- Place NO bet and verify net amount added to totals
- Verify fee split: 1.5% to AccumulatedFees, 0.5% routed to referrer via inter-contract call
- Verify full 2% to AccumulatedFees when user has no custom referrer
- Verify referrer earns 3 bonus points per referred bet
- Reject bet on expired market
- Reject bet on resolved market
- Reject bet on cancelled market
- Reject bet below minimum (< 1 XLM)
- Increase existing YES position and verify cumulative net amount in totals
- Reject opposite-side bet (user bet YES, tries to bet NO → error)
- Resolve market and verify state
- Reject double resolution
- Cancel market and verify all bettors refunded their net amounts
- Reject cancel on already resolved market
- Claim as winner — verify XLM payout from full pool (no additional fee) + inter-contract calls
- Claim as loser — verify no XLM payout + still gets points & tokens
- Reject double claim
- Reject claim on unresolved market
- Reject claim on cancelled market
- Get odds calculation accuracy on net totals
- Admin withdraw_fees transfers AccumulatedFees and resets to 0
- Reject withdraw_fees by non-admin
- BettorCount and BettorAt indexed enumeration

### Contract 2: `ipredict_token` — Platform Token

**Storage keys:**
- `Admin` — admin address
- `AuthorizedMinter(Address)` — bool map of approved minters (supports multiple: PredictionMarket + ReferralRegistry)
- `Balance(Address)` — i128
- `TotalSupply` — i128
- `Name` — String ("IPREDICT")
- `Symbol` — String ("IPRED")
- `Decimals` — u32 (7)

**Functions:**

| Function | Access | Flow |
|----------|--------|------|
| `initialize(admin, name, symbol, decimals)` | Admin | Store token metadata, set admin |
| `set_minter(minter)` | Admin | Store `AuthorizedMinter(minter) = true` — can be called multiple times to add both PredictionMarket and ReferralRegistry as authorized minters |
| `remove_minter(minter)` | Admin | Remove `AuthorizedMinter(minter)` — revoke minting permission |
| `mint(to, amount)` | Authorized minter | Validate `AuthorizedMinter(caller) == true` → increment balance + total supply → emit `mint` event |
| `balance(account)` | View | Return balance |
| `total_supply()` | View | Return total supply |
| `transfer(from, to, amount)` | Public | `from.require_auth()` → debit from, credit to → emit `transfer` event |
| `burn(from, amount)` | Public | `from.require_auth()` → debit balance, reduce supply → emit `burn` event |
| `name()` | View | Return "IPREDICT" |
| `symbol()` | View | Return "IPRED" |
| `decimals()` | View | Return 7 |

**Tests:**
- Initialize with metadata
- Add multiple authorized minters via `set_minter`
- Mint by first authorized minter (PredictionMarket)
- Mint by second authorized minter (ReferralRegistry)
- Reject mint by non-minter
- Remove minter via `remove_minter` and reject subsequent mint
- Balance check after mint
- Transfer between accounts
- Reject transfer with insufficient balance
- Burn tokens
- Total supply tracking

### Contract 3: `referral_registry` — Onchain Referral & Identity

**Storage keys:**
- `Admin` — admin address
- `MarketContract` — authorized caller (PredictionMarket)
- `Referrer(Address)` — who referred this user
- `DisplayName(Address)` — String (user-chosen display name, e.g. "CryptoKing")
- `ReferralCount(Address)` — number of people referred
- `ReferralEarnings(Address)` — total XLM earned from referrals
- `Registered(Address)` — bool (whether user has registered)
- `TokenContract` — IPREDICT token contract address (for minting welcome bonus)
- `LeaderboardContract` — Leaderboard contract address (for awarding welcome points)

**Functions:**

| Function | Access | Flow |
|----------|--------|------|
| `initialize(admin, market_contract, token_contract, leaderboard_contract)` | Admin | Store admin + authorized caller + linked contracts |
| `register_referral(user, display_name, referrer)` | Public | `user.require_auth()` → validate not already registered, user != referrer → store display name → if referrer provided: store referrer + increment referrer's count, else: no custom referrer stored (platform keeps full 2% on their bets) → inter-contract call `Leaderboard.add_bonus_pts(user, 5)` for welcome bonus → inter-contract call `IPredictToken.mint(user, 1_0000000)` for 1 IPREDICT welcome token → emit `referral_registered` event |
| `credit(user, referral_fee)` | Market contract | Validate caller is market contract → if user has custom referrer: transfer `referral_fee` XLM to referrer via SAC + `Leaderboard.add_bonus_pts(referrer, 3)` (3 pts per referred bet) + accumulate earnings → emit `referral_credited` event. If no custom referrer: return `false` (no transfer made — caller adds `referral_fee` to `AccumulatedFees`) |
| `get_referrer(user)` | View | Return referrer address (custom referrer or None if unregistered) |
| `get_display_name(user)` | View | Return display name string (empty if not registered) |
| `get_referral_count(user)` | View | Return count |
| `get_earnings(user)` | View | Return total earnings |
| `has_referrer(user)` | View | Return bool (true if user has a custom referrer) |
| `is_registered(user)` | View | Return bool |

**Important:** Registration is optional — users can bet without registering. However, registering gives a **5-point + 1 IPREDICT welcome bonus** and lets users set a **display name** shown on the leaderboard. Users who never register have no custom referrer, so the full 2% fee from their bets stays in the contract as platform revenue. Users who register with a referrer split the fee: 1.5% platform + 0.5% to referrer (+ 3 bonus points per referred bet).

**Tests:**
- Register with display name + custom referrer successfully
- Register with display name + no referrer → no custom referrer stored (full 2% stays as platform fee on their bets)
- Welcome bonus: 5 points via `add_bonus_pts` + 1 IPREDICT minted on registration (inter-contract calls verified, no win/loss counter impact)
- Reject self-referral
- Reject double registration
- Display name stored and retrievable
- Credit routes 0.5% to custom referrer when exists + awards 3 bonus points to referrer
- Credit returns false when no custom referrer (caller adds to AccumulatedFees)
- Earnings accumulation across multiple credits
- Referrer bonus points accumulate (3 per referred bet)
- Referral count tracking

### Contract 4: `leaderboard` — Onchain Points & Rankings

**Storage keys:**
- `Admin` — admin address
- `MarketContract` — authorized caller (PredictionMarket + ReferralRegistry for welcome bonus)
- `Points(Address)` — u64
- `TotalBets(Address)` — u32
- `WonBets(Address)` — u32
- `LostBets(Address)` — u32
- `TopPlayers` — Vec of (Address, u64 points) sorted descending, max 50 entries

**Functions:**

| Function | Access | Flow |
|----------|--------|------|
| `initialize(admin, market_contract)` | Admin | Store admin + authorized callers (market contract + referral contract) |
| `add_pts(user, points, is_winner)` | Market contract | Validate caller → add points to user → if is_winner: increment won_bets, else: increment lost_bets → update sorted TopPlayers list (insert or replace with binary search) → emit `points_awarded` event |
| `add_bonus_pts(user, points)` | Referral contract | Validate caller → add points to user → update sorted TopPlayers list → emit `points_awarded` event. **Does NOT modify won_bets or lost_bets** — used for welcome bonus (5 pts) and referral bet rewards (3 pts per referred bet) |
| `record_bet(user)` | Market contract | Increment total_bets for user |
| `get_points(user)` | View | Return points |
| `get_stats(user)` | View | Return (points, total_bets, won_bets, lost_bets) |
| `get_top_players(limit)` | View | Return top N from sorted list |
| `get_rank(user)` | View | Return position in top players or 0 if unranked |

**Note:** The leaderboard stores points and stats by wallet address. The frontend resolves display names by calling `ReferralRegistry.get_display_name(address)` for each player. If a user has a registered display name, it is shown on the leaderboard; otherwise, the truncated wallet address is shown.

**Tests:**
- Add points and verify balance
- Accumulate points across multiple adds
- `add_bonus_pts` awards points without modifying won/lost counters
- Top players sorted correctly after inserts
- Top 50 cap — 51st player doesn't enter if below threshold
- Record bet increments counter
- Get stats returns correct aggregate (welcome bonus points don't inflate win/loss)
- Rank calculation

### Inter-Contract Call Flow (Complete)

```
USER PLACES A BET (2% fee deducted at bet time — split: 1.5% platform + 0.5% referrer)
───────────────────────────────────────────────────────────────────────────────────
User → PredictionMarket.place_bet(user, market_id, YES, 100 XLM)
  │
  ├─ 1. user.require_auth()
  ├─ 2. Validate: market active, not expired, not cancelled
  ├─ 3. If user has existing bet: validate is_yes matches (reject opposite-side bet)
  ├─ 4. Calculate: total_fee = 100 × 200 / 10000 = 2 XLM
  │     platform_fee = 100 × 150 / 10000 = 1.5 XLM
  │     referral_fee = 2 - 1.5 = 0.5 XLM
  │     net = 100 - 2 = 98 XLM
  ├─ 5. SAC transfer: 100 XLM from user → PredictionMarket contract
  ├─ 6. Add platform_fee (1.5 XLM) to AccumulatedFees
  ├─ 7. ReferralRegistry.credit(user, 0.5 XLM)     ← inter-contract (write)
  │     ├─ If user has custom referrer:
  │     │   ├─ SAC transfer: 0.5 XLM from contract → referrer
  │     │   ├─ Leaderboard.add_bonus_pts(referrer, 3)  ← 3 pts per referred bet
  │     │   └─ Accumulate referrer earnings
  │     └─ If no custom referrer:
  │         └─ Return false → caller adds 0.5 XLM to AccumulatedFees (platform keeps full 2%)
  ├─ 8. Leaderboard.record_bet(user)               ← inter-contract (write)
  ├─ 9. If new bet: store Bet struct (net=98 XLM), add to BettorAt index
  │     If existing bet: add net (98 XLM) to existing Bet.amount
  ├─ 10. Update Market totals with net amount
  └─ 11. Emit bet_placed event (includes amount, net_amount, fee, is_increase)

  Fee flow summary:
  • User with custom referrer: 1.5 XLM → AccumulatedFees + 0.5 XLM → referrer + 3 pts
  • User without referrer:     2.0 XLM → AccumulatedFees (platform keeps full 2%)
  • No additional fee at claim time. Admin can withdraw AccumulatedFees.


ADMIN RESOLVES MARKET
─────────────────────
Admin → PredictionMarket.resolve_market(market_id, YES)
  │
  ├─ 1. admin.require_auth()
  ├─ 2. Validate: market exists, not already resolved, not cancelled
  ├─ 3. Set resolved = true, outcome = YES
  └─ 4. Emit market_resolved event


ADMIN CANCELS MARKET (event voided, mistake, etc.)
───────────────────────────────────────────────────
Admin → PredictionMarket.cancel_market(market_id)
  │
  ├─ 1. admin.require_auth()
  ├─ 2. Validate: market exists, not already resolved
  ├─ 3. Set cancelled = true
  ├─ 4. Iterate BettorAt(market_id, 0..count) → refund each bettor's net amount
  │     └─ SAC transfer: net_amount XLM from contract → each bettor
  └─ 5. Emit market_cancelled event

  Note: The 2% fee (platform + referral portions) already collected at bet time is NOT refunded.
  Users get back their net bet amount. This prevents abuse of cancel to drain referral fees.


USER CLAIMS REWARDS (winner or loser)
─────────────────────────────────────
User → PredictionMarket.claim(user, market_id)
  │
  ├─ 1. user.require_auth()
  ├─ 2. Validate: market resolved, not cancelled, user has bet, not claimed
  ├─ 3. Determine: did user win or lose?
  │
  ├─ IF WINNER:
  │   ├─ Calculate payout = (user_net_bet / winning_side_total) × total_pool
  │   │   (total_pool = all net bets from both sides — no additional fee deducted)
  │   ├─ SAC transfer: payout XLM from contract → user
  │   ├─ Leaderboard.add_pts(user, 30, true)        ← inter-contract
  │   └─ IPredictToken.mint(user, 10_0000000)        ← inter-contract (7 decimals)
  │
  ├─ IF LOSER:
  │   ├─ No XLM payout
  │   ├─ Leaderboard.add_pts(user, 10, false)        ← inter-contract
  │   └─ IPredictToken.mint(user, 2_0000000)          ← inter-contract (7 decimals)
  │
  ├─ 4. Mark bet as claimed
  └─ 5. Emit reward_claimed event


USER REGISTERS FOR REFERRAL (optional but incentivized)
────────────────────────────────────────────────────────
User → ReferralRegistry.register_referral(user, "CryptoKing", referrer?)
  │
  ├─ 1. user.require_auth()
  ├─ 2. Validate: not already registered, user != referrer
  ├─ 3. Store display name "CryptoKing"
  ├─ 4. If referrer provided: store referrer + increment referrer's count
  │     If no referrer:       no custom referrer stored (platform keeps full 2% on their bets)
  ├─ 5. Leaderboard.add_bonus_pts(user, 5)          ← inter-contract (welcome bonus — no win/loss impact)
  ├─ 6. IPredictToken.mint(user, 1_0000000)           ← inter-contract (1 IPREDICT)
  └─ 7. Emit referral_registered event
```

---

## Frontend — Next.js App Structure & Flow

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Stellar SDK | `@stellar/stellar-sdk` |
| Wallet Kit | `@creit.tech/stellar-wallets-kit` (Freighter, xBull, Albedo) |
| Icons | `react-icons` (Feather icons `fi` set — real SVG icons, no emoji characters) |
| Testing | Vitest + React Testing Library |
| Hosting | Vercel |

### Next.js App Router Pages

All page components are server components by default. Interactive components use `'use client'` directive.

#### `app/layout.tsx` — Root Layout

- Wraps entire app in `<Providers>` (wallet context, toast provider)
- Imports global CSS (`globals.css` with Tailwind)
- Sets metadata: title, description, Open Graph image (`og-image.png`)
- Contains `<Navbar />` (sticky with rounded bottom corners) and `<Footer />`
- Google Fonts: Inter (body) + Space Grotesk (headings)
- Buffer polyfill for Stellar SDK compatibility
- **React error boundaries** wrapping each major page section (market grid, betting panel, leaderboard table) — a failed contract call in one component doesn’t crash the entire page. Each boundary renders a "Something went wrong — Retry" fallback card.

#### `app/providers.tsx` — Client Context Wrapper

- `'use client'` component
- Wraps children in `<WalletProvider>` from `hooks/useWallet.tsx`
- Handles dynamic import of wallet kit (client-only, no SSR)

#### `app/page.tsx` — Landing Page (`/`)

**Design reference: tipz-rosy.vercel.app landing page pattern**

**Sections in order:**

1. **Hero Section**
   - Bold headline: "Predict. Win or Lose — You Always Earn."
   - Subtitle: "Decentralized prediction market on Stellar. Near-zero fees. 5-second finality."
   - Two CTA buttons: "Explore Markets" (primary) → `/markets` | "View Leaderboard" (secondary) → `/leaderboard`
   - Live stats row: Total Markets | Total Volume (XLM) | Total Predictors | IPREDICT Minted
   - Badge: "Live on Stellar Testnet | Low 2% fee"

2. **Feature Cards (3-column grid)**
   - "Instant Settlement" — icon: `FiZap` — "Bets confirm in 5 seconds via Stellar"
   - "Everyone Earns" — icon: `FiGift` — "Win: 30 pts + 10 IPRED. Lose: 10 pts + 2 IPRED"
   - "Fully Onchain" — icon: `FiShield` — "All bets, payouts, and rankings stored on Soroban"

3. **How It Works (numbered steps — tipz-style numbered cards)**
   - Step 01: "Connect Wallet" — Connect Freighter, xBull, or Albedo. No signup needed.
   - Step 02: "Pick a Market" — Browse active predictions. Crypto, sports, events.
   - Step 03: "Bet YES or NO" — Stake XLM on your prediction. See live odds.
   - Step 04: "Earn Rewards" — Win or lose, you earn points + IPREDICT tokens.

4. **Featured Markets (horizontal scroll or 3-card grid)**
   - Pulls from `useMarkets()` hook — top 3 by volume or ending soonest
   - Each card: `<MarketCard />` with market image, question, odds bar, pool, countdown, "Bet Now"

5. **Top Creators / Leaderboard Preview (tipz-style)**
   - Shows top 3 players from `useLeaderboard()` hook
   - Medal icons (using `FiAward` or gold/silver/bronze colored badges)
   - "View All" link → `/leaderboard`

6. **Additional Features Grid (6-card, 2-column — tipz-style)**
   - "Onchain Referrals" — Share your link, earn 0.5% + 3 bonus points on every bet placed by your referrals
   - "Social Sharing" — Share your prediction on X, Telegram, WhatsApp with one tap
   - "Live Activity" — Real-time event feed of all bets and claims across markets
   - "IPREDICT Token" — Platform token earned by every participant, win or lose
   - "Non-Custodial" — Your keys, your funds. Smart contracts handle everything
   - "Mobile-First" — Full experience on mobile. Bet on the go

7. **Roadmap / Journey (tipz-style timeline)**
   - Feb 2026: Foundation — MVP launch, testnet, core markets
   - Q2 2026: Growth — User-created markets, oracle resolution, categories
   - Q3 2026: Token Utility — IPREDICT staking, governance, rewards tiers
   - Q4 2026: Scale — Mainnet launch, mobile app, cross-chain

8. **CTA Footer Section**
   - "Start Predicting Today" with connect wallet button
   - "No signup required. Just connect and bet."
   - Links to: Twitter, GitHub, Stellar Discord

#### `app/markets/page.tsx` — Market Browser (`/markets`)

- **Filter Tabs**: All | Active | Ending Soon | Resolved | Cancelled (using `<MarketFilters />`)
- **Search Bar**: keyword search by question text
- **Sort Dropdown**: Newest | Most Volume | Ending Soon | Most Bettors
- **Market Grid**: responsive grid of `<MarketCard />` components
- Each card shows: market image, question, odds bar, XLM pool, bet count, countdown, "Bet Now"
- Uses `useMarkets()` hook with filter/sort parameters
- Empty state with illustration when no markets match

#### `app/markets/[id]/page.tsx` — Market Detail (`/markets/:id`)

- **Market Header**: Large market image, question text, status badge (Active / Resolved YES / Resolved NO / Cancelled), countdown timer
- **Odds Bar**: Full-width animated bar showing YES% green / NO% red with labels
- **Betting Panel** (`<BettingPanel />`):
  - YES / NO toggle buttons (green / red)
  - If user has existing bet: side is locked to their current side, opposite side button disabled with tooltip "You already bet YES/NO on this market"
  - If user has existing bet: show current position above input: "Your current bet: XX XLM on YES"
  - Amount input field with quick buttons: [1] [5] [10] [50] [100] [MAX]
  - Live payout calculator: "If you win: XX.X XLM (+YY% profit)" (includes existing + new amount)
  - Reward preview: "You'll earn: 30 pts + 10 IPRED (win) or 10 pts + 2 IPRED (lose)"
  - Wallet balance display
  - "Place Bet" / "Increase Position" submit button (label changes if user has existing bet)
  - After bet: `<ShareBetButton />` — "Share your prediction on X / Telegram / WhatsApp"
- **Market Stats Row**: Total Pool | YES Pool | NO Pool | Bettors | Your Bet (amount + side, if any)
- **Claim Section** (shown when market resolved + user has bet):
  - Outcome display: "You predicted YES — You won!" or "You predicted NO — You lost"
  - Reward breakdown: XLM payout (if winner) + points + IPREDICT tokens
  - "Claim Rewards" button → calls `useClaim()` hook
- **Activity Feed**: Recent bets on this market, pulled from Soroban events via `useEvents()`
- Uses `useMarket(id)` hook for market data

#### `app/leaderboard/page.tsx` — Leaderboard (`/leaderboard`)

**Design reference: tipz-rosy.vercel.app/leaderboard pattern**

- **Header**: "Leaderboard" headline + "Rankings update in real-time" subtitle + Live badge
- **Tabs** (pill-style like tipz):
  - "Top Predictors" — by points (default)
  - "Most Active" — by total bets placed
  - "Top Referrers" — by referral count
- **Table** (`<LeaderboardTable />`):
  - Columns: Rank | Player (display name or truncated wallet, linked to Stellar Expert) | Points | Bets | Won | Win Rate
  - Top 3: gold/silver/bronze medal badges (using `FiAward` with color)
  - Rows: `<PlayerRow />` component per entry
  - "Your Rank" card pinned at top when wallet is connected
- Uses `useLeaderboard()` hook
- Shows top 50 players from onchain data

#### `app/profile/page.tsx` — User Profile (`/profile`)

- **Requires wallet connected** — shows connect prompt if not
- **Stats Overview Cards Row**:
  - Total Points + Rank
  - IPREDICT Token Balance
  - Total Bets (won / lost / pending)
  - Referral Earnings (XLM)
- **Bet History Tab** (`<BetHistory />`):
  - Table: Market | Your Bet | Amount | Outcome | Payout | Points | Status
  - Claimable rows highlighted with "Claim" button
- **Referral Section** (`<ReferralStats />`):
  - Registration form: display name input + optional referrer address/name
  - "Register & Earn 5 pts + 1 IPREDICT" CTA button
  - After registration: unique referral link `https://ipredict-stellar.vercel.app/?ref=GABCD...`
  - Copy-to-clipboard button
  - Referral count + total earnings display
  - Note: "Registration is optional. Share your link — if they register you, you earn 0.5% + 3 points on all their bets"
- Uses `useProfile()` + `useReferral()` + `useToken()` hooks

#### `app/admin/page.tsx` — Admin Dashboard (`/admin`)

- **Gated**: Only renders full UI if connected wallet === admin address from config
- **Create Market Form** (`<CreateMarketForm />`):
  - Question text input
  - Market image upload or URL input (stored as image_url string in contract)
  - Duration picker (hours/days)
  - "Create Market" submit
- **Pending Resolutions** (`<ResolveMarketPanel />`):
  - List of markets past deadline but not resolved
  - Each row: question, end time, totals, "Resolve YES" / "Resolve NO" buttons
- **Platform Stats** (`<PlatformStats />`):
  - **Accumulated platform fees** (fetched from `PredictionMarket.get_accumulated_fees()`) with **"Withdraw Fees"** button → calls `withdraw_fees(admin)`
  - Total referral fees credited to referrers (from `ReferralRegistry` earnings)
  - Total markets created (active / resolved / cancelled)
  - Total volume
  - Revenue breakdown: 1.5% from every bet + additional 0.5% from unregistered users (full 2%)

---

### Components Breakdown

#### Layout Components (`components/layout/`)

**`Navbar.tsx`** — `'use client'`
- Sticky top with `position: sticky`, slight shadow on scroll
- **Rounded bottom corners** (Tailwind: `rounded-b-2xl` or custom `border-radius: 0 0 16px 16px`)
- Logo "iPredict" on left (text logo, styled with Space Grotesk font)
- Nav links center: Home | Markets | Leaderboard
- Right side: `<WalletConnect />` button
- Mobile: hamburger icon → `<MobileMenu />` slide-in panel
- Active link highlight (purple underline or background pill)

**`Footer.tsx`**
- 4-column grid: Product links, Resources, Legal, Social
- Copyright line
- Stellar attribution

**`MobileMenu.tsx`** — `'use client'`
- Full-screen overlay menu for mobile
- Same nav links + wallet connect
- Smooth slide-in animation

#### Market Components (`components/market/`)

**`MarketCard.tsx`** — Card for market grid
- Market image thumbnail (`<MarketImage />`)
- Question text (truncated to 2 lines)
- `<OddsBar />` — animated YES/NO percentage bar
- Pool amount in XLM + bet count
- `<CountdownTimer />` — time remaining
- "Bet Now" link to `/markets/[id]`

**`MarketGrid.tsx`** — Responsive grid container
- CSS Grid: 3 columns desktop, 2 tablet, 1 mobile
- Renders array of `<MarketCard />` components

**`MarketFilters.tsx`** — Filter tabs + search + sort
- Pill-style tab buttons: All | Active | Ending Soon | Resolved | Cancelled
- Search input with `FiSearch` icon
- Sort dropdown with `FiChevronDown`

**`BettingPanel.tsx`** — `'use client'` — Main betting interface
- YES / NO toggle buttons with active glow (green / red)
- Amount input with validation (min 1 XLM, max wallet balance)
- Quick amount buttons: [1] [5] [10] [50] [100] [MAX]
- Live payout calculation (recalculates on amount or side change)
- Reward preview showing both win and lose outcomes
- Submit button → calls `useBet()` hook
- Transaction progress: `<TxProgress />` (building → signing → submitting → confirmed)
- On success: show `<ShareBetButton />` for social sharing
- Disabled states: wallet not connected, market not active, opposite side when user has existing bet

**`OddsBar.tsx`** — Visual YES/NO split
- Single horizontal bar, green left (YES), red right (NO)
- Percentages labeled on each side
- Smooth CSS transition on updates (300ms ease)
- If no bets: show 50/50 gray

**`CountdownTimer.tsx`** — `'use client'`
- Shows "2d 14h 32m" format for active markets
- Shows "Ended" for expired markets
- Uses `setInterval` to tick every minute (switches to every second when < 1 hour remaining)
- Red text when < 1 hour remaining

**`MarketImage.tsx`** — Market cover image
- Shows market image from `image_url` or falls back to `/images/markets/default-market.png`
- Rounded corners, object-cover fit
- Lazy loaded with `next/image`

#### Leaderboard Components (`components/leaderboard/`)

**`LeaderboardTable.tsx`** — Full ranking table
- Responsive table with scroll on mobile
- Header: Rank | Player | Points | Bets | Won | Win Rate
- Renders `<PlayerRow />` for each entry
- "Your Rank" pinned card at top

**`LeaderboardTabs.tsx`** — Tab switcher
- Pill-style tabs matching tipz design
- "Top Predictors" | "Most Active" | "Top Referrers"
- Purple active indicator

**`PlayerRow.tsx`** — Single leaderboard row
- Rank number (1,2,3 get medal badge)
- Wallet address truncated OR display name shown (linked to `stellar.expert`)
- Points, bets, won count, win rate %
- Highlight row if current user

#### Profile Components (`components/profile/`)

**`BetHistory.tsx`** — Table of user's bets across all markets
**`PointsCard.tsx`** — Points total + rank display card
**`TokenBalance.tsx`** — IPREDICT balance display
**`ReferralStats.tsx`** — Referral link + count + earnings

#### Social Components (`components/social/`)

**`ShareBetButton.tsx`** — `'use client'`
- Button that opens `<SocialShareModal />`
- Shows after placing a bet or on market detail page
- Text: "Share your prediction"

**`SocialShareModal.tsx`** — `'use client'`
- Rendered via `createPortal(…, document.body)` (same pattern as green-belt WalletModal)
- Share options with real icons:
  - X (Twitter): `FiTwitter` → opens `https://twitter.com/intent/tweet?text=...&url=...`
  - Telegram: custom Telegram icon → opens `https://t.me/share/url?url=...&text=...`
  - WhatsApp: custom WhatsApp icon → opens `https://wa.me/?text=...`
  - Copy Link: `FiCopy` → copies market URL to clipboard
- Pre-filled text: "I just bet {amount} XLM that {question} on iPredict! Think I'm wrong? 👉 {url}"
- Auto-includes referral param in URL: `?ref={walletAddress}`

#### Wallet Components (`components/wallet/`)

**`WalletConnect.tsx`** — Connect/disconnect button
- Shows "Connect Wallet" when disconnected
- Shows truncated address + disconnect option when connected
- Opens `<WalletModal />` on click

**`WalletModal.tsx`** — `'use client'`
- Rendered via `createPortal(…, document.body)` to avoid stacking context issues (green-belt fix)
- Lists available wallets: Freighter, xBull, Albedo with their real logos
- Click to connect → via wallet kit
- Backdrop click or X button to close

#### UI Components (`components/ui/`)

**`Spinner.tsx`** — CSS spinner animation
**`Skeleton.tsx`** — Loading placeholder with shimmer
**`TxProgress.tsx`** — Multi-step transaction tracker (Building → Signing → Submitting → Confirmed/Failed)
**`Toast.tsx`** — Success/error toast notification with auto-dismiss
**`Badge.tsx`** — Status badges (Active, Resolved, Cancelled, Won, Lost)
**`EmptyState.tsx`** — Empty state illustration + message

---

### Hooks — Data & Action Patterns

All hooks in `hooks/` follow the patterns from the green-belt project. All are `'use client'` compatible.

#### Data Fetching Hooks (return `{ data, loading, error, refetch }`)

| Hook | Purpose | Service |
|------|---------|---------|
| `useMarkets(filter?, sort?)` | Fetch all markets with optional filter/sort | `services/market.ts` |
| `useMarket(id)` | Fetch single market + user's bet on it | `services/market.ts` |
| `useLeaderboard(tab)` | Fetch top 50 + user rank | `services/leaderboard.ts` |
| `useToken(publicKey)` | Fetch IPREDICT balance + token info | `services/token.ts` |
| `useProfile(publicKey)` | Aggregate: bets, points, rank, earnings | Multiple services |
| `useReferral(publicKey)` | Referral link, count, earnings | `services/referral.ts` |

#### Action Hooks (return `{ submit, result, loading, error, reset }`)

| Hook | Purpose | Service |
|------|---------|---------|
| `useBet()` | Place a bet (build tx, sign, submit) | `services/market.ts` |
| `useClaim()` | Claim rewards on resolved market | `services/market.ts` |

#### Context Hook

| Hook | Purpose |
|------|---------|
| `useWallet()` | Wallet context: connect, disconnect, publicKey, walletType |

---

### Services — Contract Interaction Layer

Each service file handles all Soroban RPC interactions for one contract, following the green-belt `services/contract.ts` pattern:

- Private `buildAndSendTx()` helper shared across services (in `soroban.ts`)
- Read-only calls: simulate transaction → parse `scValToNative` → cache result
- Write calls: build contract call → `buildAndSendTx()` → invalidate cache → return tx hash
- Error classification into `AppError` with types: `NETWORK`, `WALLET`, `CONTRACT`, `VALIDATION`, `SIMULATION`, `TIMEOUT`

| File | Contract | Key Functions |
|------|----------|---------------|
| `soroban.ts` | — | `getSorobanServer()`, `getHorizonServer()`, `buildAndSendTx()` |
| `market.ts` | PredictionMarket | `createMarket()`, `placeBet()`, `resolveMarket()`, `cancelMarket()`, `claim()`, `getMarket()`, `getMarkets()`, `getBet()`, `getOdds()`, `getMarketBettors()` |
| `token.ts` | IPredictToken | `getBalance()`, `getTokenInfo()`, `getTotalSupply()` |
| `referral.ts` | ReferralRegistry | `registerReferral()`, `getReferrer()`, `getReferralCount()`, `getEarnings()`, `hasReferrer()` |
| `leaderboard.ts` | Leaderboard | `getTopPlayers()`, `getStats()`, `getPoints()`, `getRank()` |
| `events.ts` | — | `pollMarketEvents(startLedger?)` — parses bet_placed, market_resolved, reward_claimed events |
| `cache.ts` | — | Same TTL localStorage cache from green-belt: `get<T>()`, `set<T>()`, `invalidate()`, `invalidateAll()` with `ip_` prefix |

---

### Config — `config/network.ts`

```
Exports:
- NETWORK — { name, url, passphrase, sorobanUrl, friendbotUrl }
- MARKET_CONTRACT_ID — deployed PredictionMarket address
- TOKEN_CONTRACT_ID — deployed IPredictToken address
- REFERRAL_CONTRACT_ID — deployed ReferralRegistry address
- LEADERBOARD_CONTRACT_ID — deployed Leaderboard address
- XLM_SAC_ID — Native XLM Stellar Asset Contract address
- ADMIN_PUBLIC_KEY — admin wallet public key (GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD)
- TOTAL_FEE_BPS — 200 (total 2% fee deducted at bet time)
- PLATFORM_FEE_BPS — 150 (1.5% kept by platform in AccumulatedFees)
- REFERRAL_FEE_BPS — 50 (0.5% sent to referrer if user has one; otherwise added to platform fees)
- REFERRAL_BET_POINTS — 3 (bonus points referrer earns per referred bet)
- WIN_POINTS — 30
- LOSE_POINTS — 10
- WIN_TOKENS — 10
- LOSE_TOKENS — 2
- REGISTER_BONUS_POINTS — 5
- REGISTER_BONUS_TOKENS — 1
```

### Types — `types/index.ts`

```
Interfaces/Enums:
- Market — { id, question, imageUrl, endTime, totalYes, totalNo, resolved, outcome, cancelled, creator, betCount }
- Bet — { amount, isYes, claimed }
- PlayerStats — { address, displayName, points, totalBets, wonBets, lostBets, winRate }
- TokenInfo — { name, symbol, decimals, totalSupply }
- ReferralInfo — { referrer, displayName, referralCount, earnings, isRegistered }
- MarketFilter — 'all' | 'active' | 'ending_soon' | 'resolved' | 'cancelled'
- MarketSort — 'newest' | 'volume' | 'ending_soon' | 'bettors'
- TransactionResult — { success, hash?, error? }
- AppErrorType — enum (NETWORK, WALLET, CONTRACT, VALIDATION, SIMULATION, TIMEOUT)
- AppError — { type, message, details? }
- WalletType — 'freighter' | 'albedo' | 'xbull'
- MarketEvent — { type, user, marketId, amount?, timestamp, txHash }
```

### Utils

**`utils/helpers.ts`** — Pure utility functions:
- `formatXLM(stroops: bigint): string` — Convert stroops to XLM display (e.g., "123.45 XLM")
- `truncateAddress(addr: string): string` — "GABCD...7X2F"
- `isValidAmount(amount: string, balance: number): boolean`
- `timeUntil(timestamp: number): string` — "2d 14h 32m"
- `formatDate(timestamp: number): string`
- `calculatePayout(userNetBet, winningSideTotal, totalPool): number`
- `calculateOdds(totalYes, totalNo): { yesPercent, noPercent }`
- `bpsToPercent(bps: number): string`
- `explorerUrl(type: 'tx' | 'account' | 'contract', id: string): string`

**`utils/share.ts`** — Social sharing URL builders:
- `buildTwitterShareUrl(text, url): string`
- `buildTelegramShareUrl(text, url): string`
- `buildWhatsAppShareUrl(text, url): string`
- `buildShareText(question, amount, side, marketUrl, referralAddress?): string`

### Wallet — `wallet/`

Same pattern as green-belt:
- `kit.ts` — `StellarWalletsKit` singleton: `getWalletKit()`, `selectWallet()`, `connectKit()`, `signWithKit()`
- `types.ts` — `Wallet { publicKey: string, walletType: string }`

---

## Testing Strategy

### Contract Tests (Rust)

Written in `test.rs` alongside each contract. Run via `cargo test`.

| Contract | Target Tests |
|----------|-------------|
| prediction_market | 20+ tests (initialize, create, bet, increase position, reject opposite-side, resolve, cancel + refund, claim winner, claim loser, edge cases) |
| ipredict_token | 11+ tests (initialize, multi-minter, mint, transfer, burn, auth) |
| referral_registry | 7+ tests (register, credit, self-referral rejection, no-referrer credit) |
| leaderboard | 8+ tests (add points, bonus points, record bet, top players sorted, rank) |
| **Total** | **46+ contract tests** |

### Frontend Tests (Vitest + React Testing Library)

Written in `__tests__/`. Run via `npm test`.

| Test File | What It Covers |
|-----------|---------------|
| `helpers.test.ts` | formatXLM, truncateAddress, timeUntil, calculatePayout, calculateOdds (20+ tests) |
| `cache.test.ts` | TTL cache CRUD operations (7 tests) |
| `market.test.ts` | Market service mock tests (5 tests) |
| `leaderboard.test.ts` | Leaderboard data parsing (3 tests) |
| `Navbar.test.tsx` | Renders nav links, wallet button, sticky behavior |
| `MarketCard.test.tsx` | Renders question, odds bar, countdown, pool amount |
| `BettingPanel.test.tsx` | Amount input, validation, quick buttons, payout calc |
| `LeaderboardTable.test.tsx` | Renders rows, medals, user highlight |
| `WalletConnect.test.tsx` | Connect/disconnect states |
| **Total** | **45+ frontend tests** |

---

## CI/CD — `.github/workflows/ci.yml`

Two jobs (same pattern as green-belt):

**Job 1: `lint-test-build`**
- Triggers on push to `main`/`develop` and PRs to `main`
- Strategy matrix: Node 18 + Node 20
- Steps: checkout → setup-node (cache npm) → `cd frontend && npm ci` → `npm test` → `npm run build`
- Upload build artifact on Node 20 only

**Job 2: `contract-check`**
- Rust toolchain setup with `wasm32-unknown-unknown` target
- Steps: checkout → `cargo check --workspace` → `cargo test --workspace` (compile check + run all contract tests)
- Verifies all contracts compile to WASM and pass tests

Vercel auto-deploys from GitHub integration on push to `main` (no deploy job needed — same as green-belt).

---

## Docs Folder

### `docs/ARCHITECTURE.md`
- System diagram of 4 contracts + frontend
- Inter-contract call flow explanation
- Data flow for bet → resolve → claim cycle
- Storage layout per contract

### `docs/USER-FEEDBACK.md`
- Template for documenting feedback from 5+ testnet users
- Format: User wallet address | Feedback | Date | Action taken
- Required for Level 5 submission
- Space for iteration notes: what changed based on feedback

### `docs/DEPLOYMENT-GUIDE.md`
- Step-by-step contract deployment using existing wallet:
  - Secret: **stored in `$ADMIN_SECRET` env var — NEVER commit to repo** (use `stellar keys add` or export env var)
  - Public: `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD`
- Contract build, deploy, initialize, link commands
- Frontend `.env.local` setup
- Vercel deployment config
- Seed market creation commands

### `docs/ITERATION-LOG.md`
- Changelog documenting each improvement iteration
- Before/after for user-feedback-driven changes
- Commit references for each iteration

---

## README.md — Submission Checklist Structure

The root `README.md` should contain these sections for Level 5 validation:

```
1. Title + badges (CI, Stellar, License)
2. One-line description
3. Live Demo link (Vercel deployment URL)
4. Demo Video link (Loom or YouTube — showing full MVP flow)
5. Screenshots (landing, markets, betting, leaderboard, profile)
6. Features list
7. Architecture (4-contract diagram + inter-contract flow)
8. Reward System (win/lose table + payout formula)
9. Tech Stack table
10. Project Structure (folder tree)
11. Getting Started (prerequisites, setup, test, build commands)
12. Deployed Contracts (table: contract name | address | stellar.expert link)
13. Testing (test count summary table)
14. CI/CD Pipeline explanation
15. User Validation (required):
    - 5+ real testnet user wallet addresses (verifiable on Stellar Explorer)
    - Link to USER-FEEDBACK.md
    - Summary of 1 iteration completed based on feedback
16. Smart Contract function listings per contract
17. Roadmap
18. License (MIT)
19. Author attribution
```

---

## Deployment Order

1. **Build all 4 contracts** → `stellar contract build` (in `contracts/` directory)
2. **Deploy IPREDICT Token** first (no dependencies)
3. **Deploy Leaderboard** (no dependencies)
4. **Deploy ReferralRegistry** (depends on token + leaderboard for welcome bonus minting)
5. **Deploy PredictionMarket** last (depends on all 3)
6. **Initialize PredictionMarket** with all 3 linked contract addresses
7. **Initialize IPredictToken** → `set_minter(prediction_market_address)` + `set_minter(referral_registry_address)` (both need to mint)
8. **Initialize ReferralRegistry** → pass market contract + token contract + leaderboard contract
9. **Initialize Leaderboard** → pass market contract + referral contract as authorized callers
10. **Create seed markets** (10 markets with images)
11. **Deploy frontend** to Vercel with contract IDs in `.env.local`

All deployments use the existing wallet:
- Secret: **stored in `$ADMIN_SECRET` env var — NEVER commit to repo** (use `stellar keys add` or export env var)
- Public: `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD`

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Next.js App Router** | SEO for landing page, file-based routing, server components for static content |
| **Tailwind CSS** | Utility-first, fast iteration, responsive out of the box |
| **4 separate contracts** | Single responsibility, independently testable, mirrors green-belt pattern |
| **Referral is optional** | Users can bet without registering — but registering gives 5 pts + 1 IPREDICT welcome bonus |
| **Display names on leaderboard** | Registered users show their chosen name instead of raw wallet address |
| **Fee split: 1.5% platform + 0.5% referrer** | Platform always keeps at least 1.5%. Referrers earn 0.5% + 3 pts per referred bet. Unregistered users (no referrer) → platform keeps full 2%. Sustainable revenue regardless of referral adoption |
| **Both winners and losers earn** | Keeps engagement high, encourages repeat use even after losses |
| **Portal-rendered modals** | Avoids z-index stacking context issues (green-belt lesson) |
| **`react-icons/fi`** Feather icons | Real SVG icons, not emoji or character icons |
| **Market images** | Visual appeal, stored as URL in contract, served from `/public/images/markets/` |
| **Social sharing post-bet** | Viral loop: bet → share → friend sees → bets → referral earning |
| **Sticky navbar with rounded bottom** | Modern design pattern from tipz reference |
| **Cache with `ip_` prefix** | Avoid clashing with other apps in localStorage |
| **Single 2% fee at bet time** | Fee deducted once on `place_bet`: 1.5% to `AccumulatedFees` + 0.5% to referrer (or full 2% to platform if no referrer). Admin withdraws via `withdraw_fees()`. No fee at claim time |
| **Indexed bettors (not Vec)** | `BettorCount` + `BettorAt(market_id, index)` avoids unbounded Vec growth on popular markets |
| **Cancel market with refund** | Admin can cancel markets for voided events — refunds net bet amounts, protects users |
| **Increase position, one side only** | Users can add to their bet on the same side but cannot bet both sides — prevents hedging, keeps prediction commitment clear |
| **Multi-minter token via map** | `AuthorizedMinter(Address) → bool` supports both PredictionMarket and ReferralRegistry as minters |
| **`add_bonus_pts` separate from win/loss** | Welcome bonus points don’t inflate win/loss stats — new users start with clean records |
| **Error boundaries per section** | React error boundaries around market grid, betting panel, leaderboard — one failure doesn’t crash the whole app |
| **Secret keys in env vars only** | Admin secret key NEVER committed to repo — stored in `$ADMIN_SECRET` env var |

---

*This document defines the complete structure and flow for iPredict. Implementation follows these patterns exactly.*
