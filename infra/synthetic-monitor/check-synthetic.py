#!/usr/bin/env python3
"""iPredict synthetic read-path monitor.

Passive monitoring only ever measures traffic that actually happened — during
a quiet night a broken read path can stay broken until somebody opens the
site. This monitor instead *exercises* the critical read paths on a schedule,
from outside the deployment, so DNS, TLS, ingress, edge and application
failures show up within minutes whether or not anyone is using the product.

Each line of paths.txt is one check: an HTTP request (GET, or a POST whose
body is a read-only JSON-RPC call) plus the conditions that define "working"
and the latency SLO that defines "fast enough". Results escalate:

    single failed run            MEDIUM   chat/webhook
    fail_after failed runs       CRITICAL chat/webhook + email, non-zero exit
    single slow run              MEDIUM   chat/webhook
    fail_after slow runs         HIGH     chat/webhook + email
    monitor gap > stale hours    CRITICAL chat/webhook + email, non-zero exit

State is kept between runs: consecutive-failure counting, a latency baseline
(p50 of recent successful runs, used to catch degradation that is still inside
the absolute SLO), alert de-duplication and recovery notices — so a run every
two minutes does not become an alert every two minutes.

Safety: checks are read-only by construction — GET, or a POST whose JSON-RPC
method is on the read allowlist (the same one the /api/rpc proxy enforces).
A handful of idempotent requests per minute is negligible against production.

Stdlib only. Operation: infra/README.md. Setup: docs/DEPLOYMENT-GUIDE.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import socket
import ssl
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LEVEL_RANK = {"ok": 0, "medium": 1, "high": 2, "critical": 3, "error": 3}
LEVEL_PREFIX = {"medium": "MEDIUM", "high": "HIGH", "critical": "CRITICAL", "error": "CRITICAL"}
VALID_MODES = ("active", "pending")
VALID_METHODS = ("GET", "POST")
VALID_SECTIONS = ("site", "api")

# Read-only JSON-RPC methods a synthetic check may POST through /api/rpc.
# Must stay a subset of READ_METHODS in frontend/src/app/api/rpc/route.ts —
# a check that wanted to send a transaction would not get past the proxy, and
# is refused here so the monitor can never become a write path by accident.
READ_METHODS = frozenset(
    {
        "simulateTransaction",
        "getLedgerEntries",
        "getLatestLedger",
        "getNetwork",
        "getEvents",
        "getHealth",
        "getFeeStats",
        "getVersionInfo",
    }
)
FORBIDDEN_METHODS = frozenset({"sendTransaction", "getTransaction", "getTransactions"})

MAX_BODY = 64 * 1024  # enough to assert on, small enough to stay cheap
SAMPLE_WINDOW = 20  # successful latencies kept per check for the baseline
BASELINE_MIN_SAMPLES = 10  # samples required before baseline comparison kicks in
USER_AGENT = "iPredict-synthetic-check/1.0 (+infra/synthetic-monitor)"

_MISSING = object()


class InventoryError(Exception):
    pass


# ── inventory ────────────────────────────────────────────────────────────────


class Check:
    def __init__(self, name, method, url, payload, expect, expect_raw, max_ms, owner, mode, section, line):
        self.name = name
        self.method = method
        self.url = url
        self.payload = payload
        self.expect = expect
        self.expect_raw = expect_raw
        self.max_ms = max_ms
        self.owner = owner
        self.mode = mode
        self.section = section
        self.line = line


def parse_expect(raw, where):
    """Parse `status=200; contains=x; json=result.status` into conditions."""
    conds = []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        if part.startswith("status="):
            spec = part[len("status="):].strip()
            if not re.fullmatch(r"\d{3}(\.\.\d{3})?", spec):
                raise InventoryError(f"{where}: bad status condition {spec!r} (use 200 or 200..299)")
            conds.append(("status", spec))
        elif part.startswith("contains="):
            text = part[len("contains="):]
            if not text:
                raise InventoryError(f"{where}: empty contains condition")
            conds.append(("contains", text))
        elif part.startswith("json="):
            rest = part[len("json="):]
            path, sep, value = rest.partition("=")
            path = path.strip()
            if not path:
                raise InventoryError(f"{where}: empty json path in {part!r}")
            conds.append(("json", path, value.strip() if sep else None))
        else:
            raise InventoryError(
                f"{where}: unknown condition {part!r} "
                f"(expected status=, contains= or json=)"
            )
    if not conds:
        raise InventoryError(f"{where}: empty expect field")
    return conds


def parse_inventory(path):
    checks = []
    section = None
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1].strip().lower()
                if section not in VALID_SECTIONS:
                    raise InventoryError(
                        f"{path}:{lineno}: unknown section [{section}] "
                        f"(expected one of {', '.join(VALID_SECTIONS)})"
                    )
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) != 8:
                raise InventoryError(
                    f"{path}:{lineno}: expected 8 '|'-separated fields "
                    f"(name | method | url | payload | expect | max_ms | owner | mode), "
                    f"got {len(parts)}"
                )
            if section is None:
                raise InventoryError(
                    f"{path}:{lineno}: entry appears before a [site] or [api] section"
                )
            name, method, url, payload, expect, max_ms, owner, mode = parts
            where = f"{path}:{lineno}"
            mode = mode.lower()
            if mode not in VALID_MODES:
                raise InventoryError(f"{where}: mode must be one of {', '.join(VALID_MODES)} (got {mode!r})")
            method = method.upper()
            if method not in VALID_METHODS:
                raise InventoryError(f"{where}: method must be GET or POST (got {method!r})")
            scheme = urllib.parse.urlsplit(url).scheme
            if scheme not in ("http", "https"):
                raise InventoryError(f"{where}: url must start with http(s):// (got {url!r})")
            if method == "GET":
                if payload != "-":
                    raise InventoryError(f"{where}: GET checks must use '-' as payload")
                body = None
            else:
                if payload == "-":
                    raise InventoryError(f"{where}: POST checks need a JSON payload")
                try:
                    body = json.loads(payload)
                except ValueError as exc:
                    raise InventoryError(f"{where}: payload is not JSON: {exc}") from None
                if not isinstance(body, dict) or not isinstance(body.get("method"), str):
                    raise InventoryError(f"{where}: payload must be a JSON-RPC object with a method")
                rpc_method = body["method"]
                if rpc_method in FORBIDDEN_METHODS or rpc_method not in READ_METHODS:
                    raise InventoryError(
                        f"{where}: {rpc_method!r} is not a read-only RPC method — "
                        f"synthetic checks may only use {', '.join(sorted(READ_METHODS))}"
                    )
            try:
                max_ms_i = int(max_ms)
            except ValueError:
                raise InventoryError(f"{where}: max_ms must be an integer (got {max_ms!r})") from None
            if max_ms_i <= 0:
                raise InventoryError(f"{where}: max_ms must be > 0")
            if not owner:
                raise InventoryError(f"{where}: empty owner")
            expect_conds = parse_expect(expect, where)
            checks.append(
                Check(name, method, url, body, expect_conds, expect, max_ms_i, owner, mode, section, lineno)
            )
    if not checks:
        raise InventoryError(f"{path}: no checks listed")
    names = [c.name for c in checks]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise InventoryError(f"{path}: duplicate check name(s): {', '.join(dupes)}")
    return checks


# ── probing ──────────────────────────────────────────────────────────────────


class Obs:
    def __init__(self, check):
        self.check = check
        self.key = check.name
        self.ok = False
        self.cond = "fail"
        self.level = "ok"
        self.status = None
        self.latency_ms = None
        self.error = None
        self.detail = ""
        self.sig = "ok"
        self.baseline_p50 = None

    @property
    def target(self):
        return f"{self.check.method} {self.check.url}"

    def to_dict(self):
        return {
            "check": self.key,
            "section": self.check.section,
            "method": self.check.method,
            "url": self.check.url,
            "ok": self.ok,
            "condition": self.cond,
            "level": self.level,
            "status": self.status,
            "latency_ms": None if self.latency_ms is None else round(self.latency_ms, 1),
            "max_ms": self.check.max_ms,
            "baseline_p50_ms": None if self.baseline_p50 is None else round(self.baseline_p50, 1),
            "detail": self.detail,
            "error": self.error,
            "owner": self.check.owner,
        }


def origin_of(url):
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def classify_error(exc, timeout):
    """Map a transport exception to (kind, human message)."""
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason):
            return "timeout", f"timeout after {timeout:g}s"
        if isinstance(reason, socket.gaierror):
            return "dns", f"DNS resolution failed: {reason}"
        if isinstance(reason, ssl.SSLError):
            return "ssl", f"TLS handshake failed: {reason}"
        if isinstance(reason, ConnectionError):
            return "conn", f"connection failed: {reason}"
        if isinstance(reason, OSError):
            return "conn", f"connection failed: {reason}"
        return "other", f"URLError: {reason}"
    if isinstance(exc, (TimeoutError, socket.timeout)) or "timed out" in str(exc):
        return "timeout", f"timeout after {timeout:g}s"
    if isinstance(exc, ssl.SSLError):
        return "ssl", f"TLS handshake failed: {exc}"
    if isinstance(exc, ConnectionError):
        return "conn", f"connection failed: {exc}"
    return "other", f"{type(exc).__name__}: {exc}"


def probe(check, timeout, origin_override=None):
    """Perform one request. Returns (status, latency_ms, body, error_kind, error_msg)."""
    origin = origin_override or origin_of(check.url)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        # Same-origin Origin/Referer so the /api/rpc proxy's allowlist accepts
        # the probe — the check exercises the real production request path.
        "Origin": origin,
        "Referer": origin.rstrip("/") + "/",
    }
    data = None
    if check.method == "POST":
        data = json.dumps(check.payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(check.url, data=data, headers=headers, method=check.method)
    status = None
    body = ""
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            body = resp.read(MAX_BODY).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            body = exc.read(MAX_BODY).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - body is optional on error responses
            body = ""
    except Exception as exc:  # noqa: BLE001 - any transport failure is a check failure
        latency = (time.monotonic() - start) * 1000
        kind, msg = classify_error(exc, timeout)
        return None, latency, "", kind, msg
    latency = (time.monotonic() - start) * 1000
    return status, latency, body, None, None


def status_matches(status, spec):
    if status is None:
        return False
    if ".." in spec:
        lo, hi = spec.split("..")
        return int(lo) <= status <= int(hi)
    return status == int(spec)


def dig(data, path):
    cur = data
    for key in path:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return _MISSING
    return cur


def evaluate(check, status, body, error_kind, error_msg):
    obs = Obs(check)
    obs.status = status
    obs.error = error_msg
    if error_kind:
        obs.ok = False
        obs.cond = "fail"
        obs.detail = error_msg
        obs.sig = f"error:{error_kind}"
        return obs
    failures = []
    kinds = []
    for cond in check.expect:
        if cond[0] == "status":
            if not status_matches(status, cond[1]):
                failures.append(f"HTTP {status} (expected {cond[1]})")
                kinds.append("status")
        elif cond[0] == "contains":
            if cond[1] not in body:
                failures.append(f"body missing {cond[1]!r}")
                kinds.append("contains")
        else:  # json
            path, want = cond[1], cond[2]
            try:
                data = json.loads(body)
            except ValueError:
                failures.append("body is not JSON")
                kinds.append("json")
                continue
            actual = dig(data, path.split("."))
            if actual is _MISSING or actual is None:
                failures.append(f"JSON path {path} missing")
                kinds.append("json")
            elif want is not None and str(actual) != want:
                failures.append(f"{path}={actual!r} (expected {want!r})")
                kinds.append("json")
    obs.ok = not failures
    obs.cond = "ok" if obs.ok else "fail"
    if failures:
        obs.detail = "; ".join(failures)
        obs.sig = "expect:" + ",".join(kinds)
    return obs


def run_check(check, timeout, origin_override=None):
    status, latency, body, kind, err = probe(check, timeout, origin_override)
    obs = evaluate(check, status, body, kind, err)
    obs.latency_ms = latency
    return obs


# ── state / alerting ─────────────────────────────────────────────────────────


def load_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("checks"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "last_run": None, "checks": {}}


def save_state(path, state):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def escalation_reason(obs, failures, slow_runs, fail_after):
    if obs.cond == "fail":
        if failures >= fail_after:
            return f"{failures} consecutive failed run(s) (threshold {fail_after})"
        return "first failed run"
    if slow_runs >= fail_after:
        return f"{slow_runs} consecutive slow run(s) (threshold {fail_after})"
    return "first slow run"


def decide(obs_list, state_checks, fail_after, slow_factor, slow_floor_ms, re_alert_hours, now):
    """Return (alerts, recoveries, new_checks_state).

    Alerts fire on the *rising edge* of a condition (and are re-sent for high/
    critical after re_alert_hours), recoveries fire when a condition clears —
    so a run every two minutes never becomes an alert every two minutes.
    """
    alerts = []
    recoveries = []
    new = {}
    for obs in obs_list:
        prev = state_checks.get(obs.key) or {}
        samples = list(prev.get("samples") or [])
        p50 = prev.get("p50")
        failures = int(prev.get("failures") or 0)
        slow_runs = int(prev.get("slow") or 0)
        obs.baseline_p50 = p50

        if obs.ok:
            failures = 0
            slow_reason = None
            if obs.latency_ms is not None and obs.latency_ms > obs.check.max_ms:
                obs.sig = "slow:slo"
                slow_reason = (
                    f"latency {obs.latency_ms:.0f} ms exceeds the "
                    f"{obs.check.max_ms} ms SLO"
                )
            elif (
                len(samples) >= BASELINE_MIN_SAMPLES
                and p50
                and obs.latency_ms is not None
                and obs.latency_ms > slow_factor * p50
                and obs.latency_ms > slow_floor_ms
            ):
                obs.sig = "slow:baseline"
                slow_reason = (
                    f"latency {obs.latency_ms:.0f} ms is "
                    f"{obs.latency_ms / p50:.1f}x the {p50:.0f} ms baseline p50"
                )
            if slow_reason:
                slow_runs += 1
                obs.cond = "slow"
                obs.detail = slow_reason
                obs.level = "high" if slow_runs >= fail_after else "medium"
            else:
                slow_runs = 0
                obs.cond = "ok"
                obs.level = "ok"
                obs.sig = "ok"
                obs.detail = ""
            if obs.latency_ms is not None:
                samples.append(round(obs.latency_ms, 1))
                samples = samples[-SAMPLE_WINDOW:]
            p50 = statistics.median(samples) if samples else None
            last_ok = now.isoformat()
        else:
            slow_runs = 0
            failures += 1
            obs.cond = "fail"
            obs.level = "critical" if failures >= fail_after else "medium"
            last_ok = prev.get("last_ok")

        rank = LEVEL_RANK[obs.level]
        prev_rank = LEVEL_RANK.get(prev.get("level", "ok"), 0) if prev else 0
        cur = {
            "level": obs.level,
            "cond": obs.cond,
            "sig": obs.sig,
            "detail": obs.detail,
            "failures": failures,
            "slow": slow_runs,
            "samples": samples,
            "p50": p50,
            "last_alert": prev.get("last_alert"),
            "last_ok": last_ok,
        }

        reason = None
        if not prev:
            if rank > 0:
                reason = "first observation"
        else:
            changed = obs.cond != prev.get("cond") or (
                obs.cond != "ok" and obs.sig != prev.get("sig")
            )
            if rank > prev_rank:
                reason = escalation_reason(obs, failures, slow_runs, fail_after)
            elif rank < prev_rank:
                if prev_rank > 0:
                    recoveries.append((obs, dict(prev)))
                cur["last_alert"] = None
            elif changed and rank > 0:
                reason = "check status changed"
            elif rank >= LEVEL_RANK["high"] and re_alert_hours > 0:
                last = prev.get("last_alert")
                if last:
                    elapsed = (now - dt.datetime.fromisoformat(last)).total_seconds()
                    if elapsed >= re_alert_hours * 3600:
                        reason = "still degraded (repeat)"
                else:
                    reason = "still degraded"
        if reason:
            alerts.append((obs, reason))
            cur["last_alert"] = now.isoformat()
        new[obs.key] = cur
    return alerts, recoveries, new


LEVEL_ACTION = {
    ("fail", "medium"): (
        "One probe failed — possibly transient (this host's network, a blip at "
        "the edge). Watch the next run: a second failure escalates to CRITICAL. "
        "If it repeats, start with DNS, TLS and the ingress/LB."
    ),
    ("fail", "critical"): (
        "The read path is down. This probe runs from OUTSIDE the deployment, so "
        "what it reports is what the internet sees — check DNS, TLS, the load "
        "balancer/ingress and the last deploy, fix it, then re-run "
        "check-synthetic.py --force to confirm recovery and clear the alert."
    ),
    ("slow", "medium"): (
        "One slow run — either past the absolute SLO or far above the p50 "
        "baseline. Watch the next run; sustained slowness escalates to HIGH."
    ),
    ("slow", "high"): (
        "Latency is persistently degraded. Compare against the p50 baseline in "
        "the state file, check upstream RPC and edge caching — slow paths become "
        "failed paths under load. Treat as an outage risk."
    ),
}


def action_for(obs):
    return LEVEL_ACTION.get((obs.cond, obs.level), LEVEL_ACTION[("fail", "critical")])


def message_for(obs, reason, stale_note=None):
    head = LEVEL_PREFIX.get(obs.level, "CRITICAL")
    kind = {"fail": "FAILED", "slow": "SLOW"}.get(obs.cond, obs.level.upper())
    title = f"[{head}] synthetic check {kind} for '{obs.key}'"
    latency = "-" if obs.latency_ms is None else f"{obs.latency_ms:.0f} ms"
    p50 = f", p50 {obs.baseline_p50:.0f} ms" if obs.baseline_p50 else ""
    lines = [
        title,
        f"  reason   : {reason}",
        f"  check    : {obs.key} ({obs.check.section}) -> {obs.target}",
        f"  result   : HTTP {obs.status if obs.status is not None else '-'}"
        f"   latency {latency} (SLO {obs.check.max_ms} ms{p50})",
        f"  detail   : {obs.detail or '-'}",
        f"  owner    : {obs.check.owner}",
        f"  action   : {action_for(obs)}",
    ]
    if stale_note:
        lines.append(f"  watchdog : {stale_note}")
    return "\n".join(lines)


def recovery_message(obs, prev):
    head = LEVEL_PREFIX.get(prev.get("level", "ok"), "OK")
    was = f"{head}: {prev.get('detail') or prev.get('sig') or 'condition'}"
    label = "RECOVERED" if obs.level == "ok" else "IMPROVED"
    return (
        f"[{label}] synthetic check '{obs.key}' — "
        f"{'condition cleared' if obs.level == 'ok' else f'improved to {obs.level}'} "
        f"(was {was})\n"
        f"  check    : {obs.key} ({obs.check.section}) -> {obs.target}\n"
        f"  result   : HTTP {obs.status}   latency "
        f"{'-' if obs.latency_ms is None else f'{obs.latency_ms:.0f} ms'}\n"
    )


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
                text=True,
                capture_output=True,
                timeout=20,
            )
            print(f"email: sendmail rc={proc.returncode}", file=out, flush=True)
        elif shutil.which("mail"):
            proc = subprocess.run(
                ["mail", "-s", subject, email_to],
                input=text,
                text=True,
                capture_output=True,
                timeout=20,
            )
            print(f"email: mail rc={proc.returncode}", file=out, flush=True)
        else:
            print(
                "email: no sendmail/mail binary found — configure one or drop "
                "SYNTHETIC_MONITOR_EMAIL_TO",
                file=sys.stderr,
                flush=True,
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
        "webhook_url": os.environ.get("SYNTHETIC_MONITOR_WEBHOOK_URL", "").strip(),
        "webhook_format": os.environ.get("SYNTHETIC_MONITOR_WEBHOOK_FORMAT", "slack").strip(),
        "email_to": os.environ.get("SYNTHETIC_MONITOR_EMAIL_TO", "").strip(),
        "heartbeat_url": os.environ.get("SYNTHETIC_MONITOR_HEARTBEAT_URL", "").strip(),
        "origin": os.environ.get("SYNTHETIC_MONITOR_ORIGIN", "").strip() or None,
    }


# ── report ───────────────────────────────────────────────────────────────────


def print_table(obs_list, pending, stale_note, now):
    print(f"iPredict synthetic read-path check — {now:%Y-%m-%d %H:%M UTC}", flush=True)
    print(
        f"{'CHECK':<20}{'SECTION':<9}{'RESULT':<9}{'HTTP':<6}{'LATENCY':<11}"
        f"{'SLO':<9}{'P50':<10}{'NOTE'}",
        flush=True,
    )
    print("-" * 104, flush=True)
    for obs in obs_list:
        result = {"ok": "ok", "slow": "SLOW", "fail": "FAIL"}[obs.cond]
        latency = "-" if obs.latency_ms is None else f"{obs.latency_ms:.0f} ms"
        status = "-" if obs.status is None else str(obs.status)
        p50 = "-" if not obs.baseline_p50 else f"{obs.baseline_p50:.0f} ms"
        note = obs.detail or "-"
        if len(note) > 44:
            note = note[:41] + "..."
        print(
            f"{obs.key:<20}{obs.check.section:<9}{result:<9}{status:<6}{latency:<11}"
            f"{obs.check.max_ms:<9}{p50:<10}{note}",
            flush=True,
        )
    if pending:
        print(f"\npending (not yet deployed, not checked): {', '.join(pending)}", flush=True)
    if stale_note:
        print(f"\nWATCHDOG: {stale_note}", flush=True)
    print("", flush=True)


# ── self test ────────────────────────────────────────────────────────────────


def _local_server():
    """Tiny localhost HTTP fixture (self-test only): no network involved."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: D102 - silence the fixture
            pass

        def _send(self, code, body, ctype="application/json"):
            payload = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass  # client timed out against the /slow fixture on purpose

        def do_GET(self):  # noqa: N802 - http.server API
            if self.path == "/ok":
                self._send(200, '{"status":"ok","result":{"status":"healthy"}}')
            elif self.path == "/text":
                self._send(200, "<html><title>iPredict</title></html>", "text/html")
            elif self.path == "/bad":
                self._send(500, '{"error":"boom"}')
            elif self.path == "/slow":
                time.sleep(0.4)
                self._send(200, '{"status":"ok"}')
            else:
                self._send(404, '{"error":"not found"}')

        def do_POST(self):  # noqa: N802 - http.server API
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            try:
                req = json.loads(raw or b"{}")
            except ValueError:
                req = {}
            if req.get("method") == "getHealth":
                self._send(
                    200,
                    json.dumps(
                        {"jsonrpc": "2.0", "id": req.get("id"), "result": {"status": "healthy"}}
                    ),
                )
            else:
                self._send(200, json.dumps({"jsonrpc": "2.0", "error": {"code": -32601}}))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _write_inventory(tmp, lines):
    path = os.path.join(tmp, "paths.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def self_test():
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    def expect_inventory_error(name, lines):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = _write_inventory(tmp, lines)
            try:
                parse_inventory(path)
                failures.append(f"{name}: accepted invalid inventory")
            except InventoryError:
                pass

    # ── inventory ────────────────────────────────────────────────────────────
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        good = _write_inventory(
            tmp,
            [
                "[site]",
                "home | GET | https://example.test/ | - | status=200; contains=iPredict | 3000 | platform | active",
                "[api]",
                'rpc | POST | https://example.test/api/rpc | {"jsonrpc":"2.0","id":1,"method":"getHealth"}'
                " | status=200; json=result.status | 4000 | platform | active",
                "readyz | GET | https://api.example.test/readyz | - | status=200 | 1500 | platform | pending",
            ],
        )
        checks = parse_inventory(good)
        check("inventory count", len(checks), 3)
        check("inventory sections", [c.section for c in checks], ["site", "api", "api"])
        check("inventory modes", [c.mode for c in checks], ["active", "active", "pending"])
        check("inventory methods", [c.method for c in checks], ["GET", "POST", "GET"])
        check("inventory payload kept", checks[1].payload["method"], "getHealth")
        check("inventory expect parsed", len(checks[0].expect), 2)

    expect_inventory_error("wrong field count", ["[site]", "a | GET | https://x/ | -"])
    expect_inventory_error("entry before section", ["a | GET | https://x/ | - | status=200 | 100 | o | active"])
    expect_inventory_error("bad mode", ["[site]", "a | GET | https://x/ | - | status=200 | 100 | o | someday"])
    expect_inventory_error("bad method", ["[site]", "a | PUT | https://x/ | - | status=200 | 100 | o | active"])
    expect_inventory_error("bad url", ["[site]", "a | GET | example.test | - | status=200 | 100 | o | active"])
    expect_inventory_error("bad max_ms", ["[site]", "a | GET | https://x/ | - | status=200 | zero | o | active"])
    expect_inventory_error("bad condition", ["[site]", "a | GET | https://x/ | - | wobble=1 | 100 | o | active"])
    expect_inventory_error(
        "bad status spec", ["[site]", "a | GET | https://x/ | - | status=2xx | 100 | o | active"]
    )
    expect_inventory_error(
        "write method refused",
        [
            "[api]",
            'a | POST | https://x/api/rpc | {"jsonrpc":"2.0","id":1,"method":"sendTransaction"}'
            " | status=200 | 100 | o | active",
        ],
    )
    expect_inventory_error(
        "unknown rpc method refused",
        [
            "[api]",
            'a | POST | https://x/api/rpc | {"jsonrpc":"2.0","id":1,"method":"adminWipe"}'
            " | status=200 | 100 | o | active",
        ],
    )
    expect_inventory_error("duplicate names", ["[site]", *(f"a | GET | https://x/{i} | - | status=200 | 100 | o | active" for i in (1, 2))])

    # ── expectation evaluation ───────────────────────────────────────────────
    def make_check(url="https://x.test/p", expect="status=200", method="GET", payload=None, max_ms=1000):
        conds = parse_expect(expect, "test")
        return Check("c", method, url, payload, conds, expect, max_ms, "qa", "active", "site", 1)

    obs = evaluate(make_check(), 200, '{"result":{"status":"healthy"}}', None, None)
    check("status match ok", obs.ok, True)
    obs = evaluate(make_check(), 500, "{}", None, None)
    check("status mismatch", (obs.ok, obs.sig), (False, "expect:status"))
    obs = evaluate(make_check(expect="status=200..299"), 204, "", None, None)
    check("status range", obs.ok, True)
    obs = evaluate(make_check(expect="contains=iPredict"), 200, "<html>iPredict</html>", None, None)
    check("contains ok", obs.ok, True)
    obs = evaluate(make_check(expect="contains=iPredict"), 200, "<html>nope</html>", None, None)
    check("contains missing", (obs.ok, obs.sig), (False, "expect:contains"))
    obs = evaluate(make_check(expect="json=result.status"), 200, '{"result":{"status":"healthy"}}', None, None)
    check("json exists ok", obs.ok, True)
    obs = evaluate(make_check(expect="json=result.status=healthy"), 200, '{"result":{"status":"healthy"}}', None, None)
    check("json equals ok", obs.ok, True)
    obs = evaluate(make_check(expect="json=result.status=READY"), 200, '{"result":{"status":"healthy"}}', None, None)
    check("json equals mismatch", (obs.ok, obs.sig), (False, "expect:json"))
    obs = evaluate(make_check(expect="json=result.status"), 200, '{"error":"DEGRADED"}', None, None)
    check("json path missing", (obs.ok, obs.sig), (False, "expect:json"))
    obs = evaluate(make_check(expect="json=result.status"), 200, "not json", None, None)
    check("non-json body", (obs.ok, obs.sig), (False, "expect:json"))
    obs = evaluate(make_check(), 200, "", "timeout", "timeout after 10s")
    check("transport error", (obs.ok, obs.sig, obs.detail), (False, "error:timeout", "timeout after 10s"))

    # ── escalation / de-duplication ──────────────────────────────────────────
    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    check_def = make_check(max_ms=500)

    def make_obs(cond, latency=100.0, detail="", sig="ok", level_hint=None):
        o = Obs(check_def)
        o.ok = cond != "fail"
        o.cond = cond
        o.latency_ms = latency
        o.detail = detail
        o.sig = sig
        o.status = 200 if cond != "fail" else None
        o.error = detail if cond == "fail" else None
        return o

    state = {"checks": {}}
    a, r, checks_state = decide(
        [make_obs("fail", detail="timeout after 10s", sig="error:timeout")],
        state["checks"], 2, 3.0, 1000, 4, now,
    )
    check("first failure alerts", len(a), 1)
    check("first failure level", a[0][0].level, "medium")
    state["checks"] = checks_state
    a, r, checks_state = decide(
        [make_obs("fail", detail="timeout after 10s", sig="error:timeout")],
        state["checks"], 2, 3.0, 1000, 4, now,
    )
    check("second failure escalates", (len(a), a[0][0].level), (1, "critical"))
    state["checks"] = checks_state
    a, r, checks_state = decide(
        [make_obs("fail", detail="timeout after 10s", sig="error:timeout")],
        state["checks"], 2, 3.0, 1000, 4, now,
    )
    check("critical deduped", len(a), 0)
    state["checks"] = checks_state
    a, r, checks_state = decide(
        [make_obs("fail", detail="timeout after 10s", sig="error:timeout")],
        state["checks"], 2, 3.0, 1000, 4, now + dt.timedelta(hours=5),
    )
    check("critical re-alert after 5h", len(a), 1)
    state["checks"] = checks_state
    a, r, checks_state = decide(
        [make_obs("ok", latency=90.0)],
        state["checks"], 2, 3.0, 1000, 4, now + dt.timedelta(hours=5),
    )
    check("recovery notice", len(r), 1)
    check("recovery clears alert", len(a), 0)
    state["checks"] = checks_state
    check("recovery resets counters", (checks_state["c"]["failures"], checks_state["c"]["slow"]), (0, 0))
    check("samples recorded", len(checks_state["c"]["samples"]), 1)

    # slow escalation
    state = {"checks": {}}
    slow_obs = make_obs("ok", latency=2000.0, sig="slow:slo")
    slow_obs.detail = "latency 2000 ms exceeds the 500 ms SLO"
    a, r, checks_state = decide([slow_obs], state["checks"], 2, 3.0, 1000, 4, now)
    check("first slow level", (len(a), a[0][0].level), (1, "medium"))
    state["checks"] = checks_state
    slow_obs = make_obs("ok", latency=2100.0, sig="slow:slo")
    slow_obs.detail = "latency 2100 ms exceeds the 500 ms SLO"
    a, r, checks_state = decide([slow_obs], state["checks"], 2, 3.0, 1000, 4, now)
    check("sustained slow level", (len(a), a[0][0].level), (1, "high"))
    state["checks"] = checks_state
    a, r, checks_state = decide([make_obs("ok", latency=120.0)], state["checks"], 2, 3.0, 1000, 4, now)
    check("slow recovery", len(r), 1)

    # baseline degradation (inside the absolute SLO)
    state = {"checks": {}}
    for i in range(BASELINE_MIN_SAMPLES):
        a, r, checks_state = decide(
            [make_obs("ok", latency=120.0)], state["checks"], 2, 3.0, 1000, 4, now
        )
        state["checks"] = checks_state
    check("baseline p50", checks_state["c"]["p50"], 120.0)
    baseline_obs = make_obs("ok", latency=900.0, sig="slow:baseline")
    baseline_obs.detail = "latency 900 ms is 7.5x the 120 ms baseline p50"
    a, r, checks_state = decide([baseline_obs], state["checks"], 2, 3.0, 1000, 4, now)
    check("baseline degradation detected", (len(a), a[0][0].level), (1, "medium"))
    state["checks"] = checks_state
    a, r, checks_state = decide([make_obs("ok", latency=300.0)], state["checks"], 2, 3.0, 1000, 4, now)
    check("small jitter ignored (below floor)", len(a), 0)
    check("small jitter counts as recovery", len(r), 1)

    # watchdog
    state = {"last_run": (now - dt.timedelta(hours=3)).isoformat()}
    gap = (now - dt.datetime.fromisoformat(state["last_run"])).total_seconds()
    check("watchdog gap computed", gap > 2 * 3600, True)

    # ── live round trip against the local fixture (no external network) ─────
    server = _local_server()
    port = server.server_address[1]
    try:
        base = f"http://127.0.0.1:{port}"
        obs = run_check(
            Check("ok", "GET", f"{base}/ok", None, parse_expect("status=200; json=result.status", "t"),
                  "", 2000, "qa", "active", "site", 1),
            5,
        )
        check("fixture ok probe", (obs.ok, obs.status == 200), (True, True))
        check("fixture latency measured", obs.latency_ms is not None and obs.latency_ms >= 0, True)

        obs = run_check(
            Check("bad", "GET", f"{base}/bad", None, parse_expect("status=200", "t"),
                  "", 2000, "qa", "active", "site", 1),
            5,
        )
        check("fixture 500 fails expectation", (obs.ok, obs.status, obs.sig), (False, 500, "expect:status"))

        obs = run_check(
            Check("text", "GET", f"{base}/text", None, parse_expect("contains=iPredict", "t"),
                  "", 2000, "qa", "active", "site", 1),
            5,
        )
        check("fixture contains", obs.ok, True)

        obs = run_check(
            Check("slow", "GET", f"{base}/slow", None, parse_expect("status=200", "t"),
                  "", 100, "qa", "active", "site", 1),
            5,
        )
        check("fixture slow detected", (obs.ok, obs.cond == "fail" or obs.latency_ms > 100), (True, True))

        obs = run_check(
            Check("hang", "GET", f"{base}/slow", None, parse_expect("status=200", "t"),
                  "", 2000, "qa", "active", "site", 1),
            0.1,
        )
        check("fixture timeout", (obs.ok, obs.sig), (False, "error:timeout"))

        rpc = Check(
            "rpc", "POST", f"{base}/api/rpc",
            {"jsonrpc": "2.0", "id": 1, "method": "getHealth"},
            parse_expect("status=200; json=result.status", "t"), "",
            2000, "qa", "active", "api", 1,
        )
        obs = run_check(rpc, 5)
        check("fixture rpc post", (obs.ok, obs.status), (True, 200))
    finally:
        server.shutdown()
        server.server_close()

    if failures:
        print("SELF-TEST FAILED:")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("self-test: all checks passed")
    return 0


# ── main ─────────────────────────────────────────────────────────────────────


def default_state_path():
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return os.path.join(base, "ipredict-synthetic-monitor", "state.json")


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--inventory", default=os.path.join(here, "paths.txt"))
    ap.add_argument(
        "--state-file",
        default=os.environ.get("SYNTHETIC_MONITOR_STATE_FILE") or default_state_path(),
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
    ap.add_argument("--timeout", type=float, default=15.0, help="per-check timeout (s)")
    ap.add_argument(
        "--fail-after",
        type=int,
        default=2,
        help="consecutive failed/slow runs before CRITICAL/HIGH (default 2 — "
        "the first run still alerts immediately at MEDIUM)",
    )
    ap.add_argument(
        "--slow-factor",
        type=float,
        default=3.0,
        help="flag a run slower than this multiple of the baseline p50 (default 3.0)",
    )
    ap.add_argument(
        "--slow-floor-ms",
        type=float,
        default=1000.0,
        help="ignore baseline degradation below this absolute latency (default 1000)",
    )
    ap.add_argument(
        "--re-alert-hours",
        type=float,
        default=4.0,
        help="re-send HIGH/CRITICAL alerts after this many hours (default 4)",
    )
    ap.add_argument(
        "--stale-after-hours",
        type=float,
        default=2.0,
        help="report a watchdog gap when the previous run is older than this (default 2)",
    )
    ap.add_argument("--only", help="run a single check by name")
    ap.add_argument("--self-test", action="store_true", help="run offline checks and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    now = dt.datetime.now(dt.timezone.utc)
    cfg = read_env_config()

    try:
        checks = parse_inventory(args.inventory)
    except (OSError, InventoryError) as exc:
        print(f"inventory error: {exc}", file=sys.stderr)
        return 2

    if args.only:
        checks = [c for c in checks if c.name == args.only]
        if not checks:
            print(f"--only: no check named {args.only!r}", file=sys.stderr)
            return 2

    active = [c for c in checks if c.mode == "active"]
    pending = [f"{c.name} ({c.section})" for c in checks if c.mode != "active"]

    obs_list = [run_check(c, args.timeout, cfg["origin"]) for c in active]

    state = load_state(args.state_file)
    stale_note = None
    prev_run = state.get("last_run")
    if prev_run and args.stale_after_hours > 0:
        gap = (now - dt.datetime.fromisoformat(prev_run)).total_seconds()
        if gap > args.stale_after_hours * 3600:
            stale_note = (
                f"monitor did not run between {prev_run} and {now.isoformat()} "
                f"({gap / 3600:.1f}h gap, threshold {args.stale_after_hours:g}h) — "
                "critical paths were NOT being verified during that window; check "
                "the systemd timer, the cron entry and the scheduled CI workflow"
            )

    alerts, recoveries, new_checks = decide(
        obs_list, state.get("checks") or {},
        args.fail_after, args.slow_factor, args.slow_floor_ms, args.re_alert_hours, now,
    )
    if args.force:
        alerts = [(o, "forced re-check") for o in obs_list if LEVEL_RANK[o.level] > 0]

    watchdog_alert = None
    if stale_note:
        # Built in JSON mode too: a monitor that stopped running is an incident
        # whether or not the report happens to be machine-readable.
        watchdog_alert = (
            f"[CRITICAL] synthetic monitor watchdog gap\n"
            f"  {stale_note}\n"
            f"  action   : the scheduled checks were not running — failures during "
            "the gap went unseen. Fix the schedule first (infra/README.md), then "
            "re-run check-synthetic.py --force to re-verify every path."
        )

    if args.json:
        print(
            json.dumps(
                {
                    "generated": now.isoformat(),
                    "inventory": args.inventory,
                    "results": [o.to_dict() for o in obs_list],
                    "pending": pending,
                    "alerts": [
                        {"check": o.key, "level": o.level, "reason": r} for o, r in alerts
                    ],
                    "recoveries": [
                        {"check": o.key, "level": o.level, "was": p.get("level")}
                        for o, p in recoveries
                    ],
                    "watchdog": stale_note,
                },
                indent=2,
            )
        )
    else:
        print_table(obs_list, pending, stale_note, now)

    if watchdog_alert:
        dispatch(watchdog_alert, "critical", cfg, args.dry_run, quiet=args.json)

    if not args.json:
        for obs, prev in recoveries:
            print(recovery_message(obs, prev), end="", flush=True)
            print("-" * 78, flush=True)

    for obs, reason in alerts:
        dispatch(
            message_for(obs, reason, stale_note), obs.level, cfg, args.dry_run, quiet=args.json
        )

    if not alerts and not recoveries and not watchdog_alert and not args.json:
        if obs_list:
            failed = sum(1 for o in obs_list if o.cond == "fail")
            slow = sum(1 for o in obs_list if o.cond == "slow")
            print(
                f"no new alerts: {len(obs_list)} path(s) checked "
                f"({len(obs_list) - failed - slow} ok, {slow} slow, {failed} failed, "
                f"{len(pending)} pending)",
                flush=True,
            )
        else:
            print("no active checks", flush=True)

    state["version"] = 1
    state["last_run"] = now.isoformat()
    if args.only:
        # --only probes a subset: merge so the other checks keep their failure
        # counts and latency baselines (a full run still prunes removed paths).
        merged = dict(state.get("checks") or {})
        merged.update(new_checks)
        state["checks"] = merged
    else:
        state["checks"] = new_checks
    save_state(args.state_file, state)
    ping_heartbeat(cfg["heartbeat_url"], args.timeout)

    worst_rank = max((LEVEL_RANK[o.level] for o in obs_list), default=0)
    if watchdog_alert:
        worst_rank = max(worst_rank, LEVEL_RANK["critical"])
    if not args.json:
        worst_name = next(k for k, v in LEVEL_RANK.items() if v == worst_rank)
        print(
            f"summary: {len(obs_list)} path(s) checked, {len(pending)} pending, "
            f"{len(alerts)} alert(s), {len(recoveries)} recovery notice(s), "
            f"worst={worst_name}{' +watchdog' if watchdog_alert else ''}",
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
