# Security Policy

iPredict holds user funds in Soroban contracts and runs off-chain services that
resolve markets. Please report vulnerabilities privately so they can be fixed
before they are disclosed.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security
finding.** Use GitHub private vulnerability reporting instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, affected component and commit, reproduction steps, and
   impact. A proof of concept against testnet is welcome; do not test against
   mainnet funds or other users' positions.

Only the maintainers can see the report. If you cannot use GitHub's form,
contact a maintainer listed in the repository through GitHub and ask for a
private channel. Do not put details in the first message.

## Response commitments

| Stage | Target |
|---|---|
| Acknowledge the report | within 72 hours |
| Initial triage and severity assessment | within 7 days |
| Fix or mitigation for critical / high findings | within 30 days |
| Coordinated public disclosure | within 90 days of the report, or sooner once a fix ships |

We keep the reporter updated at each stage. If a fix needs more time, we agree
a new disclosure date with the reporter rather than letting it slip silently.

## Disclosure process

1. The report is triaged in a private GitHub security advisory.
2. A fix is developed in a private fork attached to the advisory and reviewed.
3. Deployed contracts and services are patched or migrated (see
   [`docs/DEPLOYMENT-GUIDE.md`](docs/DEPLOYMENT-GUIDE.md)).
4. The advisory is published with a CVE where applicable, crediting the
   reporter unless they prefer to stay anonymous.

## Scope

In scope:

- **Smart contracts**: `contracts/` (prediction market, token, leaderboard,
  referral registry), especially anything affecting funds, bonds, payouts or
  resolution.
- **Oracle**: `oracle/` (aggregator, submitter, adapters, monitor), e.g.
  forged or replayed submissions or ways to force a wrong resolution.
- **Backend API**: `backend/`, e.g. authentication bypass, injection, data
  exposure, oracle intake abuse.
- **Indexer**: `indexer/`, e.g. event spoofing or state corruption.
- **Frontend**: `frontend/`, e.g. XSS, wallet-signing manipulation.
- **Deployment configuration**: `infra/`, Dockerfiles, compose files and CI
  workflows in this repository.

Out of scope:

- Third-party services and dependencies themselves (Stellar network, Soroban
  RPC providers, wallets, data-source APIs). Report those upstream, but do tell
  us if iPredict uses them unsafely.
- Volumetric denial of service, spam, and social engineering of maintainers.
- Findings that need a compromised maintainer machine or leaked secret.
- Missing best-practice headers or settings with no demonstrable impact.

## Safe harbour

We will not pursue legal action over good-faith research that follows this
policy: testnet only, no access to other users' data or funds, no service
degradation, and private reporting.
