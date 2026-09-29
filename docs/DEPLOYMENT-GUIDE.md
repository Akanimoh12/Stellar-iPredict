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

Edit `.env.local` with deployed contract IDs (current **mainnet** values):

```env
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

NEXT_PUBLIC_MARKET_CONTRACT_ID=CDGNPRYTFDXJLWZE4YDKZXW4IEN2RLPSE4N7VM5HJ7NLPL2QC45GIXI5
NEXT_PUBLIC_TOKEN_CONTRACT_ID=CAYL4TKNRMXAX5ZLQGFEZ6XOC2QHTCTN5QC2SB5BEEHLVO6SDU2UBLRH
NEXT_PUBLIC_REFERRAL_CONTRACT_ID=CAGJVX6EXMCKKWDJCQFIEJ34CZTHZOGLWJM6KQTGDEXEO723CJZ5773H
NEXT_PUBLIC_LEADERBOARD_CONTRACT_ID=CCWWOQSDSO3XXLCMA6A2HYRUFYVNUJZ2HPAMFQSPOB4JWYIBY2HWVTOB
# Native XLM SAC — MAINNET (differs from testnet's CDLZFC3S...)
NEXT_PUBLIC_XLM_SAC_ID=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA
NEXT_PUBLIC_ADMIN_PUBLIC_KEY=GDZ4VJWNJPLNU3PAWDYX3V5XNATO7X257DPHWRPFXSCCNEUZ7QTXIIUI
```

> **Note:** The native XLM Stellar Asset Contract ID is DIFFERENT on testnet vs
> mainnet (it derives from the network passphrase). Using the wrong one makes
> every bet/claim trap with `Storage, MissingValue`. The frontend now selects
> the correct one automatically based on `NEXT_PUBLIC_NETWORK`.

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

## Step 7: Enable Certificate Expiry Monitoring

TLS expiry is the one outage that is entirely predictable, so it is monitored
for every public endpoint and every internal TLS service. Do this **in the same
session as the deploy** — the monitor is useless if it is added later.

```bash
# offline sanity check, then a real (non-delivering) run
python3 infra/cert-monitor/check-certs.py --self-test
python3 infra/cert-monitor/check-certs.py --dry-run

# choose an alert channel
cp infra/cert-monitor/cert-monitor.env.example /etc/ipredict/cert-monitor.env
$EDITOR /etc/ipredict/cert-monitor.env

# schedule it daily (systemd)
sudo cp infra/cert-monitor/systemd/ipredict-cert-monitor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ipredict-cert-monitor.timer
```

Full setup, alert routing, internal-certificate coverage and troubleshooting:
[`infra/README.md`](../infra/README.md).

**Inventory discipline:** every endpoint you deploy gets a line in
`infra/cert-monitor/endpoints.txt` in the PR that deploys it (a `pending` slot
before it exists, `active` the moment it does). A service missing from the
inventory is a service nobody is watching.

---

## Step 8: Enable Synthetic Read-Path Monitoring

Passive monitoring only records the traffic that happened. In the small hours
there may be almost none — which is exactly when a broken read path goes
unnoticed for hours. The synthetic monitor instead **exercises** the critical
read paths every two minutes, from outside the deployment, so DNS, TLS, the
load balancer, the edge and the application itself are verified continuously,
with or without users. It also alerts when a path gets *slow*, not only when
it fails.

```bash
# offline sanity check, then a real (non-delivering) run
python3 infra/synthetic-monitor/check-synthetic.py --self-test
python3 infra/synthetic-monitor/check-synthetic.py --dry-run

# choose an alert channel
cp infra/synthetic-monitor/synthetic-monitor.env.example /etc/ipredict/synthetic-monitor.env
$EDITOR /etc/ipredict/synthetic-monitor.env

# schedule it every 2 minutes (systemd)
sudo cp infra/synthetic-monitor/systemd/ipredict-synthetic-monitor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ipredict-synthetic-monitor.timer
systemctl list-timers ipredict-synthetic-monitor.timer
```

The checks are read-only by construction — `GET`, or a `POST` carrying a
read-only JSON-RPC method (anything else is refused while the inventory is
parsed) — so they are safe to run continuously against production.

Two schedules, two network paths to production:

* **systemd timer (primary)** — every 2 minutes from the monitor host. First
  sign of trouble alerts within ~2 minutes, a confirmed failure within ~4.
* **`.github/workflows/synthetic-monitor.yml`** — every 5 minutes from a
  GitHub-hosted runner, i.e. from outside the deployment entirely. Add the
  `SYNTHETIC_MONITOR_WEBHOOK_URL` repository secret to arm its alerts; a
  failed scheduled run also notifies everyone watching the repository.

Full setup, alert escalation, the latency baseline and troubleshooting:
[`infra/README.md`](../infra/README.md).

**Inventory discipline:** every read path you deploy gets a line in
`infra/synthetic-monitor/paths.txt` in the PR that deploys it (a `pending`
slot before it exists, `active` the moment it does — e.g. the API's `/readyz`
is already listed, waiting for `api.ipredict.xyz`). A critical path missing
from the inventory is a critical path nobody is watching.

---

## Certificate Renewal Procedure

> A certificate that expires takes the platform offline instantly — browsers
> and API clients refuse the connection outright, no graceful degradation.
> Renewal is therefore a scheduled, monitored operation, never an emergency
> invented at 03:00.

### What renews what

| Endpoint / certificate | Scope | Issued by | Renewal | Who owns it |
|---|---|---|---|---|
| `ipredict-stellar.vercel.app` | public | Vercel (managed) | automatic — do not touch | platform |
| `ipredict.xyz` / `www.ipredict.xyz` | public | Vercel (managed, attached domain) | automatic | platform |
| `api.ipredict.xyz` | public | Let's Encrypt | `certbot` timer | platform |
| Any future custom domain | public | Vercel / Let's Encrypt | automatic | platform |
| `oracle-api.internal:8443`, mesh/mTLS, admin ports | internal | internal CA (`step-ca`/Vault PKI/self-signed) | manual or internal ACME | service owner |
| Files under `/etc/ipredict/certs/*.crt` (CA chain, client certs) | internal | internal CA | manual | platform |
| Internal **CA root/intermediate** itself | internal | internal CA | manual — 1–2 year cycle | platform |

Every row above is a row in `infra/cert-monitor/endpoints.txt`. Third-party
endpoints (Stellar Horizon, Soroban RPC, QuickNode) are the provider's
certificates: we do not renew them, we monitor that our calls still succeed.

### The alert schedule — what to do at each step

| Alert | When | Required action |
|---|---|---|
| **MEDIUM** (≤ 30 days) | early warning | Confirm renewal automation is armed: `systemctl list-timers certbot-*`, check the domain is still attached in Vercel, check the ACME DNS token has not expired. No manual renewal needed. |
| **HIGH** (≤ 14 days) | automation should already have fired | Prove it did: `sudo certbot certificates` (look at the new `Expiry` date) or `openssl s_client … \| openssl x509 -noout -dates`. If it did not, start the manual procedure below today, not next week. |
| **CRITICAL** (≤ 7 days) | holiday/no-fail window | Renew **now**, by hand if needed, reload the service, then `check-certs.py --force` to confirm. Page the platform on-call. Repeat CRITICALs are re-sent every 24 h until cleared. |
| **CRITICAL — EXPIRED** | outage | Follow *When it has already expired* below. |
| **CRITICAL — check failed** | endpoint unreachable / file missing | Investigate immediately: an unreachable endpoint hides its real expiry date. |
| **CRITICAL — watchdog gap** | monitor did not run > 48 h | Fix the schedule first (timer/cron/CI), then `--force` to re-verify everything. |

### Manual renewal — public endpoint on Vercel (custom domain)

Vercel issues and renews these automatically; manual work is only ever about
unblocking that automation.

```bash
# 1. what is actually being served right now?
openssl s_client -connect ipredict.xyz:443 -servername ipredict.xyz 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# 2. domain still attached and DNS still pointing at Vercel?
vercel domains ls          # or: Vercel dashboard → Project → Domains
dig +short ipredict.xyz A  # must be Vercel's addresses

# 3. force a re-issue from the Vercel dashboard (Project → Domains → the
#    domain → regenerate/refresh its certificate), or remove + re-add the
#    domain if DNS changed.
```

Common silent failures: registrar domain expiry, a DNS record repointed during
a migration, or a domain removed from the project while the inventory still
expects it.

### Manual renewal — public endpoint on Let's Encrypt (certbot)

```bash
# current state
sudo certbot certificates

# dry-run first: proves the ACME challenge works without burning rate limits
sudo certbot renew --dry-run

# real renewal
sudo certbot renew --cert-name api.ipredict.xyz --force-renewal

# reload the web server so the new certificate is actually served
sudo systemctl reload nginx        # or: sudo nginx -s reload / systemctl reload caddy

# confirm what clients now receive
openssl s_client -connect api.ipredict.xyz:443 -servername api.ipredict.xyz 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Automation: `systemctl status certbot.timer` must be `active`; the timer renews
when a certificate reaches 30 days remaining. The monitor still watches the
*served* certificate, because an enabled timer with a revoked DNS API token
fails silently.

### Manual renewal — internal / private-CA certificate

Works for `oracle-api.internal:8443`, mesh/mTLS certs and any file under
`/etc/ipredict/certs/`.

```bash
# 1. new key + CSR (keep the SAN list identical to the old certificate)
openssl req -new -newkey rsa:2048 -nodes \
  -keyout oracle-api.key -out oracle-api.csr \
  -subj "/CN=oracle-api.internal" \
  -addext "subjectAltName=DNS:oracle-api.internal,DNS:ipredict-mesh.internal"

# 2. sign with the internal CA  (omit if your CA is step-ca / Vault PKI —
#    use its issue command instead)
openssl x509 -req -in oracle-api.csr \
  -CA internal-ca.crt -CAkey internal-ca.key -CAcreateserial \
  -out oracle-api.crt -days 90 \
  -extfile <(printf "subjectAltName=DNS:oracle-api.internal,DNS:ipredict-mesh.internal")

# 3. install (keep key/cert permissions and ownership unchanged)
sudo install -m 640 -o root -g ipredict oracle-api.crt /etc/ipredict/certs/oracle-api.crt

# 4. reload the service that terminates TLS
sudo systemctl restart ipredict-oracle     # mesh: rolling restart of the sidecars
```

Certificate **files** are monitored directly, so replacing
`/etc/ipredict/certs/*.crt` is visible to the monitor on the next run even if
the service is not reachable from the monitor host. The internal **CA root**
has an expiry date too — it is in the inventory as a `file:` target, and its
30/14/7 alerts fire exactly like any other certificate. Renewing a CA root
means re-issuing every leaf it signs, so act on its 30-day alert.

### After any renewal — verification checklist

- [ ] New certificate is what a client receives (`openssl s_client … -dates`)
- [ ] Chain and hostname verify: `check-certs.py --only <name>` shows `verify: ok`
- [ ] Service reloaded/restarted so it is serving the new file
- [ ] Monitor reports a `RENEWED` notice and status `ok`
- [ ] Restarted clients / mTLS peers still connect (internal certs)
- [ ] Inventory line still matches reality (target, `tls_source`, `renewal`)

Run it:

```bash
python3 infra/cert-monitor/check-certs.py             # expect: RENEWED notice, then ok
python3 infra/cert-monitor/check-certs.py --force     # optionally re-send the current state
```

### When it has already expired

1. **Renew first, diagnose second.** TLS failures are total, so restore service
   before writing the post-mortem.
2. Run the manual procedure for that certificate type above with
   `--force-renewal` / a fresh issue — do not rely on the automation that just
   missed its window.
3. Reload every process that caches the certificate (web server, mesh sidecars,
   any long-lived gRPC/mTLS connection pool).
4. Re-run `check-certs.py --force` — it must print `RENEWED` and exit 0.
5. Flush any CDN/edge cache in front of the endpoint and check OCSP stapling.
6. Post a status-page update, then write the post-mortem: why the 30-day and
   14-day alerts did not produce a renewal (unowned alert channel, automation
   that failed silently, inventory line missing entirely).

### Why automation is not enough

Renewal automation fails silently far more often than certificates expire
unexpectedly: an ACME DNS token that expired, a certbot timer disabled during
an image bake, a domain detached from Vercel, a rate-limit from a previous
broken renewal, a mesh cert bundle mounted but never rotated. The monitor
therefore watches the certificate **as served** (and as installed on disk),
never the exit code of the renew job — plus the watchdog gap alert covers "the
monitor itself stopped running".

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
- [ ] Certificate expiry monitor scheduled and reporting `ok` for every endpoint
      (`python3 infra/cert-monitor/check-certs.py` — every active line green, no pending surprises)
- [ ] Synthetic read-path monitor scheduled and reporting `ok` for every active path
      (`python3 infra/synthetic-monitor/check-synthetic.py` — all paths green, pending slots listed,
      and the scheduled GitHub workflow has run at least once from outside the deployment)

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
| Synthetic check fails but the site loads for you | The probe runs from outside the deployment — check DNS, TLS and the ingress from another network; that gap is exactly what the monitor is for |
| `json=result.status missing` (HTTP 200) on `rpc-health` | The `/api/rpc` upstream is broken: the proxy forwards the JSON-RPC error body with status 200 — check `PUBLIC_RPC_URL` |
