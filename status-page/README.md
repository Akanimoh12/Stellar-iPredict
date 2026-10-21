# iPredict Status Page

A static status page hosted independently of the iPredict backend stack,
driven by real health signals from `GET /status`.

**Live:** https://ipredict-status.pages.dev *(set `CF_PAGES_PROJECT_NAME` to
your actual Cloudflare Pages project; update this link after first deploy)*

---

## Why independent hosting matters

A status page served by the infrastructure it monitors goes down exactly when
it is needed. This page is hosted on Cloudflare Pages (or GitHub Pages) — a
CDN completely separate from the iPredict API, Postgres, and Redis stack. It
stays up during a total backend outage.

---

## How it works

```
Every 5 minutes
  GitHub Actions workflow (.github/workflows/status-page.yml)
    └─ curl GET /status          (live API)
    └─ curl GET /api/markets/resolution-status   (oracle health)
    └─ merge into status-page/snapshot.json
    └─ git commit + push [skip ci]
    └─ deploy status-page/ → Cloudflare Pages
          │
          ▼
    Browser loads index.html from CDN
          │
          ├─ tries live GET /status directly   ← freshest data (30s TTL on API)
          │
          └─ if that fails (backend down)
               falls back to snapshot.json     ← last known state, ≤5 min stale
               shows "snapshot" warning banner
```

### Incident history

`incidents.json` is a static file committed in this directory. The status
page fetches and renders it on every load. Operators add entries directly by
editing the file and pushing — no database, no admin UI, no dependency on the
platform.

### Manual override

Set `override.message` in `incidents.json` to display an operator notice
banner at the top of the page. Useful for incidents automated checks cannot
detect (scheduled maintenance, partial degradation not yet reflected in
metrics). Set `override.endsAt` to make it disappear automatically.

```jsonc
// incidents.json
{
  "override": {
    "message": "Scheduled maintenance tonight 02:00–04:00 UTC. Bets may be delayed.",
    "endsAt": "2026-10-01T04:00:00Z"
  },
  "incidents": [ ... ]
}
```

Push the change — the deploy job picks it up within seconds.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page status UI — pure HTML/CSS/JS, no build step |
| `incidents.json` | Incident history + manual override — edit to post notices |
| `snapshot.json` | Last-known-good status snapshot, written by GitHub Actions |
| `_redirects` | Cloudflare Pages routing (SPA fallback) |

---

## Setup

### 1. Secrets and variables

In the repository **Settings → Secrets and variables → Actions**:

| Name | Type | Value |
|------|------|-------|
| `STATUS_API_URL` | Secret | Full URL of the live `/status` endpoint, e.g. `https://api.ipredict.app/status` |
| `CLOUDFLARE_API_TOKEN` | Secret | CF API token with **Pages:Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Your Cloudflare account ID |
| `CF_PAGES_PROJECT_NAME` | Variable | Cloudflare Pages project name, e.g. `ipredict-status` |

### 2. Create the Cloudflare Pages project

```bash
# One-time: create the project pointing at this repo.
# Cloudflare Pages will deploy from the status-page/ directory.
# You can also create it via the Cloudflare dashboard.
npx wrangler pages project create ipredict-status
```

Or create it in the Cloudflare dashboard under **Workers & Pages → Create →
Pages → Connect to Git**, pointing the build output directory at `status-page`.

### 3. Trigger the first deploy

```bash
git push origin implementation-drips
# The workflow triggers on push to status-page/ or on schedule.
# Check Actions → Status Page for the run.
```

### 4. (Optional) Custom domain

In Cloudflare Pages → your project → Custom domains, add e.g.
`status.ipredict.app`. Add a CNAME in your DNS pointing at
`ipredict-status.pages.dev`.

---

## Switching to GitHub Pages

If you prefer GitHub Pages over Cloudflare Pages:

1. In `.github/workflows/status-page.yml`, remove the `deploy-cloudflare` job
   and uncomment the `deploy-github-pages` job.
2. In **Settings → Pages**, set Source to **GitHub Actions**.
3. No secrets needed for GitHub Pages — the built-in `GITHUB_TOKEN` is used.

---

## Local development

```bash
cd status-page

# Write a real snapshot from the live API
curl -s https://api.ipredict.app/status -o snapshot.json

# Serve the directory
python3 -m http.server 8080
open http://localhost:8080
```

The page polls `./snapshot.json` as its fallback. For the live fetch to work
locally you need CORS headers from the API (or use a browser extension to
disable CORS for local testing).

---

## Adding an incident

Edit `incidents.json` and add an entry at the top of the `incidents` array:

```jsonc
{
  "id": "2026-10-15-indexer-lag",
  "title": "Indexer lagging — market data up to 10 minutes delayed",
  "severity": "partial",
  "startedAt": "2026-10-15T09:00:00Z",
  "resolvedAt": null,
  "body": "The Soroban RPC endpoint used by the indexer is experiencing elevated latency. Market data may be up to 10 minutes behind chain state. Betting is not affected.",
  "updates": [
    {
      "at": "2026-10-15T09:00:00Z",
      "text": "Investigating. Indexer lag rose above 5 minutes at 08:55 UTC."
    }
  ]
}
```

Severity values: `partial`, `major`, `resolved`, `maintenance`.

Commit and push — the page updates within 5 minutes (next scheduled run) or
immediately if you trigger the workflow manually.

---

## Acceptance criteria (issue #584)

| Criterion | How it is met |
|-----------|--------------|
| Status accurately reflects real system health | Page polls `GET /status` which aggregates DB, Redis, indexer, and oracle health |
| Updates automatically from health signals | GitHub Actions fetches `/status` every 5 minutes and commits `snapshot.json`; browser also polls live every 60 s |
| Remains available during an outage of the main platform | Hosted on Cloudflare Pages CDN; falls back to `snapshot.json` when the live API is unreachable |
| Incident history is retained | `incidents.json` is version-controlled; history is permanent |
| Manual override for incidents automated checks cannot detect | `override.message` in `incidents.json` shows a banner; `endsAt` makes it expire automatically |
