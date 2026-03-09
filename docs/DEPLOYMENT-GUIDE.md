# iPredict — Deployment Guide

## Prerequisites

- [Stellar CLI](https://github.com/stellar/stellar-cli) (v25+)
- [Rust](https://rustup.rs/) 1.85+ with `wasm32v1-none` target
- [Node.js](https://nodejs.org/) 18+ with npm
- A funded Stellar testnet account

### Admin Wallet

- **Public Key:** `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD`
- **Secret Key:** Stored in `$ADMIN_SECRET` environment variable — **NEVER commit to repo**

```bash
# Set up admin key (choose one method):

# Method A: Add to Stellar CLI keychain
stellar keys add admin --secret-key
# Paste your secret key when prompted

# Method B: Export as environment variable
export ADMIN_SECRET="S..."
```

### Fund Account on Testnet

```bash
curl "https://friendbot.stellar.org?addr=GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD"
```

---

## Step 1: Build All Contracts

```bash
cd contracts

# Install wasm target if not already installed
rustup target add wasm32v1-none

# Build all 4 contracts
stellar contract build

# Verify WASM output sizes (should all be < 100KB)
ls -la target/wasm32v1-none/release/*.wasm
```

Expected output:
- `prediction_market.wasm`
- `ipredict_token.wasm`
- `referral_registry.wasm`
- `leaderboard.wasm`

---

## Step 2: Deploy Contracts to Testnet

Deploy in the correct dependency order:

### 2a. Deploy IPredictToken (no dependencies)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/ipredict_token.wasm \
  --source admin \
  --network testnet
# → Returns TOKEN_CONTRACT_ID (e.g., CCY4A5P3BNQEKXH5EBXTEUFMTHVF5Q7K4S3LYT24VYAUXTEUDEXA7ME5)
```

### 2b. Deploy Leaderboard (no dependencies)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/leaderboard.wasm \
  --source admin \
  --network testnet
# → Returns LEADERBOARD_CONTRACT_ID (e.g., CAR4GTU62PBSR27XDAZATW2HSSXK5DPZWBC4MCKUEF4VGFSW6YPPHRCX)
```

### 2c. Deploy ReferralRegistry

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/referral_registry.wasm \
  --source admin \
  --network testnet
# → Returns REFERRAL_CONTRACT_ID (e.g., CAOK6BLEFCNGSFQSPRALKWWL7SS36I7CBVCLBUO2DKQ4PEIOQB4C4QCT)
```

### 2d. Deploy PredictionMarket (depends on all 3)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/prediction_market.wasm \
  --source admin \
  --network testnet
# → Returns MARKET_CONTRACT_ID (e.g., CCUYXGDJLBDOYADEG4IYBTSPPAAUPOUS2RSQWW3CS4LKLXGJ67LQWUOY)
```

---

## Step 3: Initialize Contracts

Initialize in the correct order to set up cross-contract links:

### 3a. Initialize IPredictToken

```bash
stellar contract invoke \
  --id $TOKEN_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --name "iPredict Token" \
  --symbol "IPRED" \
  --decimals 7
```

### 3b. Initialize Leaderboard

```bash
stellar contract invoke \
  --id $LEADERBOARD_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --market_contract $MARKET_CONTRACT_ID \
  --referral_contract $REFERRAL_CONTRACT_ID
```

### 3c. Initialize ReferralRegistry

```bash
stellar contract invoke \
  --id $REFERRAL_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --market_contract $MARKET_CONTRACT_ID \
  --token_contract $TOKEN_CONTRACT_ID \
  --leaderboard_contract $LEADERBOARD_CONTRACT_ID
```

### 3d. Initialize PredictionMarket

```bash
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --token_contract $TOKEN_CONTRACT_ID \
  --referral_contract $REFERRAL_CONTRACT_ID \
  --leaderboard_contract $LEADERBOARD_CONTRACT_ID
```

---

## Step 4: Authorize Minters

Both PredictionMarket and ReferralRegistry need to mint IPREDICT tokens:

```bash
# Authorize PredictionMarket as a minter
stellar contract invoke \
  --id $TOKEN_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- set_minter \
  --minter $MARKET_CONTRACT_ID \
  --authorized true

# Authorize ReferralRegistry as a minter
stellar contract invoke \
  --id $TOKEN_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- set_minter \
  --minter $REFERRAL_CONTRACT_ID \
  --authorized true
```

---

## Step 5: Create Seed Markets

Create 4 crypto prediction markets with CoinGecko images:

```bash
# Market 1: Bitcoin
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Bitcoin (BTC) reach \$100,000 by April 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/1/large/bitcoin.png" \
  --duration 7776000  # 90 days

# Market 2: Ethereum
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Ethereum (ETH) surpass \$5,000 before May 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/279/large/ethereum.png" \
  --duration 7776000  # 90 days

# Market 3: Stellar (XLM)
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Stellar (XLM) break above \$1.00 by June 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/100/large/Stellar_symbol_black_RGB.png" \
  --duration 7776000  # 90 days

# Market 4: Solana
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Solana (SOL) flip Ethereum in daily transactions by Q3 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/4128/large/solana.png" \
  --duration 7776000  # 90 days
```

---

## Step 6: Deploy Frontend

### 6a. Configure Environment

```bash
cd frontend
cp .env.local.example .env.local
```

Edit `.env.local` with deployed contract IDs:

```env
NEXT_PUBLIC_MARKET_CONTRACT_ID=CCUYXGDJLBDOYADEG4IYBTSPPAAUPOUS2RSQWW3CS4LKLXGJ67LQWUOY
NEXT_PUBLIC_TOKEN_CONTRACT_ID=CCY4A5P3BNQEKXH5EBXTEUFMTHVF5Q7K4S3LYT24VYAUXTEUDEXA7ME5
NEXT_PUBLIC_REFERRAL_CONTRACT_ID=CAOK6BLEFCNGSFQSPRALKWWL7SS36I7CBVCLBUO2DKQ4PEIOQB4C4QCT
NEXT_PUBLIC_LEADERBOARD_CONTRACT_ID=CAR4GTU62PBSR27XDAZATW2HSSXK5DPZWBC4MCKUEF4VGFSW6YPPHRCX
NEXT_PUBLIC_XLM_SAC_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
NEXT_PUBLIC_ADMIN_PUBLIC_KEY=GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD
```

### 6b. Local Development

```bash
npm install
npm run dev
# → http://localhost:3000
```

### 6c. Run Tests

```bash
npm test
# Should show 137+ passing tests
```

### 6d. Production Build

```bash
npm run build
# Verify all 8 pages generated
```

### 6e. Deploy to Vercel

1. Connect GitHub repository to [Vercel](https://vercel.com)
2. Set **Root Directory** to `frontend`
3. Add all `NEXT_PUBLIC_*` environment variables in Vercel dashboard
4. Deploy — Vercel auto-deploys on push to `main`

---

## Verification Checklist

After deployment, verify each feature end-to-end:

- [ ] Landing page loads with live stats
- [ ] Markets page shows seed markets
- [ ] Market detail page shows odds and betting panel
- [ ] Wallet connects via Freighter / xBull / Albedo
- [ ] Placing a bet succeeds (check transaction on Stellar Expert)
- [ ] Leaderboard shows rankings
- [ ] Profile page shows bet history after placing bets
- [ ] Admin page accessible only by admin wallet
- [ ] Resolving a market works
- [ ] Claiming rewards works (winner gets XLM + points + tokens)
- [ ] Referral registration works
- [ ] Social sharing generates correct URLs

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Contract not found` | Verify contract ID in `.env.local` matches deployed address |
| `Simulation failed` | Check contract is initialized and caller has auth |
| `Insufficient funds` | Fund account via Friendbot |
| `WASM too large` | Ensure `[profile.release]` has `opt-level = "z"` and `lto = true` |
| `Wallet not connecting` | Ensure Freighter is on Testnet network |
| `Build fails` | Run `rustup target add wasm32v1-none` (Stellar CLI v25+ requires this target) |
