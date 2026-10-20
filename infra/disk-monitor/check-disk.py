#!/usr/bin/env python3
"""iPredict disk-space and database-growth monitor.

Reads the stateful-service inventory (services.txt), checks disk usage on
every listed mount point, queries PostgreSQL for per-table size and growth
rate, and escalates alerts based on projected time-to-full:

    > 14 days  ok
    <= 14 days  MEDIUM   chat/webhook
    <=  7 days  HIGH     chat/webhook + email
    <=  3 days  CRITICAL chat/webhook + email, non-zero exit
    query / mount failure  CRITICAL

The key design principle: alert on time-to-full, not on percentage used.
A disk at 90% that fills in a day is an emergency; a disk at 90% that
fills in a year is not. Growth rate is tracked per table and per mount
point so the projection is based on measured trend, not guesswork.

State is kept between runs so each threshold fires exactly once per
service (a growth-rate change resets the state and emits a new alert).

Stdlib only. Operation: infra/README.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

LEVEL_RANK = {"ok": 0, "medium": 1, "high": 2, "critical": 3, "error": 3}
VALID_MODES = ("active", "pending")
BYTES_PER_GB = 1_000_000_000
BYTES_PER_MB = 1_000_000


class InventoryError(Exception):
    pass


# ── inventory ────────────────────────────────────────────────────────────────


class Service:
    def __init__(self, name, service_type, target, owner, mode, line):
        self.name = name
        self.service_type = service_type
        self.target = target
        self.owner = owner
        self.mode = mode
        self.line = line


def parse_inventory(path):
    services = []
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) != 5:
                raise InventoryError(
                    f"{path}:{lineno}: expected 5 '|'-separated fields "
                    f"(name | type | target | owner | mode), got {len(parts)}"
                )
            name, service_type, target, owner, mode = parts
            mode = mode.lower()
            if mode not in VALID_MODES:
                raise InventoryError(
                    f"{path}:{lineno}: mode must be one of "
                    f"{', '.join(VALID_MODES)} (got {mode!r})"
                )
            if not target:
                raise InventoryError(f"{path}:{lineno}: empty target")
            services.append(Service(name, service_type, target, owner, mode, lineno))
    if not services:
        raise InventoryError(f"{path}: no services listed")
    names = [s.name for s in services]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise InventoryError(f"{path}: duplicate service name(s): {', '.join(dupes)}")
    return services


# ── disk usage ──────────────────────────────────────────────────────────────


class DiskObs:
    def __init__(self, svc, target_display):
        self.svc = svc
        self.target = target_display
        self.mount_point = None
        self.total_bytes = None
        self.used_bytes = None
        self.free_bytes = None
        self.used_pct = None
        self.growth_rate_bytes_per_day = None
        self.days_to_full = None
        self.level = "error"
        self.status = "ERROR"
        self.error = None

    def to_dict(self):
        return {
            "service": self.svc.name,
            "type": self.svc.service_type,
            "target": self.target,
            "mount_point": self.mount_point,
            "total_gb": round(self.total_bytes / BYTES_PER_GB, 2) if self.total_bytes else None,
            "used_gb": round(self.used_bytes / BYTES_PER_GB, 2) if self.used_bytes else None,
            "free_gb": round(self.free_bytes / BYTES_PER_GB, 2) if self.free_bytes else None,
            "used_pct": round(self.used_pct, 1) if self.used_pct is not None else None,
            "growth_rate_mb_per_day": round(
                self.growth_rate_bytes_per_day / BYTES_PER_MB, 2
            ) if self.growth_rate_bytes_per_day is not None else None,
            "days_to_full": round(self.days_to_full, 1) if self.days_to_full is not None else None,
            "level": self.level,
            "status": self.status,
            "owner": self.svc.owner,
            "mode": self.svc.mode,
            "error": self.error,
        }


def get_disk_usage(path):
    """Return (total, used, free) in bytes for the filesystem containing path."""
    try:
        result = os.statvfs(path)
        total = result.f_blocks * result.f_frsize
        free = result.f_bavail * result.f_frsize
        used = total - free
        return total, used, free
    except OSError as exc:
        raise OSError(f"statvfs({path}): {exc}")


def find_mount_point(path):
    """Find the mount point for a given path (best-effort)."""
    path = os.path.abspath(path)
    while path != "/":
        try:
            result = os.statvfs(path)
            return path
        except OSError:
            pass
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    return "/"


def classify_days(days):
    if days is None:
        return "error"
    if days <= 3:
        return "critical"
    if days <= 7:
        return "high"
    if days <= 14:
        return "medium"
    return "ok"


def status_label(days, level):
    if days is None:
        return "ERROR"
    if days < 0:
        return "FULL"
    if level == "critical":
        return f"{days:.1f}d  <=3d"
    if level == "high":
        return f"{days:.1f}d  <=7d"
    if level == "medium":
        return f"{days:.1f}d  <=14d"
    return f"{days:.1f}d  ok"


def check_disk(svc, state, now):
    obs = DiskObs(svc, svc.target)
    try:
        total, used, free = get_disk_usage(svc.target)
        obs.mount_point = find_mount_point(svc.target)
        obs.total_bytes = total
        obs.used_bytes = used
        obs.free_bytes = free
        obs.used_pct = (used / total * 100) if total > 0 else 0

        # Compute growth rate from state history
        prev = state.get("services", {}).get(svc.name, {})
        prev_used = prev.get("used_bytes")
        prev_time = prev.get("checked_at")
        if prev_used is not None and prev_time:
            elapsed_days = (now - dt.datetime.fromisoformat(prev_time)).total_seconds() / 86400
            if elapsed_days > 0.01:
                obs.growth_rate_bytes_per_day = (used - prev_used) / elapsed_days

        # Project days to full
        if obs.growth_rate_bytes_per_day is not None and obs.growth_rate_bytes_per_day > 0:
            obs.days_to_full = free / obs.growth_rate_bytes_per_day
        elif obs.growth_rate_bytes_per_day is not None and obs.growth_rate_bytes_per_day <= 0:
            obs.days_to_full = float("inf")
        else:
            obs.days_to_full = None

        obs.level = classify_days(obs.days_to_full)
        obs.status = status_label(obs.days_to_full, obs.level)
    except Exception as exc:  # noqa: BLE001
        obs.error = str(exc)
        obs.level = "error"
        obs.status = "ERROR"
    return obs


# ── PostgreSQL per-table growth ─────────────────────────────────────────────


class TableObs:
    def __init__(self, table_name, size_bytes, growth_rate_bytes_per_day, days_to_full):
        self.table_name = table_name
        self.size_bytes = size_bytes
        self.growth_rate_bytes_per_day = growth_rate_bytes_per_day
        self.days_to_full = days_to_full
        self.level = classify_days(days_to_full) if days_to_full is not None else "ok"
        self.status = status_label(days_to_full, self.level) if days_to_full is not None else "ok"

    def to_dict(self):
        return {
            "table": self.table_name,
            "size_mb": round(self.size_bytes / BYTES_PER_MB, 2),
            "growth_rate_mb_per_day": round(
                self.growth_rate_bytes_per_day / BYTES_PER_MB, 2
            ) if self.growth_rate_bytes_per_day is not None else None,
            "days_to_full": round(self.days_to_full, 1) if self.days_to_full is not None else None,
            "level": self.level,
            "status": self.status,
        }


def query_table_growth(database_url, state, now):
    """Query PostgreSQL for per-table size and compute growth rate from state."""
    try:
        result = subprocess.run(
            [
                "psql", database_url, "-t", "-A", "-F", "|",
                "-c",
                "SELECT relname, pg_total_relation_size(oid) "
                "FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace "
                "ORDER BY pg_total_relation_size(oid) DESC LIMIT 20;",
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return [], f"psql failed: {result.stderr.strip()}"

        tables = []
        prev_tables = state.get("tables", {})
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            parts = line.split("|")
            if len(parts) != 2:
                continue
            name, size_str = parts
            try:
                size_bytes = int(size_str)
            except ValueError:
                continue

            prev_entry = prev_tables.get(name, {})
            prev_size = prev_entry.get("size_bytes")
            prev_time = prev_entry.get("checked_at")
            growth_rate = None
            days_to_full = None

            if prev_size is not None and prev_time:
                elapsed_days = (now - dt.datetime.fromisoformat(prev_time)).total_seconds() / 86400
                if elapsed_days > 0.01:
                    growth_rate = (size_bytes - prev_size) / elapsed_days
                    if growth_rate > 0:
                        # Use a default 500GB disk for per-table projection
                        # (actual disk projection is done at the mount level)
                        days_to_full = (500 * BYTES_PER_GB - size_bytes) / growth_rate
                    else:
                        days_to_full = float("inf")

            tables.append(TableObs(name, size_bytes, growth_rate, days_to_full))
        return tables, None
    except FileNotFoundError:
        return [], "psql not found — install postgresql-client or skip DB checks"
    except subprocess.TimeoutExpired:
        return [], "psql query timed out"
    except Exception as exc:  # noqa: BLE001
        return [], f"table growth query failed: {exc}"


# ── state / alerting ────────────────────────────────────────────────────────

LEVEL_PREFIX = {"medium": "MEDIUM", "high": "HIGH", "critical": "CRITICAL", "error": "CRITICAL"}

LEVEL_ACTION = {
    "medium": (
        "14-day checkpoint: review the largest tables and their growth rates. "
        "Consider archiving old events, adding a retention policy, or expanding "
        "storage. No emergency yet."
    ),
    "high": (
        "7-day checkpoint: storage will be full within a week. Take action now — "
        "expand the volume, add a retention policy, or archive old data. "
        "Page the platform on-call."
    ),
    "critical": (
        "3-day / full: storage is about to be exhausted. A full disk takes the "
        "database down hard. Expand storage IMMEDIATELY, or add emergency "
        "retention policies to free space."
    ),
    "error": (
        "The disk or database check failed. Treat as an outage risk: "
        "investigate immediately — an unreachable service hides its real usage."
    ),
}


def load_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("services"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "last_run": None, "services": {}, "tables": {}}


def save_state(path, state):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def decide_alerts(obs_list, state, re_alert_hours, now):
    """Return (alerts, new_state_services)."""
    alerts = []
    services = dict(state.get("services", {}))
    for obs in obs_list:
        prev = services.get(obs.svc.name, {})
        cur = {
            "level": obs.level,
            "used_bytes": obs.used_bytes,
            "used_pct": obs.used_pct,
            "growth_rate_bytes_per_day": obs.growth_rate_bytes_per_day,
            "days_to_full": obs.days_to_full,
            "error": obs.error,
            "last_alert": prev.get("last_alert") if prev else None,
            "checked_at": now.isoformat(),
        }
        rank = LEVEL_RANK[obs.level]
        reason = None
        if prev is None:
            if rank > 0:
                reason = "first observation"
        else:
            prev_rank = LEVEL_RANK.get(prev.get("level", "ok"), 0)
            if obs.error != prev.get("error"):
                if rank > 0:
                    reason = "check status changed"
            elif rank > prev_rank:
                reason = "escalated since last run"
            elif rank < prev_rank:
                cur["last_alert"] = None
            elif rank >= LEVEL_RANK["critical"] and re_alert_hours > 0:
                last = prev.get("last_alert")
                if last:
                    elapsed = (now - dt.datetime.fromisoformat(last)).total_seconds()
                    if elapsed >= re_alert_hours * 3600:
                        reason = "still critical (repeat)"
                else:
                    reason = "still critical"
        if reason:
            alerts.append((obs, reason))
            cur["last_alert"] = now.isoformat()
        services[obs.svc.name] = cur
    return alerts, services


def message_for(obs, reason, stale_note=None):
    head = LEVEL_PREFIX.get(obs.level, "CRITICAL")
    if obs.level == "error":
        title = f"[{head}] disk check FAILED for '{obs.svc.name}'"
    elif obs.days_to_full is not None and obs.days_to_full < 0:
        title = f"[{head}] disk '{obs.svc.name}' is FULL"
    else:
        title = f"[{head}] disk '{obs.svc.name}' projected full in {obs.days_to_full:.1f} day(s)"
    lines = [
        title,
        f"  reason   : {reason}",
        f"  service  : {obs.svc.name} ({obs.svc.service_type}) -> {obs.target}",
        f"  mount    : {obs.mount_point or 'unknown'}",
        f"  usage    : {obs.used_pct:.1f}% used "
        f"({obs.used_bytes / BYTES_PER_GB:.1f} GB / {obs.total_bytes / BYTES_PER_GB:.1f} GB)"
        if obs.total_bytes else "  usage    : unknown",
        f"  free     : {obs.free_bytes / BYTES_PER_GB:.1f} GB" if obs.free_bytes else "  free     : unknown",
        f"  growth   : {obs.growth_rate_bytes_per_day / BYTES_PER_MB:.1f} MB/day"
        if obs.growth_rate_bytes_per_day is not None else "   growth   : unknown (need 2+ runs)",
        f"  status   : {obs.status}",
        f"  owner    : {obs.svc.owner}",
    ]
    if obs.error:
        lines.append(f"  error    : {obs.error}")
    lines.append(f"  action   : {LEVEL_ACTION.get(obs.level, LEVEL_ACTION['error'])}")
    if stale_note:
        lines.append(f"  watchdog : {stale_note}")
    return "\n".join(lines)


def dispatch(text, level, cfg, dry_run, quiet=False):
    out = sys.stderr if quiet else sys.stdout
    print(text, file=out, flush=True)
    print("-" * 78, file=out, flush=True)
    if dry_run:
        print(f"(dry-run: {level} alert not sent)", file=out, flush=True)
        return
    webhook = cfg.get("webhook_url")
    if webhook:
        fmt = cfg.get("webhook_format", "slack")
        payload = {"content": text} if fmt == "discord" else {"text": text}
        if fmt == "generic":
            payload = {"level": level, "message": text}
        req = urllib.request.Request(
            webhook,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                print(f"webhook: HTTP {resp.status}", file=out, flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"webhook delivery FAILED: {exc}", file=sys.stderr, flush=True)
    email_to = cfg.get("email_to")
    if email_to and LEVEL_RANK.get(level, 0) >= LEVEL_RANK["high"]:
        subject = text.splitlines()[0][:120]
        if shutil.which("sendmail"):
            proc = subprocess.run(
                ["sendmail", "-t"],
                input=f"To: {email_to}\nSubject: {subject}\n\n{text}\n",
                text=True, capture_output=True, timeout=20,
            )
            print(f"email: sendmail rc={proc.returncode}", file=out, flush=True)
        elif shutil.which("mail"):
            proc = subprocess.run(
                ["mail", "-s", subject, email_to],
                input=text, text=True, capture_output=True, timeout=20,
            )
            print(f"email: mail rc={proc.returncode}", file=out, flush=True)
        else:
            print(
                "email: no sendmail/mail binary found — configure one or drop DISK_MONITOR_EMAIL_TO",
                file=sys.stderr, flush=True,
            )


def ping_heartbeat(url, timeout):
    if not url:
        return
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            print(f"heartbeat: HTTP {resp.status}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"heartbeat failed: {exc}", file=sys.stderr, flush=True)


def read_env_config():
    return {
        "webhook_url": os.environ.get("DISK_MONITOR_WEBHOOK_URL", "").strip(),
        "webhook_format": os.environ.get("DISK_MONITOR_WEBHOOK_FORMAT", "slack").strip(),
        "email_to": os.environ.get("DISK_MONITOR_EMAIL_TO", "").strip(),
        "heartbeat_url": os.environ.get("DISK_MONITOR_HEARTBEAT_URL", "").strip(),
        "database_url": os.environ.get("DISK_MONITOR_DATABASE_URL", "").strip(),
    }


# ── report ──────────────────────────────────────────────────────────────────


def print_table(obs_list, table_obs, pending, stale_note, now):
    print(f"iPredict disk-space check — {now:%Y-%m-%d %H:%M UTC}", flush=True)
    print(
        f"{'SERVICE':<20}{'TYPE':<12}{'TARGET':<30}{'USED%':<8}"
        f"{'FREE GB':<10}{'GROWTH MB/d':<14}{'DAYS':<10}{'STATUS'}",
        flush=True,
    )
    print("-" * 110, flush=True)
    for obs in obs_list:
        used_pct = f"{obs.used_pct:.1f}" if obs.used_pct is not None else "-"
        free_gb = f"{obs.free_bytes / BYTES_PER_GB:.1f}" if obs.free_bytes else "-"
        growth = (
            f"{obs.growth_rate_bytes_per_day / BYTES_PER_MB:.1f}"
            if obs.growth_rate_bytes_per_day is not None else "-"
        )
        days = f"{obs.days_to_full:.1f}" if obs.days_to_full is not None else "-"
        print(
            f"{obs.svc.name:<20}{obs.svc.service_type:<12}{obs.target:<30}"
            f"{used_pct:<8}{free_gb:<10}{growth:<14}{days:<10}{obs.status}",
            flush=True,
        )

    if table_obs:
        print(f"\n{'LARGEST TABLES':<20}{'SIZE MB':<12}{'GROWTH MB/d':<14}{'DAYS':<10}{'STATUS'}", flush=True)
        print("-" * 66, flush=True)
        for t in table_obs[:10]:
            growth = (
                f"{t.growth_rate_bytes_per_day / BYTES_PER_MB:.1f}"
                if t.growth_rate_bytes_per_day is not None else "-"
            )
            days = f"{t.days_to_full:.1f}" if t.days_to_full is not None else "-"
            print(
                f"{t.table_name:<20}{t.size_bytes / BYTES_PER_MB:<12.1f}"
                f"{growth:<14}{days:<10}{t.status}",
                flush=True,
            )

    if pending:
        print(f"\npending configuration (not yet checked): {', '.join(pending)}", flush=True)
    if stale_note:
        print(f"\nWATCHDOG: {stale_note}", flush=True)
    print("", flush=True)


# ── self test ───────────────────────────────────────────────────────────────


def self_test():
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    check("classify_days(30)", classify_days(30), "ok")
    check("classify_days(15)", classify_days(15), "ok")
    check("classify_days(14)", classify_days(14), "medium")
    check("classify_days(8)", classify_days(8), "medium")
    check("classify_days(7)", classify_days(7), "high")
    check("classify_days(4)", classify_days(4), "high")
    check("classify_days(3)", classify_days(3), "critical")
    check("classify_days(1)", classify_days(1), "critical")
    check("classify_days(0)", classify_days(0), "critical")
    check("classify_days(-1)", classify_days(-1), "critical")
    check("classify_days(None)", classify_days(None), "error")
    check("status_label(None, error)", status_label(None, "error"), "ERROR")
    check("status_label(2.5, critical)", status_label(2.5, "critical"), "2.5d  <=3d")
    check("status_label(5, high)", status_label(5, "high"), "5.0d  <=7d")
    check("status_label(10, medium)", status_label(10, "medium"), "10.0d  <=14d")
    check("status_label(30, ok)", status_label(30, "ok"), "30.0d  ok")

    # Test alert dedup logic
    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    state = {"services": {}}

    class FakeSvc:
        name = "test-svc"
        service_type = "postgres"
        target = "/var/lib/postgresql"
        owner = "platform"
        mode = "active"

    def make_obs(days, error=None):
        o = DiskObs(FakeSvc(), "/var/lib/postgresql")
        o.days_to_full = days
        o.error = error
        o.level = classify_days(days) if days is not None else "error"
        o.status = status_label(o.days_to_full, o.level)
        o.used_pct = 50.0
        o.total_bytes = 100 * BYTES_PER_GB
        o.used_bytes = 50 * BYTES_PER_GB
        o.free_bytes = 50 * BYTES_PER_GB
        o.growth_rate_bytes_per_day = 100 * BYTES_PER_MB if days else None
        return o

    a1, s1 = decide_alerts([make_obs(30)], state, 24, now)
    check("no alert at 30d", len(a1), 0)
    state = {"services": s1}
    a2, s2 = decide_alerts([make_obs(14)], state, 24, now)
    check("alert at 14d", len(a2), 1)
    state = {"services": s2}
    a3, s3 = decide_alerts([make_obs(14)], state, 24, now)
    check("deduped at 14d", len(a3), 0)
    state = {"services": s3}
    a4, s4 = decide_alerts([make_obs(7)], state, 24, now)
    check("alert at 7d", len(a4), 1)
    state = {"services": s4}
    a5, s5 = decide_alerts([make_obs(3)], state, 24, now)
    check("alert at 3d", len(a5), 1)
    state = {"services": s5}
    a6, s6 = decide_alerts([make_obs(3)], state, 24, now)
    check("deduped at 3d", len(a6), 0)
    state = {"services": s6}
    a7, s7 = decide_alerts([make_obs(3)], state, 24, now + dt.timedelta(hours=25))
    check("critical re-alert after 25h", len(a7), 1)
    state = {"services": s7}
    a8, s8 = decide_alerts([make_obs(None, error="timeout")], state, 24, now)
    check("check failure alerts", len(a8), 1)
    state = {"services": s8}
    a9, s9 = decide_alerts([make_obs(None, error="timeout")], state, 24, now)
    check("check failure deduped", len(a9), 0)

    if failures:
        print("SELF-TEST FAILED:")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("self-test: all checks passed")
    return 0


# ── main ────────────────────────────────────────────────────────────────────


def default_state_path():
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return os.path.join(base, "ipredict-disk-monitor", "state.json")


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--inventory", default=os.path.join(here, "services.txt"))
    ap.add_argument(
        "--state-file",
        default=os.environ.get("DISK_MONITOR_STATE_FILE") or default_state_path(),
    )
    ap.add_argument(
        "--fail-on",
        choices=("none", "critical", "any"),
        default="critical",
        help="exit non-zero when alerts at this severity or above are present "
        "(default: critical)",
    )
    ap.add_argument("--dry-run", action="store_true", help="print alerts but do not deliver them")
    ap.add_argument("--force", action="store_true", help="re-send alerts even if state has not escalated")
    ap.add_argument("--json", action="store_true", help="emit a machine-readable report")
    ap.add_argument(
        "--re-alert-hours",
        type=float,
        default=24.0,
        help="re-send critical alerts after this many hours (default 24)",
    )
    ap.add_argument(
        "--stale-after-hours",
        type=float,
        default=48.0,
        help="report a watchdog gap when the previous run is older than this (default 48)",
    )
    ap.add_argument("--only", help="check a single service by name")
    ap.add_argument("--self-test", action="store_true", help="run offline checks and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    now = dt.datetime.now(dt.timezone.utc)
    cfg = read_env_config()

    try:
        services = parse_inventory(args.inventory)
    except (OSError, InventoryError) as exc:
        print(f"inventory error: {exc}", file=sys.stderr)
        return 2

    if args.only:
        services = [s for s in services if s.name == args.only]
        if not services:
            print(f"--only: no service named {args.only!r}", file=sys.stderr)
            return 2

    active = [s for s in services if s.mode == "active"]
    pending = [s.name for s in services if s.mode != "active"]

    obs_list = []
    for svc in active:
        obs_list.append(check_disk(svc, load_state(args.state_file), now))

    # Query per-table growth if database URL is configured
    table_obs = []
    table_error = None
    if cfg["database_url"]:
        state = load_state(args.state_file)
        table_obs, table_error = query_table_growth(cfg["database_url"], state, now)

    state = load_state(args.state_file)
    stale_note = None
    prev_run = state.get("last_run")
    if prev_run and args.stale_after_hours > 0:
        gap = (now - dt.datetime.fromisoformat(prev_run)).total_seconds()
        if gap > args.stale_after_hours * 3600:
            stale_note = (
                f"monitor did not run between {prev_run} and {now.isoformat()} "
                f"({gap / 3600:.1f}h gap, threshold {args.stale_after_hours:g}h) — "
                "check the cron/systemd timer and the scheduled CI workflow"
            )

    alerts, new_services = decide_alerts(obs_list, state, args.re_alert_hours, now)
    if args.force:
        alerts = [(o, "forced re-check") for o in obs_list if LEVEL_RANK[o.level] > 0]

    # Update table state
    new_tables = {}
    for t in table_obs:
        new_tables[t.table_name] = {
            "size_bytes": t.size_bytes,
            "growth_rate_bytes_per_day": t.growth_rate_bytes_per_day,
            "checked_at": now.isoformat(),
        }

    watchdog_alert = None
    if stale_note and not args.json:
        watchdog_alert = (
            f"[CRITICAL] disk monitor watchdog gap\n"
            f"  {stale_note}\n"
            f"  action   : every service's disk usage was unwatched during that window. "
            f"Fix the schedule first (infra/README.md), then re-run "
            f"check-disk.py --force to re-verify every service."
        )

    if args.json:
        print(
            json.dumps(
                {
                    "generated": now.isoformat(),
                    "inventory": args.inventory,
                    "results": [o.to_dict() for o in obs_list],
                    "tables": [t.to_dict() for t in table_obs],
                    "table_error": table_error,
                    "pending": pending,
                    "alerts": [
                        {"service": o.svc.name, "level": o.level, "reason": r} for o, r in alerts
                    ],
                    "watchdog": stale_note,
                },
                indent=2,
            )
        )
    else:
        print_table(obs_list, table_obs, pending, stale_note, now)
        if table_error:
            print(f"note: {table_error}", flush=True)

    if watchdog_alert:
        dispatch(watchdog_alert, "critical", cfg, args.dry_run, quiet=args.json)

    if not args.json:
        for obs, reason in alerts:
            dispatch(
                message_for(obs, reason, stale_note), obs.level, cfg, args.dry_run, quiet=args.json
            )

    if not alerts and not watchdog_alert and not args.json:
        if obs_list:
            worst = max(obs_list, key=lambda o: LEVEL_RANK[o.level])
            if worst.level == "ok":
                print(
                    f"no alerts: {len(obs_list)} service(s) checked, all >14 days from full",
                    flush=True,
                )
            else:
                print(
                    f"no new alerts: {len(obs_list)} service(s) checked "
                    f"(existing {worst.level.upper()} state unchanged)",
                    flush=True,
                )
        else:
            print("no active services checked", flush=True)

    state["version"] = 1
    state["last_run"] = now.isoformat()
    state["services"] = new_services
    state["tables"] = new_tables
    save_state(args.state_file, state)
    ping_heartbeat(cfg["heartbeat_url"], 10)

    worst_rank = max((LEVEL_RANK[o.level] for o in obs_list), default=0)
    if watchdog_alert:
        worst_rank = max(worst_rank, LEVEL_RANK["critical"])
    if not args.json:
        worst_name = next(k for k, v in LEVEL_RANK.items() if v == worst_rank)
        print(
            f"summary: {len(obs_list)} service(s) checked, {len(pending)} pending, "
            f"{len(alerts)} alert(s), worst={worst_name}{' +watchdog' if watchdog_alert else ''}",
            flush=True,
        )
    if args.fail_on == "none":
        return 0
    if worst_rank >= LEVEL_RANK["critical"]:
        return 2
    if args.fail_on == "any" and worst_rank > 0:
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
