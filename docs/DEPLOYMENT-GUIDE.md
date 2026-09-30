# iPredict — Deployment Guide

## Prerequisites

- [Stellar CLI](https://github.com/stellar/stellar-cli) (v25+)
- [Rust](https://rustup.rs/) 1.85+ with `wasm32v1-none` target
- [Node.js](https://nodejs.org/) 22+ with npm
- A funded Stellar testnet account

---

## Rollback procedure

Use this procedure for an application release that is unhealthy after
deployment. It intentionally rolls back **code, not schema**: migrations run
forward only and the previous release must remain compatible with the current
schema. The compatibility requirement and expand/contract policy are mandatory
for every migration in [the contribution guide](../CONTRIBUTING.md#database-migration-compatibility).

### Before changing anything

1. Declare the rollback and freeze further deployments. Record the release tag,
   current image tags, symptom, and UTC start time in the incident channel.
2. Preserve evidence: capture `docker compose ps`, the last 15 minutes of logs,
   and the current `schema_migrations` rows. Do not put secrets from `.env` in
   the incident record.
3. Confirm that the target release was tested against the current schema. If it
   was not, **do not roll back application code**. Keep the current version
   running or deploy a forward-compatible hotfix instead.
4. Select the previously known-good, immutable image tags and place them in a
   protected rollback env file (for example `infra/.env.rollback`). Never use
   floating tags such as `latest` or rebuild an old Git revision during an
   incident.

### Roll back the application services

From `infra/`, use the production compose file and the protected rollback env
file. Do not invoke `scripts/deploy.sh`, because it runs migrations by default.

```bash
docker compose -f docker-compose.production.yml --env-file .env.rollback pull \
  api indexer proxy oracle-aggregator oracle-monitor

# Stop singleton writers first. This prevents concurrent event processing or
# resolution submission while their replacement starts.
docker compose -f docker-compose.production.yml --env-file .env.rollback stop \
  indexer oracle-aggregator

# Start the previous API, proxy, oracle services, then the single indexer.
docker compose -f docker-compose.production.yml --env-file .env.rollback up -d --no-build \
  api proxy oracle-aggregator oracle-monitor
docker compose -f docker-compose.production.yml --env-file .env.rollback up -d --no-build indexer
```

Service-specific verification follows:

| Service | Rollback action | Verify before proceeding |
|---|---|---|
| `api` | Start the prior `API_IMAGE_TAG`; keep the proxy pointed at it. | `GET /readyz` returns 200 and requests succeed through the proxy. |
| `indexer` | Stop it before the replacement, then start exactly one prior instance. | Its advisory lock is held once and its checkpoint advances without duplicate events. |
| `oracle-aggregator` | Stop before replacement to avoid duplicate finalization attempts; start the prior image with the same mounted resolver key. | `/health/ready` is healthy and one poll cycle completes without signing errors. |
| `oracle-monitor` | Start the prior image after the aggregator. | It can read Postgres and deliver a test alert only to the staging endpoint. |
| `proxy` | Start the prior proxy image/config after the API. | HTTPS and `/healthz` work through the public hostname. |
| `log-collector` | It may remain running; roll back only its prior image/config if logging itself caused the incident. | New JSON logs arrive at the configured sink. |
| `postgres` / `redis` | Do not roll back their images, volumes, or data as part of an application rollback. | Their existing health checks remain healthy. Restore from a verified backup only under the disaster-recovery procedure. |

After every service is healthy, run the **post-deployment smoke suite** (below)
— it covers market reads, authenticated oracle submission, and the auth
rejection path. Keep the deployment freeze until metrics and error rates have
remained normal for the release's agreed observation window.

### Schema, migrations, and contracts

- `db/migrate.ts` applies only files not yet recorded in `schema_migrations`.
  It does not execute `*.down.sql`; an up migration must never be edited after
  release. A rollback must not delete migration rows or manually alter the
  schema to imitate an earlier release.
- If an already-applied migration is not backwards compatible, application
  rollback is unsafe. Deploy a forward-only repair migration and a compatible
  hotfix, or restore the full system from a verified backup under an approved
  disaster-recovery incident. Restoring data has explicit RPO/RTO consequences.
- Stellar contract deployments are immutable. Keep the previous contract IDs in
  the rollback environment only when the current data and contracts remain
  compatible. Otherwise deploy a corrective contract/version and point a
  forward-compatible application release at it; do not treat a contract-ID
  change as a database rollback. For in-place contract WASM upgrades and data
  layout compatibility, follow the
  [Contract Upgrade Procedure & Storage Compatibility Rules](#contract-upgrade-procedure--storage-compatibility-rules).

### Staging rollback drill

Exercise this for every release that contains a migration, and at least once per
quarter for the whole stack. Use staging or a disposable environment only.

1. Deploy the known-good release and capture its image tags and schema version.
2. Deploy a candidate release that includes an additive migration and verify it.
3. Create `.env.rollback` with the known-good immutable tags, then execute the
   commands above without running migrations.
4. Verify the service-specific checks, data integrity (including indexer
   checkpoint and a sample market/bet), and that `schema_migrations` did not
   move backwards.
5. Re-deploy the candidate, record the elapsed rollback time, result, operator,
   release tags, schema version, and any follow-up in the release record.

The required release record makes the drill auditable; a failed drill blocks a
schema-changing production release until the compatibility issue is fixed.

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

TLS expiry is the one outage that is entirely predictable, so it is monitored
for every public endpoint and every internal TLS service. Do this **in the same
session as the deploy** — the monitor is useless if it is added later.
## Post-deployment smoke suite

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
Deploying is not the same as working. Before this suite existed the only
verification after a release was manually poking a few endpoints, which is
exactly the process that misses a release whose API answers 200 with amounts
serialised as numbers. **The suite below is a required gate: a deployment is
not complete until it exits 0.**

### Running it

```bash
# Read-only. Safe against production — this is the default and the gate.
make smoke BASE_URL=https://api.example.com

# Equivalent, without make:
npm run smoke -- --base-url https://api.example.com

# See what it will do before running it:
make smoke-list
```

Expected output on a healthy deployment:

```
iPredict smoke suite — https://api.example.com

  PASS GET /healthz
  PASS GET /readyz
  PASS GET /resolution-status
  PASS GET /api/markets
  PASS GET /api/markets/:id and /odds
  PASS GET /api/markets/999999999
  PASS POST /api/v1/oracle/submit (no credential)
  PASS POST /api/v1/oracle/submit (wrong credential)
  SKIP POST /api/v1/oracle/submit (valid key, invalid signature) — no --oracle-api-key supplied; …

8 passed, 0 failed, 0 warning, 1 skipped in 178ms
```

Exit code is `0` when nothing failed, `1` on any failure, `2` on bad usage,
`3` if the suite itself crashes. Wire it as the last step of the deploy
script, before the freeze is lifted.

### What it covers, and what it deliberately does not

| Check | Endpoint | Detects |
|---|---|---|
| `health.liveness` | `GET /healthz` | Process not serving, wrong port, proxy not routing |
| `health.readiness` | `GET /readyz` | Missing `DATABASE_URL`, unmigrated database, severed connection, Redis down — **names the failing dependency** |
| `health.resolution` | `GET /resolution-status` | Oracle aggregator down or falling behind (warning, not failure) |
| `markets.list` | `GET /api/markets` | Pagination/schema regressions, **and amounts no longer serialised as exact seven-decimal strings** |
| `markets.detail` | `GET /api/markets/:id`, `/odds` | List and detail disagreeing; odds computing against a missing market |
| `markets.notFound` | `GET /api/markets/999999999` | 404 handling replaced by a 500, or a stack trace in the body |
| `oracle.authRejected` | `POST /api/v1/oracle/submit` | **Auth check removed** — the release that lets anyone submit an outcome |
| `oracle.badKeyRejected` | `POST /api/v1/oracle/submit` | Credential set empty, misparsed, or replaced by a wildcard |
| `oracle.badSignatureRejected` | `POST /api/v1/oracle/submit` | Rotated/lost `ORACLE_API_KEYS`; **signature verification not running** |

The last one is skipped unless an oracle key is supplied:

```bash
make smoke BASE_URL=… SMOKE_ARGS="--oracle-api-key $ORACLE_SMOKE_KEY"
```

Supply the key through `SMOKE_ORACLE_API_KEY` in the environment rather than on
the command line, so it does not land in shell history or a CI log.

### Why the submission path is only tested as far as a rejection

`POST /oracle/submit` writes real state: a submission row, and a step toward
finalizing a market. A smoke test that submits successfully against production
is not a test, it is an incident with extra steps.

So the suite goes as far as a request can go without being accepted:

1. **No credential** → must be 401. A release that dropped the auth check
   fails here.
2. **Wrong credential** → must be 401. A release whose `ORACLE_API_KEYS` is
   empty or wildcard fails here.
3. **Correct credential, fabricated signature** → must be 401 or 403. This
   proves the key is live, identity binding works, and the request reached
   signature verification — and it writes nothing. A 200 here means
   signature verification is not running, which is a SEV1.

A genuine write-path check exists but is off unless an operator asks for it
twice over, and even then the suite cannot mint a real provider signature:

```bash
# Requires BOTH flags, and a dedicated market that exists only for this.
make smoke BASE_URL=… SMOKE_ARGS="--oracle-api-key $KEY --allow-writes --write-market-id 4242"
```

`--allow-writes` without `--write-market-id` is refused outright, rather than
defaulting to some arbitrary market id. The check prints `WRITES STATE` in the
report and in `--list` so it cannot be run by accident.

**Staging is where the write path is exercised.** For a staging release, use a
dedicated smoke market and run the write check there, every time.

### Reading a failure

| Output | What it means | Where to look |
|---|---|---|
| `FAIL GET /readyz — not ready; failing: db` | The API cannot reach Postgres | `DATABASE_URL`, migrations, network policy |
| `FAIL GET /api/markets — market.total_yes is number, expected a string` | The pg `NUMERIC` parser is no longer returning strings — **large balances are losing precision for every client** | `configurePgNumericParser` in `backend/src/lib/amount.ts` |
| `FAIL …/:id — appears in the list but returns 404` | List and detail routes disagree | Cache keys, the market detail query |
| `FAIL …/submit — expected 401 …, got 200` | **Auth is not running. Treat as SEV1.** | `backend/src/config/oracleApiKeys.ts`, `ORACLE_API_KEYS` |
| `WARN … (valid key, invalid signature) — configured key was rejected` | The deployment's keys do not match the key supplied | `ORACLE_API_KEYS` on the running container |
| `WARN GET /resolution-status — stalled` | The deployment is fine; the oracle is not | § "Oracle aggregator outage" below |
| `WARN … rate limited; this check verified nothing` | The suite's own repeated requests hit a limit. **The check did not run.** | Re-run after the window resets; use `--strict` to make this block |

A `SKIP` is not a `PASS`. The report says what was not exercised, so a green
run with skips is visibly narrower than a green run without them.

### Gate configuration

`--strict` promotes warnings to failures, for a release where a stalled
resolution should block rather than warn:

```bash
make smoke BASE_URL=… SMOKE_ARGS="--strict --oracle-api-key $KEY"
```

Against production, also run:

```bash
# Indexer progress — not covered by the suite above.
curl -fsS "http://<indexer>:9101/metrics" | grep -E '^indexer_(last_ledger|events_processed)'
# Oracle monitor cycle.
curl -fsS "http://<oracle-monitor>:9103/health/ready"
```

Record the run in the release record: the base URL, the exit code, the pass /
fail / warn / skip counts, and who ran it. A skipped authenticated check in
production is a finding worth writing down, not a detail.

### The suite is itself tested

`test/smoke/smoke.test.ts` stands up a stub server, breaks it in each way a
release breaks, and asserts the suite says so — including a release that
reparses `NUMERIC` as a number and one that accepts an unsigned submission.
`backend/test/smoke.test.ts` runs the same suite against the real Fastify
server, so the checks cannot silently drift from the responses the application
actually produces.

---

## Verification Checklist

**Automated, required first:**

- [ ] Post-deployment smoke suite exits 0 (`make smoke BASE_URL=…`)
- [ ] The smoke run's pass/fail/warn/skip counts are recorded in the release
      record, and any skipped check is called out

Then verify each feature end-to-end:

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

## Contract Upgrade Procedure & Storage Compatibility Rules

Soroban smart contracts in iPredict support in-place bytecode upgrades via `env.deployer().update_current_contract_wasm(new_wasm_hash)`. This allows deploying new business logic, bug fixes, gas optimizations, and configurable parameters **without changing contract IDs (`C...`)**, preserving user token balances, leaderboard records, active predictions, and referral relationships.

However, in-place upgrades introduce **storage compatibility risks**. Because Soroban serializes storage entries into XDR (`ScVal`), an incompatible change to Rust structs or enums stored on ledger will cause host deserialization traps (`Error(Contract, #...)`), rendering existing markets and user bets permanently unreadable.

This section defines the end-to-end upgrade procedure, explicit storage compatibility rules, proven state migration patterns (including the lazy migration pattern proven in `referral_registry`), and post-upgrade verification runbooks.

---

### 1. Upgrade Architecture & On-Chain Mechanics

All four core iPredict contracts (`prediction_market`, `referral_registry`, `leaderboard`, `ipredict_token`) implement the standard in-place upgrade entry point:

```rust
pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), MarketError> {
    Self::require_admin(&env, &admin)?;
    admin.require_auth();
    env.deployer().update_current_contract_wasm(new_wasm_hash);
    Ok(())
}
```

#### Key Architectural Properties:
1. **Contract Address Invariance:** The contract address (`Address`) remains unchanged. Clients, frontend dApps, indexers, and sibling contracts do not need address updates.
2. **Storage Persistence:** All storage types (`instance()`, `persistent()`, `temporary()`) are retained across the upgrade. The new WASM executes against the exact ledger entries written by previous WASM versions.
3. **Admin Authentication:** The calling account must match the stored `Admin` address and must sign the transaction (`admin.require_auth()`).
4. **WASM Pre-Installation:** WASM bytecode is uploaded to the ledger once via `stellar contract install`, which registers the executable and yields a unique 32-byte SHA-256 hash. The `upgrade()` invocation merely updates the contract instance's code pointer to this hash.

---

### 2. End-to-End Upgrade Runbook

Follow these steps sequentially for any contract upgrade on Testnet or Mainnet.

#### Step 2.1: Pre-Upgrade Verification & Local Build
1. Run all unit tests and storage regression tests:
   ```bash
   cd contracts
   cargo test
   ```
2. Build optimized WASM binaries:
   ```bash
   stellar contract build
   ```
3. Verify binary output sizes (must remain under 100 KB):
   ```bash
   ls -la target/wasm32v1-none/release/*.wasm
   ```
4. Record Git commit SHA, binary SHA-256 checksums, and author in the release log.

#### Step 2.2: Install WASM Bytecode On-Chain
Upload the compiled WASM to the network. This does **not** alter the running contract yet.

```bash
# Example for prediction_market
WASM_PATH="target/wasm32v1-none/release/prediction_market.wasm"
NETWORK="testnet" # or mainnet
SOURCE_ADMIN="admin" # Key name in stellar CLI keychain

NEW_WASM_HASH=$(stellar contract install \
  --wasm "$WASM_PATH" \
  --source "$SOURCE_ADMIN" \
  --network "$NETWORK")

echo "Installed WASM Hash: $NEW_WASM_HASH"
```

#### Step 2.3: Multi-Contract Upgrade Dependency Order
When upgrading multiple interacting contracts, execute upgrades in order of dependency tier to prevent authorization or call-graph mismatches:

| Tier | Contract | Dependency / Caller Status |
|:---:|:---|:---|
| **Tier 0** | `ipredict_token` | Independent token contract. Upgraded first if changing token logic. |
| **Tier 1** | `leaderboard` | Interacts with token. Upgraded before market when adding reward facades. |
| **Tier 2** | `referral_registry` | Interacts with leaderboard, token, and market. |
| **Tier 3** | `prediction_market` | Top of dependency graph. Calls leaderboard and token. Upgraded last. |

> [!IMPORTANT]
> **Minter Authorization Transition Rule (Lever G Precedent):**
> If an upgrade transfers token minting privileges from Contract A to Contract B:
> 1. Grant minter role to Contract B (`ipredict_token.set_minter(Contract B, true)`).
> 2. Upgrade Contract B with logic that executes minting.
> 3. Upgrade Contract A to stop minting directly.
> 4. Revoke minter role from Contract A (`ipredict_token.set_minter(Contract A, false)`).
> Never revoke before the replacement path is verified on-chain.

#### Step 2.4: Execute In-Place Upgrade
Invoke the `upgrade()` function on the deployed contract:

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOURCE_ADMIN" \
  --network "$NETWORK" \
  -- upgrade \
  --admin "$ADMIN_PUBLIC_KEY" \
  --new_wasm_hash "$NEW_WASM_HASH"
```

Verify transaction confirmation on Stellar Expert / RPC response.

---

### 3. Storage Compatibility Rules

Soroban encodes contract data types into XDR values (`ScVal`). The host deserializes stored bytes into Rust types when `.get(&key)` is called. If the Rust struct or enum does not match the byte representation on ledger, the host generates a deserialization error, causing function execution to trap.

#### 3.1 `DataKey` Enum Compatibility Rules
`DataKey` determines the storage keys under which records are stored.

- ✅ **Backwards-Compatible Changes (SAFE):**
  - **Adding new enum variants:** Appending new variants (e.g., `SubmitterBond`, `DisputerBond`, `ChallengeWindow`, `Profile(Address)`) is 100% backwards-compatible. Existing keys stored in previous ledgers are unaffected.
  - **Adding variant payloads for new features:** Adding a new variant with parameters (e.g., `CouncilVote(u64, Address)`) as long as it does not replace an existing variant.
- ❌ **Breaking Incompatible Changes (PROHIBITED):**
  - **Renaming an existing variant:** Changing `DataKey::Market(u64)` to `DataKey::PredictionMarket(u64)` changes the symbol discriminant in XDR; all existing markets become unreachable.
  - **Deleting an existing variant:** Deleting `DataKey::Registered(Address)` prevents the contract from reading legacy registrations.
  - **Altering payload types:** Changing `DataKey::Market(u64)` to `DataKey::Market(u128)` or `DataKey::Bet(u64, Address)` to `DataKey::Bet(Address, u64)` breaks key lookup.
  - **Reordering variants in numeric-repr enums:** Modifying numeric discriminants shifts binary serialization.

#### 3.2 Struct Compatibility Rules (`Market`, `BetEntry`, `OracleSubmission`, `Config`)
Structs represent the values stored inside persistent and instance storage slots.

- ✅ **Backwards-Compatible Changes (SAFE):**
  - **Adding new standalone keys for new fields:** Instead of adding a field to `Market`, store the new data under a separate key: `DataKey::MarketMetadata(u64)`.
  - **Creating a new packed struct under a new key:** Store new records in `UserProfile` under `DataKey::Profile(Address)` while maintaining legacy keys (`Registered`, `DisplayName`, `Referrer`) for fallback reads.
- ❌ **Breaking Incompatible Changes (PROHIBITED):**
  - **Adding a field to an existing stored struct:** Adding `pub category_id: u32` to `struct Market` causes deserialization of existing ledger entries to fail because the stored map/tuple lacks the new field.
  - **Removing a field from an existing stored struct:** Removing `pub image_url: String` from `Market` causes host parsing to fail on existing entries.
  - **Changing field types:** Changing `pub end_time: u64` to `pub end_time: u128` or `pub outcome: bool` to `pub outcome: Option<bool>` breaks XDR decoding.
  - **Renaming a field in a struct:** Field names are serialized as symbols in Soroban struct maps. Renaming `total_yes` to `yes_pool` breaks deserialization.

#### 3.3 Storage Tier Consistency Rules
Soroban provides three distinct storage lifetime tiers: `instance()`, `persistent()`, and `temporary()`.

- ❌ **Never move keys between storage tiers across upgrades:**
  - If a key was stored in `instance()` (e.g., `DataKey::Admin`, `DataKey::Cfg`), it cannot be read from `persistent()`.
  - If market records are stored in `persistent()` (`DataKey::Market(u64)`), querying them via `env.storage().instance()` returns `None`.
- ⚠️ **TTL and Rent Preservation:**
  - Upgrading contract WASM does **not** extend or reset the TTL of existing persistent entries.
  - Critical keys must continue to invoke `env.storage().persistent().extend_ttl(...)` using `TTL_BUMP` (36.5 days) and `TTL_HIGH` (73 days) as specified in Issue #533 to prevent storage archival.

---

### 4. Storage Compatibility Classification Matrix

| Modification | Storage Target | Status | Operational Impact & Mitigation |
|---|---|:---:|---|
| **Add new variant to `DataKey`** | Keys | ✅ **Compatible** | Zero risk to existing entries. |
| **Move hardcoded constant to storage** | Instance Storage | ✅ **Compatible** | Safe when using `env.storage().instance().get(...).unwrap_or(CONSTANT)`. |
| **Add new struct under new `DataKey`** | Values | ✅ **Compatible** | Safe when legacy keys are kept for fallback reads (Lazy Migration). |
| **Rename / remove `DataKey` variant** | Keys | 🚨 **BREAKING** | Existing keys on ledger become permanently inaccessible. **Never do this.** |
| **Add / remove / rename struct field** | Stored Values | 🚨 **BREAKING** | Deserialization of existing records fails with host contract error. |
| **Change field primitive type** (`i128` ↔ `u64`) | Stored Values | 🚨 **BREAKING** | XDR decoding mismatch panics host VM. |
| **Change storage tier** (`instance` ↔ `persistent`) | Storage Subsystem | 🚨 **BREAKING** | Entries in old tier are invisible to the new tier. |
| **Remove legacy read fallback logic** | Logic | 🚨 **BREAKING** | Pre-upgrade records can no longer be parsed or claimed. |

---

### 5. State Migration Strategies & Design Patterns

When upgrading smart contracts, use one of the following four approved design patterns to introduce new data layouts safely.

#### Pattern A: Dual-Read with Hardcoded Default Fallback (Moving Constants to Storage)

This pattern directly solves the requirement to make hardcoded constants (`SUBMITTER_BOND = 100 XLM`, `DISPUTER_BOND = 200 XLM`, `CHALLENGE_WINDOW = 86400`, `COUNCIL_WINDOW = 259200`) configurable via governance without breaking existing markets or requiring database backfills.

##### Implementation:
1. Define the new key in `DataKey`:
   ```rust
   pub enum DataKey {
       // ... existing variants ...
       SubmitterBond,
       DisputerBond,
       ChallengeWindow,
       CouncilWindow,
   }
   ```
2. Read the parameter using `.unwrap_or(DEFAULT_CONSTANT)`:
   ```rust
   pub fn get_submitter_bond(env: &Env) -> i128 {
       env.storage().instance()
           .get(&DataKey::SubmitterBond)
           .unwrap_or(SUBMITTER_BOND) // Falls back safely to 100 XLM
   }
   ```
3. Expose admin setters with sanity boundary checks:
   ```rust
   pub fn set_submitter_bond(env: Env, admin: Address, new_bond: i128) -> Result<(), MarketError> {
       Self::require_admin(&env, &admin)?;
       admin.require_auth();
       if new_bond < MIN_BET {
           return Err(MarketError::InvalidAmount);
       }
       env.storage().instance().set(&DataKey::SubmitterBond, &new_bond);
       Ok(())
   }
   ```
##### Why this is safe:
- Unconfigured deployments and existing running markets continue using the proven constant value without any migration step.
- When the admin sets a new bond, subsequent submissions use the updated value without invalidating past submissions.

---

#### Pattern B: Lazy Migration (The Proven "Lever A" Pattern)

This pattern was successfully developed and verified in `contracts/referral_registry/src/lib.rs` and tested in `contracts/referral_registry/src/tests.rs` (`test_legacy_user_still_readable`).

##### Problem:
Legacy registration wrote three separate persistent keys per user:
- `DataKey::Registered(Address)`
- `DataKey::DisplayName(Address)`
- `DataKey::Referrer(Address)`

To save gas (Lever A), the contract packed these into a single `UserProfile` struct under `DataKey::Profile(Address)`.

##### Solution (Lazy Fallback Architecture):
1. **Retain Legacy Keys in `DataKey`:**
   ```rust
   pub enum DataKey {
       Admin,
       MarketContract,
       // Legacy per-user keys (retained for fallback reads)
       Referrer(Address),
       DisplayName(Address),
       Registered(Address),
       // Modern packed entry
       Profile(Address),
   }
   ```
2. **Implement Fallback Read Resolver (`load_profile`):**
   ```rust
   fn load_profile(env: &Env, user: &Address) -> Option<UserProfile> {
       // 1. Attempt to load from modern packed layout
       if let Some(p) = env.storage().persistent()
           .get::<DataKey, UserProfile>(&DataKey::Profile(user.clone())) {
           return Some(p);
       }

       // 2. Fallback: Reconstruct profile from legacy storage keys
       if env.storage().persistent().get::<DataKey, bool>(&DataKey::Registered(user.clone())).unwrap_or(false) {
           let display_name = env.storage().persistent()
               .get(&DataKey::DisplayName(user.clone()))
               .unwrap_or_else(|| String::from_str(env, ""));
           let referrer = env.storage().persistent().get(&DataKey::Referrer(user.clone()));
           return Some(UserProfile { display_name, referrer });
       }

       None
   }
   ```
3. **Write Modern Layout on Update/New Interaction:**
   New registrations write `DataKey::Profile(user)` directly. When a legacy user updates their profile, write the modern `Profile(user)` key and optionally purge legacy keys.
4. **Prevent Double Registration:**
   `is_registered()` calls `load_profile()`, ensuring that legacy users cannot re-register under the new layout.

---

#### Pattern C: Bounded Batch Migration via Admin Function

When state must be eagerly transformed (e.g. data reorganization required for a global index):

1. **Transaction Footprint Limits:** Soroban restricts each transaction to a maximum footprint (40 ledger entries in Protocol 20/21). Never attempt an unbounded loop across all historical markets or users in a single transaction.
2. **Cursor-Based Pagination:**
   ```rust
   pub fn migrate_market_batch(
       env: Env,
       admin: Address,
       start_market_id: u64,
       batch_size: u32,
   ) -> Result<u64, MarketError> {
       Self::require_admin(&env, &admin)?;
       admin.require_auth();
       
       let limit = batch_size.min(25); // Cap to safe footprint
       let mut processed = 0;
       let mut next_id = start_market_id;

       while processed < limit && next_id <= get_total_markets(&env) {
           // Read legacy entry, write modern format
           next_id += 1;
           processed += 1;
       }
       Ok(next_id)
   }
   ```
3. **Idempotence:** Every migration step must be safely re-runnable without corrupting data or duplicating balances.

---

#### Pattern D: Expand/Contract Versioned Enum Envelopes

For complex structs that may evolve repeatedly over time, wrap stored values in a versioned enum:

```rust
#[contracttype]
pub enum StoredMarket {
    V1(MarketV1),
    V2(MarketV2),
}
```

- When reading, match on the variant: `match stored { StoredMarket::V1(m) => convert(m), StoredMarket::V2(m) => m }`.
- When writing, always write the latest version (`StoredMarket::V2`).

---

### 6. Post-Upgrade Verification Checklist

Execute these checks immediately following any upgrade before reopening public traffic:

#### Phase A: Non-Mutating Read Simulation (`--send=no`)
Perform simulations to verify ABI and deserialization without committing state or spending gas:

```bash
# 1. Query general contract state
stellar contract invoke --id $CONTRACT_ID --source admin --network $NETWORK --send=no -- get_market_count

# 2. Query an existing legacy market created before the upgrade
stellar contract invoke --id $CONTRACT_ID --source admin --network $NETWORK --send=no -- get_market --market_id 1

# 3. Query odds and bet totals
stellar contract invoke --id $CONTRACT_ID --source admin --network $NETWORK --send=no -- get_odds --market_id 1

# 4. In referral registry: verify legacy user reads correctly
stellar contract invoke --id $REFERRAL_ID --source admin --network $NETWORK --send=no -- is_registered --user $KNOWN_LEGACY_USER
```

#### Phase B: State Mutation & Write Path Verification
Execute a small on-chain transaction to verify execution and event emissions:
1. Place a minimal bet (`1 XLM`) on an open market.
2. Verify that `BetEntry` is written and `total_yes` or `total_no` updates correctly.
3. Verify that `mkt` / `bet` events are emitted with unchanged topic and payload structures.

#### Phase C: Indexer Synchronization Check
1. Monitor indexer logs:
   ```bash
   docker compose -f infra/docker-compose.production.yml logs -f --tail=100 indexer
   ```
2. Confirm the indexer processes the post-upgrade ledger without JSON parsing or topic deserialization errors.
3. Confirm database table `events` records the new event and indexer checkpoint advances monotonically.

---

### 7. Emergency Rollback Runbook

If an issue is detected post-upgrade (e.g. deserialization failure, logic bug, or indexing incompatibility), execute an emergency rollback.

#### Rollback Execution Command:
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source admin \
  --network "$NETWORK" \
  -- upgrade \
  --admin "$ADMIN_PUBLIC_KEY" \
  --new_wasm_hash "$PREVIOUS_KNOWN_GOOD_WASM_HASH"
```

#### Rollback Safety Conditions:
- ✅ **Safe to Roll Back:**
  - If the upgrade strictly adhered to the **Storage Compatibility Rules** (only added new keys, used `.unwrap_or()` defaults, or used lazy migration fallbacks).
  - The previous WASM can continue reading historical entries because existing keys and struct schemas were preserved.
- 🚨 **Unsafe to Roll Back (Requires Forward Hotfix):**
  - If the new WASM modified existing storage slots in a way that the previous WASM cannot deserialize.
  - In this case, **do not downgrade** to the previous WASM. Instead, build and deploy a forward hotfix WASM that restores compatibility.

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
