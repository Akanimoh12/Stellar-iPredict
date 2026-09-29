# Infrastructure

## Disk-space and database-growth monitoring (`disk-monitor/`)

A full disk takes the database down hard — and recovery is considerably harder
than prevention. This directory monitors disk usage on every stateful service,
tracks per-table growth rates in PostgreSQL, and alerts on **projected
time-to-full** so there is enough lead time to act.

```
infra/
├── README.md                     ← you are here
└── disk-monitor/
    ├── check-disk.py             monitor (Python 3 stdlib only)
    ├── services.txt              inventory of every stateful service
    ├── disk-monitor.env.example  alert-channel / database configuration
    └── systemd/
        ├── ipredict-disk-monitor.service
        └── ipredict-disk-monitor.timer
```

### What is monitored

Every stateful service listed in `disk-monitor/services.txt`:

| Type | What it covers | Example |
|---|---|---|
| `postgres` | PostgreSQL data directory | `/var/lib/postgresql/data` |
| `redis` | Redis data directory | `/var/lib/redis` |
| `mount` | Any filesystem mount point | `/mnt/backups` |

Per-table growth is tracked in PostgreSQL when `DISK_MONITOR_DATABASE_URL` is
configured — the top 20 tables by size are queried on every run and their
growth rate is computed from the previous run's measurement.

> **Rule: no stateful service may exist without a line in `services.txt`.** A
> service with no inventory line is a service nobody is watching.

### Alert escalation

Alerts fire on **projected days-to-full**, not on current percentage used:

| Days to full | Level | Channels | Exit code |
|---|---|---|---|
| > 14 | `ok` | none (logged in the report) | 0 |
| ≤ 14 | **MEDIUM** | chat webhook | 0 (1 with `--fail-on any`) |
| ≤ 7 | **HIGH** | chat webhook + email | 0 (1 with `--fail-on any`) |
| ≤ 3 | **CRITICAL** | chat webhook + email + non-zero exit | **2** |
| full / check failed | **CRITICAL** | chat webhook + email + non-zero exit | **2** |
| monitor gap > 48 h | **CRITICAL** | chat webhook + email + non-zero exit | **2** |

Why time-to-full: a disk at 90% that fills in a day is an emergency; a disk
at 90% that fills in a year is not. Growth rate is measured from the previous
run's data, so the projection is based on observed trend.

Extras that keep the monitor honest:

* **Per-table growth** — the largest tables and their growth rates are
  identified on every run, so the events table (or any other unbounded table)
  is visible before it becomes a crisis.
* **Watchdog gap** — if the previous run is older than `--stale-after-hours`
  (default 48 h), the run reports the gap as CRITICAL.
* **External dead-man's-switch** — point `DISK_MONITOR_HEARTBEAT_URL` at
  healthchecks.io (or similar): if *every* scheduler dies, that service is the
  one left to notice.
* **Scheduled CI** — `.github/workflows/disk-monitor.yml` runs the same check
  daily on a clean runner and publishes a report to the job summary.

### Install

Everything is stdlib Python 3.9+ — no packages, no virtualenv.

```bash
# 1. look at what it would say today
python3 infra/disk-monitor/check-disk.py --self-test     # offline assertions
python3 infra/disk-monitor/check-disk.py --dry-run       # real checks, no delivery

# 2. pick an alert channel (any subset)
cp infra/disk-monitor/disk-monitor.env.example /etc/ipredict/disk-monitor.env
$EDITOR /etc/ipredict/disk-monitor.env

# 3a. systemd (recommended)
sudo cp infra/disk-monitor/systemd/ipredict-disk-monitor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ipredict-disk-monitor.timer
systemctl list-timers ipredict-disk-monitor.timer

# 3b. or cron
echo '23 6 * * * python3 /opt/ipredict/infra/disk-monitor/check-disk.py --fail-on critical' | crontab -

# 3c. or the scheduled GitHub Actions workflow (already in the repo — just
#     add the DISK_MONITOR_WEBHOOK_URL secret)
```

The first run stores its state (default
`$XDG_STATE_HOME/ipredict-disk-monitor/state.json`, override with
`DISK_MONITOR_STATE_FILE`); later runs only alert on escalation.

### Configuration

Read from the environment (see `disk-monitor/disk-monitor.env.example`):

| Variable | Purpose |
|---|---|
| `DISK_MONITOR_WEBHOOK_URL` | Slack/Teams-compatible webhook (`{"text": …}`) |
| `DISK_MONITOR_WEBHOOK_FORMAT` | `slack` (default), `discord`, `generic` |
| `DISK_MONITOR_EMAIL_TO` | email for HIGH/CRITICAL (needs `sendmail`/`mail`) |
| `DISK_MONITOR_DATABASE_URL` | PostgreSQL connection string for per-table growth |
| `DISK_MONITOR_HEARTBEAT_URL` | dead-man's-switch ping after each run |
| `DISK_MONITOR_STATE_FILE` | alert de-duplication state |

CLI flags: `--dry-run`, `--force` (re-send everything currently in alert),
`--only NAME`, `--json`, `--fail-on none|critical|any`,
`--re-alert-hours`, `--stale-after-hours`, `--inventory`, `--state-file`.

### Day-2 operations

| Task | Command |
|---|---|
| See the full report | `python3 infra/disk-monitor/check-disk.py` |
| Machine-readable report | `python3 infra/disk-monitor/check-disk.py --json` |
| Re-verify after expansion | `python3 infra/disk-monitor/check-disk.py --force` |
| Check one service | `python3 infra/disk-monitor/check-disk.py --only postgres-data` |
| Validate the monitor itself | `python3 infra/disk-monitor/check-disk.py --self-test` |
| Journal (systemd) | `journalctl -u ipredict-disk-monitor.service -n 100` |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `inventory error: … expected 5 fields` | a line in `services.txt` is missing a `\|` separator — see the header comment in that file |
| `statvfs(…): No such file or directory` | the target path does not exist on this host — fix the path or mark the service `pending` |
| `psql not found` | install `postgresql-client` or unset `DISK_MONITOR_DATABASE_URL` |
| Alerts repeat every run | state file was deleted or the job runs on ephemeral runners without cache — restore `DISK_MONITOR_STATE_FILE`, or accept re-alerts on a clean runner |
| `WATCHDOG: monitor did not run …` | timer/cron disabled, host was down, or CI schedule paused — fix the schedule, then `--force` |
| No alerts at all but nothing ran | check `systemctl list-timers ipredict-disk-monitor.timer` / crontab, and point `DISK_MONITOR_HEARTBEAT_URL` at a dead-man's-switch |

---

## Certificate expiry monitoring (`cert-monitor/`)

An expired TLS certificate takes iPredict offline instantly — every browser and
every API client refuses the connection — and expiry is 100% predictable. This
directory is the thing that watches the expiry date so nobody has to remember
it.

```
infra/
├── README.md                     ← you are here
└── cert-monitor/
    ├── check-certs.py            monitor (Python 3 stdlib only)
    ├── endpoints.txt             inventory of every certificate-bearing endpoint
    ├── cert-monitor.env.example  alert-channel / internal-CA configuration
    └── systemd/
        ├── ipredict-cert-monitor.service
        └── ipredict-cert-monitor.timer
```

Renewal itself is documented in
[`docs/DEPLOYMENT-GUIDE.md` → Certificate Renewal Procedure](../docs/DEPLOYMENT-GUIDE.md#certificate-renewal-procedure).

### What is monitored

Everything that presents a certificate, in `cert-monitor/endpoints.txt`:

| Section | What it covers | Examples |
|---|---|---|
| `[public]` | Internet-facing TLS: the site, every custom domain, the API host | `ipredict-stellar.vercel.app`, apex/www, `api.` |
| `[internal]` | Internal services that speak TLS (private CA, mTLS, admin/oracle ports) | oracle API on `:8443`, mesh/mTLS, ops dashboards |
| `[internal]` `file:` targets | Certificates that are not reachable over the network but are mounted on disk | `/etc/ipredict/certs/*.crt` (internal CA chain, client certs) |

Two shapes of target, both checked on every run:

* `host:port` — full TLS handshake (SNI honoured), so the certificate **as
  clients actually receive it** is the one measured. Also verifies the chain
  and hostname for `[public]` endpoints.
* `file:/path/*.pem` — reads the PEM/DER file directly (glob allowed). This is
  how internal/MTLS certificates that never answer on a public socket are still
  covered.

A line that is not yet deployed is marked `pending`: it is printed on every run
so it cannot be quietly forgotten, but it never produces a false alert. When
the service ships, the PR that deploys it flips `pending` → `active`.

> **Rule: no endpoint may exist without a line in `endpoints.txt`.** A service
> with no inventory line is a service nobody is watching.

### Alert escalation

Thresholds are crossed once per certificate and each crossing fires exactly one
alert — state is remembered between runs, so a run every 10 minutes does not
become a run every 10 minutes of noise.

| Days to expiry | Level | Channels | Exit code |
|---|---|---|---|
| > 30 | `ok` | none (logged in the report) | 0 |
| ≤ 30 | **MEDIUM** | chat webhook | 0 (1 with `--fail-on any`) |
| ≤ 14 | **HIGH** | chat webhook + email | 0 (1 with `--fail-on any`) |
| ≤ 7 | **CRITICAL** | chat webhook + email + non-zero exit | **2** |
| expired | **CRITICAL** | chat webhook + email + non-zero exit | **2** |
| check failed (DNS/conn/file) | **CRITICAL** | chat webhook + email + non-zero exit | **2** |
| monitor gap > 48 h | **CRITICAL** | chat webhook + email + non-zero exit | **2** |

Why 30/14/7: a single alert at T-7 lands in someone's holiday. 30 days is the
"confirm the automation is armed" nudge, 14 days is "verify it fired or fire it
by hand", 7 days is "do it now, page the on-call". Criticals are re-sent every
24 h until cleared so they survive on-call handovers.

Extras that keep the monitor honest:

* **Renewal notices** — when a certificate's fingerprint changes, a `RENEWED`
  (or `RECOVERED`) notice is printed. Silence between two expiry alerts means
  automation worked; the notice is the proof. A renewal that does *not* move
  the level back to `ok` alerts immediately ("replacement certificate is
  already near expiry").
* **Watchdog gap** — if the previous run is older than `--stale-after-hours`
  (default 48 h), the run reports the gap as CRITICAL. Catches a dead cron
  job / disabled timer while the rest of the system is fine.
* **External dead-man's-switch** — point `CERT_MONITOR_HEARTBEAT_URL` at
  healthchecks.io (or similar): if *every* scheduler dies, that service is the
  one left to notice.
* **Scheduled CI** — `.github/workflows/cert-monitor.yml` runs the same check
  daily on a clean runner and publishes a report to the job summary. A failed
  scheduled run notifies everyone watching the repository, which is an alert
  channel this host does not control.

### Install

Everything is stdlib Python 3.9+ — no packages, no virtualenv.

```bash
# 1. look at what it would say today
python3 infra/cert-monitor/check-certs.py --self-test     # offline assertions
python3 infra/cert-monitor/check-certs.py --dry-run       # real checks, no delivery

# 2. pick an alert channel (any subset)
cp infra/cert-monitor/cert-monitor.env.example /etc/ipredict/cert-monitor.env
$EDITOR /etc/ipredict/cert-monitor.env

# 3a. systemd (recommended)
sudo cp infra/cert-monitor/systemd/ipredict-cert-monitor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ipredict-cert-monitor.timer
systemctl list-timers ipredict-cert-monitor.timer

# 3b. or cron
echo '17 6 * * * python3 /opt/ipredict/infra/cert-monitor/check-certs.py --fail-on critical' | crontab -

# 3c. or the scheduled GitHub Actions workflow (already in the repo — just
#     add the CERT_MONITOR_WEBHOOK_URL secret)
```

The first run stores its state (default
`$XDG_STATE_HOME/ipredict-cert-monitor/state.json`, override with
`CERT_MONITOR_STATE_FILE`); later runs only alert on escalation.

### Configuration

Read from the environment (see `cert-monitor/cert-monitor.env.example`):

| Variable | Purpose |
|---|---|
| `CERT_MONITOR_WEBHOOK_URL` | Slack/Teams-compatible webhook (`{"text": …}`) |
| `CERT_MONITOR_WEBHOOK_FORMAT` | `slack` (default), `discord`, `generic` |
| `CERT_MONITOR_EMAIL_TO` | email for HIGH/CRITICAL (needs `sendmail`/`mail`) |
| `CERT_MONITOR_CA_FILE` | CA bundle used to verify internal/private-CA endpoints |
| `CERT_MONITOR_HEARTBEAT_URL` | dead-man's-switch ping after each run |
| `CERT_MONITOR_STATE_FILE` | alert de-duplication state |

CLI flags: `--dry-run`, `--force` (re-send everything currently in alert),
`--only NAME`, `--json`, `--fail-on none|critical|any`, `--timeout`,
`--re-alert-hours`, `--stale-after-hours`, `--inventory`, `--state-file`.

### Internal certificates

Internal coverage is not a special case — it is the same check pointed at a
different target:

1. **TLS service on an internal host** — `oracle-api | oracle-api.internal:8443`
   is handshaked exactly like a public endpoint, so the certificate clients
   actually receive is the one measured. Expiry is always measured; chain
   verification only runs when `CERT_MONITOR_CA_FILE` points at the internal CA
   bundle (otherwise it is reported as `skipped`), so an internal endpoint is
   never called "broken chain" just because the monitor has no private CA.
2. **Certificate file on disk** — `file:/etc/ipredict/certs/*.crt` covers
   mTLS client certs, mounted server certs and the internal CA chain itself,
   including certificates belonging to services that do not terminate TLS in a
   way this host can reach.
3. **Inventory discipline** — every internal TLS service gets a `pending` slot
   the day it is designed and is flipped to `active` the day it deploys.

Issue internal certificates with **at least twice the alert window** (60–90
days, as in the renewal procedure) — a 30-day certificate is inside the
warning window the moment it is installed and would alert on deployment.

The offline self-test proves all three paths on every run: DER/PEM expiry
parsing, a real TLS handshake against an internal (self-signed) service — where
expiry must be measured with chain verification reported as `skipped` — and the
same handshake under `[public]` scope, where the self-signed chain must be
reported as `failed`.

To verify internal coverage end to end without waiting for production — flip
the `internal-cert-files` line in `endpoints.txt` from `pending` to `active`,
then:

```bash
sudo mkdir -p /etc/ipredict/certs
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 20 \
  -keyout /etc/ipredict/certs/test.key -out /etc/ipredict/certs/test.crt \
  -subj "/CN=test.internal"
python3 infra/cert-monitor/check-certs.py --dry-run
#   → internal-cert-files  …/test.crt  …  20d  <=30d  and a MEDIUM alert
sudo rm /etc/ipredict/certs/test.{key,crt}
# flip the line back to `pending` if you still have no internal certificates
```

### Day-2 operations

| Task | Command |
|---|---|
| See the full report | `python3 infra/cert-monitor/check-certs.py` |
| Machine-readable report | `python3 infra/cert-monitor/check-certs.py --json` |
| Re-verify after a renewal | `python3 infra/cert-monitor/check-certs.py --force` |
| Check one endpoint | `python3 infra/cert-monitor/check-certs.py --only frontend` |
| Validate the monitor itself | `python3 infra/cert-monitor/check-certs.py --self-test` |
| Journal (systemd) | `journalctl -u ipredict-cert-monitor.service -n 100` |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `inventory error: … expected 6 fields` | a line in `endpoints.txt` is missing a `\|` separator — see the header comment in that file |
| `no certificate files match …` CRITICAL | a `file:` target points at a path that does not exist on this host, or the deployment never wrote the cert |
| `verify: failed: certificate has expired` | renewal did not happen — follow the renewal procedure immediately |
| `verify: failed: self-signed certificate` on an `[public]` endpoint | wrong/missing chain in production; the public endpoint must present a publicly trusted certificate |
| `verify: skipped (internal, no CERT_MONITOR_CA_FILE)` | expected until you set the internal CA bundle; expiry is still monitored |
| Alerts repeat every run | state file was deleted or the job runs on ephemeral runners without cache — restore `CERT_MONITOR_STATE_FILE`, or accept re-alerts on a clean runner |
| `WATCHDOG: monitor did not run …` | timer/cron disabled, host was down, or CI schedule paused — fix the schedule, then `--force` |
| No alerts at all but nothing ran | check `systemctl list-timers ipredict-cert-monitor.timer` / crontab, and point `CERT_MONITOR_HEARTBEAT_URL` at a dead-man's-switch |
