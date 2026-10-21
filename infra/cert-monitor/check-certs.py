#!/usr/bin/env python3
"""iPredict TLS certificate expiry monitor.

Reads the endpoint inventory (endpoints.txt), checks the not-after date of
every certificate served by every listed endpoint (public HTTPS endpoints,
internal TLS services, and certificate files on disk), and escalates alerts
as expiry approaches:

    <= 30 days  MEDIUM   chat/webhook
    <= 14 days  HIGH     chat/webhook + email
    <=  7 days  CRITICAL chat/webhook + email, non-zero exit
    expired / check failed  CRITICAL

State is kept between runs so each threshold fires exactly once per
certificate (renewing the certificate resets the state and emits a
recovery notice, which is how silent renewal-automation failures become
visible).

Stdlib only. Operation: infra/README.md. Renewal: docs/DEPLOYMENT-GUIDE.md.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import glob
import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.request

DEFAULT_PORT = 443
LEVEL_RANK = {"ok": 0, "medium": 1, "high": 2, "critical": 3, "error": 3}
VALID_SCOPES = ("public", "internal")
VALID_MODES = ("active", "pending")
PEM_BLOCK = re.compile(
    r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", re.S
)


class InventoryError(Exception):
    pass


# ── inventory ────────────────────────────────────────────────────────────────


class Endpoint:
    def __init__(self, name, target, tls_source, renewal, owner, mode, scope, line):
        self.name = name
        self.target = target
        self.tls_source = tls_source
        self.renewal = renewal
        self.owner = owner
        self.mode = mode
        self.scope = scope
        self.line = line


def parse_inventory(path):
    endpoints = []
    scope = None
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                scope = line[1:-1].strip().lower()
                if scope not in VALID_SCOPES:
                    raise InventoryError(
                        f"{path}:{lineno}: unknown section [{scope}] "
                        f"(expected one of {', '.join(VALID_SCOPES)})"
                    )
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) != 6:
                raise InventoryError(
                    f"{path}:{lineno}: expected 6 '|'-separated fields "
                    f"(name | target | tls_source | renewal | owner | mode), got {len(parts)}"
                )
            if scope is None:
                raise InventoryError(
                    f"{path}:{lineno}: entry appears before a [public] or [internal] section"
                )
            name, target, tls_source, renewal, owner, mode = parts
            mode = mode.lower()
            if mode not in VALID_MODES:
                raise InventoryError(
                    f"{path}:{lineno}: mode must be one of "
                    f"{', '.join(VALID_MODES)} (got {mode!r})"
                )
            if not target:
                raise InventoryError(f"{path}:{lineno}: empty target")
            endpoints.append(
                Endpoint(name, target, tls_source, renewal, owner, mode, scope, lineno)
            )
    if not endpoints:
        raise InventoryError(f"{path}: no endpoints listed")
    names = [e.name for e in endpoints]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise InventoryError(f"{path}: duplicate endpoint name(s): {', '.join(dupes)}")
    return endpoints


# ── certificate parsing (pure stdlib, works for public and internal certs) ───


def _tlv(buf, i):
    if i + 2 > len(buf):
        raise ValueError("truncated DER")
    tag = buf[i]
    i += 1
    first = buf[i]
    i += 1
    if first & 0x80:
        n = first & 0x7F
        if n == 0 or i + n > len(buf):
            raise ValueError("bad DER length")
        length = int.from_bytes(buf[i : i + n], "big")
        i += n
    else:
        length = first
    end = i + length
    if end > len(buf):
        raise ValueError("truncated DER value")
    return tag, buf[i:end], end


def _children(buf):
    out = []
    i = 0
    while i < len(buf):
        tag, val, i = _tlv(buf, i)
        out.append((tag, val))
    return out


def _asn1_time(tag, val):
    text = val.decode("ascii", errors="replace").strip()
    if tag == 0x17:  # UTCTime
        return dt.datetime.strptime(text, "%y%m%d%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    if tag == 0x18:  # GeneralizedTime
        return dt.datetime.strptime(text, "%Y%m%d%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    raise ValueError(f"unsupported ASN.1 time tag {tag:#x}")


def parse_cert_der(der):
    """Return (not_before, not_after, issuer_cn, sha256_fingerprint) for a DER cert."""
    tag, cert, _ = _tlv(der, 0)
    if tag != 0x30:
        raise ValueError("not a certificate (missing outer SEQUENCE)")
    tbs_tag, tbs, _ = _tlv(cert, 0)
    if tbs_tag != 0x30:
        raise ValueError("not a certificate (missing tbsCertificate)")
    fields = _children(tbs)
    idx = 1 if fields and fields[0][0] == 0xA0 else 0  # optional version [0]
    if len(fields) < idx + 4:
        raise ValueError("certificate is missing required fields")
    issuer_tag, issuer_buf = fields[idx + 2]
    valid_tag, valid_buf = fields[idx + 3]
    if valid_tag != 0x30:
        raise ValueError("certificate validity field is malformed")
    times = _children(valid_buf)
    if len(times) < 2:
        raise ValueError("certificate validity window is missing notBefore/notAfter")
    not_before = _asn1_time(*times[0])
    not_after = _asn1_time(*times[1])
    issuer_cn = _extract_cn(issuer_buf) if issuer_tag == 0x30 else None
    fingerprint = hashlib.sha256(der).hexdigest()
    return not_before, not_after, issuer_cn, fingerprint


def _extract_cn(name_buf):
    """Best-effort commonName from an X.501 Name (SEQUENCE OF RDN)."""
    try:
        i = 0
        while i < len(name_buf):
            rdn_tag, rdn, i = _tlv(name_buf, i)
            if rdn_tag != 0x31:
                continue
            j = 0
            while j < len(rdn):
                atv_tag, atv, j = _tlv(rdn, j)
                if atv_tag != 0x30:
                    continue
                oid = None
                value = None
                for t, v in _children(atv):
                    if t == 0x06:
                        oid = v
                    elif t in (0x13, 0x14, 0x0C, 0x16, 0x1E):
                        value = v.decode("utf-8", errors="replace")
                if oid == b"\x55\x04\x03" and value:
                    return value
        return None
    except Exception:
        return None


def pem_to_der(pem_text):
    blocks = PEM_BLOCK.findall(pem_text)
    if not blocks:
        raise ValueError("no PEM certificate block found")
    body = "".join(blocks[0].split())
    return base64.b64decode(body)


def read_cert_file(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    if b"-----BEGIN CERTIFICATE-----" in raw:
        return pem_to_der(raw.decode("utf-8", errors="replace"))
    return raw  # already DER


# ── endpoint checks ──────────────────────────────────────────────────────────


class Obs:
    def __init__(self, ep, key, target_display):
        self.ep = ep
        self.key = key
        self.target = target_display
        self.not_before = None
        self.not_after = None
        self.issuer = None
        self.fingerprint = None
        self.days = None
        self.level = "error"
        self.status = "ERROR"
        self.error = None
        self.verify = "skipped"

    def to_dict(self):
        return {
            "endpoint": self.ep.name,
            "key": self.key,
            "scope": self.ep.scope,
            "target": self.target,
            "tls_source": self.ep.tls_source,
            "renewal": self.ep.renewal,
            "owner": self.ep.owner,
            "mode": self.ep.mode,
            "expires": self.not_after.isoformat() if self.not_after else None,
            "days_left": self.days,
            "level": self.level,
            "status": self.status,
            "issuer": self.issuer,
            "fingerprint": self.fingerprint,
            "verify": self.verify,
            "error": self.error,
        }


def split_hostport(target, default_port=DEFAULT_PORT):
    if target.startswith("["):  # [::1]:8443
        host, _, rest = target[1:].partition("]")
        port = int(rest[1:]) if rest.startswith(":") else default_port
        return host, port
    if ":" in target:
        host, _, port = target.rpartition(":")
        if port.isdigit():
            return host, int(port)
    return target, default_port


def fetch_der(host, port, timeout, server_hostname=None):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=server_hostname or host) as tls:
            der = tls.getpeercert(binary_form=True)
    if not der:
        raise ValueError("peer sent no certificate")
    return der


def verify_host(host, port, timeout, ca_file):
    ctx = ssl.create_default_context(cafile=ca_file)
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                tls.getpeercert()
        return "ok"
    except ssl.SSLCertVerificationError as exc:
        return f"failed: {getattr(exc, 'verify_message', None) or exc}"
    except Exception as exc:  # noqa: BLE001 - surfaced in the report
        return f"failed: {exc}"


def classify(days):
    if days is None:
        return "error"
    if days <= 7:
        return "critical"
    if days <= 14:
        return "high"
    if days <= 30:
        return "medium"
    return "ok"


def status_label(days, level):
    if days is None:
        return "ERROR"
    if days < 0:
        return "EXPIRED"
    if days == 0:
        return "EXPIRES TODAY"
    if level == "critical":
        return f"{days}d  <=7d"
    if level == "high":
        return f"{days}d  <=14d"
    if level == "medium":
        return f"{days}d  <=30d"
    return f"{days}d  ok"


def check_endpoint(ep, timeout, ca_file, now):
    obs_list = []
    if ep.target.startswith("file:"):
        pattern = ep.target[len("file:") :].strip()
        paths = sorted(glob.glob(pattern))
        if not paths:
            obs = Obs(ep, ep.name, ep.target)
            obs.error = f"no certificate files match {pattern}"
            obs_list.append(obs)
            return obs_list
        for path in paths:
            obs = Obs(ep, f"{ep.name}#{os.path.basename(path)}", path)
            try:
                der = read_cert_file(path)
                not_before, not_after, issuer, fp = parse_cert_der(der)
            except Exception as exc:  # noqa: BLE001
                obs.error = f"{path}: {exc}"
                obs_list.append(obs)
                continue
            _apply_dates(obs, not_before, not_after, issuer, fp, now)
            obs.verify = "n/a (file)"
            obs_list.append(obs)
        return obs_list

    host, port = split_hostport(ep.target)
    display = f"{host}:{port}"
    obs = Obs(ep, ep.name, display)
    try:
        der = fetch_der(host, port, timeout)
        not_before, not_after, issuer, fp = parse_cert_der(der)
    except Exception as exc:  # noqa: BLE001
        obs.error = f"{display}: {exc}"
        obs_list.append(obs)
        return obs_list
    _apply_dates(obs, not_before, not_after, issuer, fp, now)

    if ep.scope == "public":
        obs.verify = verify_host(host, port, timeout, None)
    elif ca_file:
        obs.verify = verify_host(host, port, timeout, ca_file)
    else:
        obs.verify = "skipped (internal, no CERT_MONITOR_CA_FILE)"
    obs_list.append(obs)
    return obs_list


def _apply_dates(obs, not_before, not_after, issuer, fp, now):
    obs.not_before = not_before
    obs.not_after = not_after
    obs.issuer = issuer
    obs.fingerprint = fp
    obs.days = (not_after - now).days
    if not_before and not_before > now:
        obs.level = "error"
        obs.status = "NOT YET VALID"
        obs.error = f"certificate is not valid until {not_before:%Y-%m-%d %H:%M UTC}"
        return
    obs.level = classify(obs.days)
    obs.status = status_label(obs.days, obs.level)


# ── state / alerting ─────────────────────────────────────────────────────────


LEVEL_PREFIX = {"medium": "MEDIUM", "high": "HIGH", "critical": "CRITICAL", "error": "CRITICAL"}

LEVEL_ACTION = {
    "medium": (
        "30-day checkpoint: renewal should be fully automated by now. Confirm the "
        "renewal job is armed and this monitor is running; no manual renewal yet."
    ),
    "high": (
        "14-day checkpoint: verify the renewal automation has succeeded or will run "
        "before expiry. If it has not fired, start the manual procedure in "
        "docs/DEPLOYMENT-GUIDE.md (Certificate Renewal Procedure)."
    ),
    "critical": (
        "7-day / expired: renew NOW by hand following the Certificate Renewal "
        "Procedure in docs/DEPLOYMENT-GUIDE.md, reload the affected service, then "
        "re-run check-certs.py --force to confirm recovery. Page the platform "
        "on-call — an expired certificate takes the platform offline."
    ),
    "error": (
        "The certificate could not be checked (connection, DNS or file error). "
        "Treat as an outage risk: investigate immediately — an unreachable endpoint "
        "hides its real expiry date."
    ),
}


def load_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("eps"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "last_run": None, "eps": {}}


def save_state(path, state):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def decide_alerts(obs_list, state, re_alert_hours, now):
    """Return (alerts, renewals, new_state_eps)."""
    alerts = []
    renewals = []
    eps = dict(state.get("eps", {}))
    for obs in obs_list:
        prev = eps.get(obs.key)
        cur = {
            "level": obs.level,
            "fingerprint": obs.fingerprint,
            "not_after": obs.not_after.isoformat() if obs.not_after else None,
            "error": obs.error,
            "last_alert": prev.get("last_alert") if prev else None,
            "scope": obs.ep.scope,
        }
        rank = LEVEL_RANK[obs.level]
        reason = None
        if prev is None:
            if rank > 0:
                reason = "first observation"
        else:
            changed_cert = (
                obs.fingerprint is not None
                and prev.get("fingerprint") not in (None, obs.fingerprint)
            )
            prev_rank = LEVEL_RANK.get(prev.get("level", "ok"), 0)
            if changed_cert:
                cur["last_alert"] = None
                if rank < prev_rank and prev_rank > 0:
                    renewals.append((obs, "certificate renewed"))
                elif rank > 0:
                    reason = "replacement certificate is already near expiry"
            elif obs.error != prev.get("error"):
                if rank > 0:
                    reason = "check status changed"
            elif rank > prev_rank:
                reason = "escalated since last run"
            elif rank < prev_rank:
                if prev_rank > 0:
                    renewals.append((obs, "condition cleared"))
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
        eps[obs.key] = cur
    return alerts, renewals, eps


def message_for(obs, reason, stale_note=None):
    head = LEVEL_PREFIX.get(obs.level, "CRITICAL")
    if obs.level == "error":
        title = f"[{head}] certificate check FAILED for '{obs.ep.name}'"
    elif obs.days is not None and obs.days < 0:
        title = f"[{head}] TLS certificate '{obs.ep.name}' EXPIRED"
    else:
        title = f"[{head}] TLS certificate '{obs.ep.name}' expires in {obs.days} day(s)"
    expiry = f"{obs.not_after:%Y-%m-%d %H:%M UTC}" if obs.not_after else "unknown (check failed)"
    lines = [
        title,
        f"  reason   : {reason}",
        f"  endpoint : {obs.ep.name} ({obs.ep.scope}) -> {obs.target}",
        f"  expires  : {expiry}   status: {obs.status}",
        f"  issuer   : {obs.issuer or 'unknown'}",
        f"  renewal  : {obs.ep.renewal} ({obs.ep.tls_source})   owner: {obs.ep.owner}",
        f"  verify   : {obs.verify}",
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
                "email: no sendmail/mail binary found — configure one or drop CERT_MONITOR_EMAIL_TO",
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
        "webhook_url": os.environ.get("CERT_MONITOR_WEBHOOK_URL", "").strip(),
        "webhook_format": os.environ.get("CERT_MONITOR_WEBHOOK_FORMAT", "slack").strip(),
        "email_to": os.environ.get("CERT_MONITOR_EMAIL_TO", "").strip(),
        "ca_file": os.environ.get("CERT_MONITOR_CA_FILE", "").strip() or None,
        "heartbeat_url": os.environ.get("CERT_MONITOR_HEARTBEAT_URL", "").strip(),
    }


# ── report ───────────────────────────────────────────────────────────────────


def print_table(obs_list, pending, stale_note, now):
    print(f"iPredict certificate expiry check — {now:%Y-%m-%d %H:%M UTC}", flush=True)
    print(
        f"{'ENDPOINT':<24}{'SCOPE':<10}{'TARGET':<40}{'EXPIRES (UTC)':<21}"
        f"{'STATUS':<18}{'VERIFY'}",
        flush=True,
    )
    print("-" * 118, flush=True)
    for obs in obs_list:
        expiry = f"{obs.not_after:%Y-%m-%d %H:%M}" if obs.not_after else "-"
        verify = obs.verify if len(obs.verify) <= 40 else obs.verify[:37] + "..."
        print(
            f"{obs.ep.name:<24}{obs.ep.scope:<10}{obs.target:<40}{expiry:<21}"
            f"{obs.status:<18}{verify}",
            flush=True,
        )
    if pending:
        print(f"\npending configuration (not yet checked): {', '.join(pending)}", flush=True)
    if stale_note:
        print(f"\nWATCHDOG: {stale_note}", flush=True)
    print("", flush=True)


# ── self test ────────────────────────────────────────────────────────────────


def _serve_tls(cert_path, key_path):
    """Serve TLS handshakes on an ephemeral localhost port (self-test only).

    Returns (port, shutdown) — the server answers repeatedly until shutdown().
    """
    import threading
    import time

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path, key_path)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    listener.settimeout(0.3)
    port = listener.getsockname()[1]
    stop = threading.Event()
    ready = threading.Event()

    def run():
        ready.set()
        try:
            while not stop.is_set():
                try:
                    conn, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    with ctx.wrap_socket(conn, server_side=True) as tls:
                        tls.settimeout(3)
                        tls.recv(1)
                except Exception:  # noqa: BLE001 - client may close first
                    pass
                finally:
                    try:
                        conn.close()
                    except OSError:
                        pass
        finally:
            listener.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ready.wait(5)

    def shutdown():
        stop.set()
        deadline = time.time() + 5
        while time.time() < deadline and thread.is_alive():
            thread.join(0.2)

    return port, shutdown


def _openssl_fixture_tests(check, failures):
    """Real-certificate round trip: file target + internal/public handshakes."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        key = os.path.join(tmp, "k.pem")
        crt = os.path.join(tmp, "c.pem")
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", key, "-out", crt, "-days", "20",
                "-subj", "/CN=selftest.internal",
                "-addext", "basicConstraints=critical,CA:TRUE",
            ],
            check=True,
            capture_output=True,
        )
        der = read_cert_file(crt)
        not_before, not_after, issuer, fp = parse_cert_der(der)
        now = dt.datetime.now(dt.timezone.utc)
        check("openssl cert remaining days", (not_after - now).days in (19, 20), True)
        check("openssl cert classify", classify((not_after - now).days), "medium")
        check("openssl cert issuer", issuer, "selftest.internal")
        check("openssl cert fingerprint len", len(fp), 64)
        obs = Obs(
            Endpoint("t", f"file:{crt}", "ca", "manual", "qa", "active", "internal", 1),
            "t",
            crt,
        )
        _apply_dates(obs, not_before, not_after, issuer, fp, now)
        check("file obs level", obs.level, "medium")

        # End-to-end: a TLS service that only exists on the internal network
        # (self-signed, no public CA) must still have its expiry measured, with
        # chain verification skipped for internal scope and failing for public.
        for scope, expect_verify in (("internal", "skipped"), ("public", "failed")):
            port, shutdown = _serve_tls(crt, key)
            try:
                ep = Endpoint(
                    "internal-svc", f"127.0.0.1:{port}", "private-ca",
                    "manual", "qa", "active", scope, 2,
                )
                got = check_endpoint(ep, 5, None, now)
                check(f"{scope} handshake results", len(got), 1)
                o = got[0]
                check(f"{scope} handshake error", o.error, None)
                check(f"{scope} handshake days in (19,20)", o.days in (19, 20), True)
                check(f"{scope} handshake level", o.level, "medium")
                check(f"{scope} handshake verify", o.verify.startswith(expect_verify), True)
                check(f"{scope} handshake fingerprint", len(o.fingerprint or ""), 64)
            finally:
                shutdown()


def self_test():
    import tempfile

    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    check("classify(45)", classify(45), "ok")
    check("classify(31)", classify(31), "ok")
    check("classify(30)", classify(30), "medium")
    check("classify(15)", classify(15), "medium")
    check("classify(14)", classify(14), "high")
    check("classify(8)", classify(8), "high")
    check("classify(7)", classify(7), "critical")
    check("classify(1)", classify(1), "critical")
    check("classify(0)", classify(0), "critical")
    check("classify(-1)", classify(-1), "critical")
    check("classify(None)", classify(None), "error")
    check("label(-1)", status_label(-1, "critical"), "EXPIRED")

    if shutil.which("openssl"):
        try:
            _openssl_fixture_tests(check, failures)
        except Exception as exc:  # noqa: BLE001 - fixture problems become failures
            failures.append(f"openssl fixture failed: {exc}")
    else:
        print("note: openssl not found, skipping certificate round-trip test")

    ep = Endpoint(
        "api", "api.example:443", "letsencrypt", "automatic", "platform", "active", "public", 1
    )

    def make(days, fp="a" * 64, error=None):
        o = Obs(ep, "api", "api.example:443")
        o.days = days
        o.fingerprint = fp
        o.error = error
        o.level = classify(days) if days is not None else "error"
        o.status = status_label(o.days, o.level)
        o.not_after = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        return o

    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    state = {"eps": {}}
    a1, r1, eps = decide_alerts([make(45)], state, 24, now)
    check("no alert at 45d", (len(a1), len(r1)), (0, 0))
    state = {"eps": eps}
    a2, _, eps = decide_alerts([make(30)], state, 24, now)
    check("alert at 30d", len(a2), 1)
    state = {"eps": eps}
    a3, _, eps = decide_alerts([make(30)], state, 24, now)
    check("deduped at 30d", len(a3), 0)
    state = {"eps": eps}
    a4, _, eps = decide_alerts([make(14)], state, 24, now)
    check("alert at 14d", len(a4), 1)
    state = {"eps": eps}
    a5, _, eps = decide_alerts([make(7)], state, 24, now)
    check("alert at 7d", len(a5), 1)
    state = {"eps": eps}
    a6, _, eps = decide_alerts([make(7)], state, 24, now)
    check("deduped at 7d", len(a6), 0)
    state = {"eps": eps}
    a7, _, eps = decide_alerts([make(7)], state, 24, now + dt.timedelta(hours=25))
    check("critical re-alert after 25h", len(a7), 1)
    state = {"eps": eps}
    a8, r8, eps = decide_alerts([make(60, fp="b" * 64)], state, 24, now)
    check("renewal notice", (len(a8), len(r8)), (0, 1))
    state = {"eps": eps}
    a9, _, eps = decide_alerts([make(None, error="timeout")], state, 24, now)
    check("check failure alerts", len(a9), 1)
    state = {"eps": eps}
    a10, _, eps = decide_alerts([make(None, error="timeout")], state, 24, now)
    check("check failure deduped", len(a10), 0)

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
    return os.path.join(base, "ipredict-cert-monitor", "state.json")


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--inventory", default=os.path.join(here, "endpoints.txt"))
    ap.add_argument(
        "--state-file",
        default=os.environ.get("CERT_MONITOR_STATE_FILE") or default_state_path(),
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
    ap.add_argument("--timeout", type=float, default=10.0, help="per-endpoint timeout (s)")
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
    ap.add_argument("--only", help="check a single endpoint by name")
    ap.add_argument("--self-test", action="store_true", help="run offline checks and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    now = dt.datetime.now(dt.timezone.utc)
    cfg = read_env_config()

    try:
        endpoints = parse_inventory(args.inventory)
    except (OSError, InventoryError) as exc:
        print(f"inventory error: {exc}", file=sys.stderr)
        return 2

    if args.only:
        endpoints = [e for e in endpoints if e.name == args.only]
        if not endpoints:
            print(f"--only: no endpoint named {args.only!r}", file=sys.stderr)
            return 2

    active = [e for e in endpoints if e.mode == "active"]
    pending = [f"{e.name} ({e.scope})" for e in endpoints if e.mode != "active"]

    obs_list = []
    for ep in active:
        obs_list.extend(check_endpoint(ep, args.timeout, cfg["ca_file"], now))

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

    alerts, renewals, new_eps = decide_alerts(obs_list, state, args.re_alert_hours, now)
    if args.force:
        # Re-send every endpoint that is currently in an alert state; renewal
        # notices are still reported because they describe what was just seen.
        alerts = [(o, "forced re-check") for o in obs_list if LEVEL_RANK[o.level] > 0]

    # A monitoring gap is itself an incident: alerts that should have fired may
    # never have been sent. Report it loudly and fail the run.
    watchdog_alert = None
    if stale_note and not args.json:
        watchdog_alert = (
            f"[CRITICAL] certificate monitor watchdog gap\n"
            f"  {stale_note}\n"
            f"  action   : every endpoint's expiry was unwatched during that window. "
            f"Fix the schedule first (infra/README.md), then re-run "
            f"check-certs.py --force to re-verify every certificate."
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
                        {"endpoint": o.key, "level": o.level, "reason": r} for o, r in alerts
                    ],
                    "renewals": [{"endpoint": o.key, "note": n} for o, n in renewals],
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
        for obs, reason in renewals:
            head = "RENEWED" if reason == "certificate renewed" else "RECOVERED"
            print(
                f"[{head}] certificate '{obs.ep.name}' — {reason}\n"
                f"  endpoint : {obs.ep.name} ({obs.ep.scope}) -> {obs.target}\n"
                f"  expires  : {obs.not_after:%Y-%m-%d %H:%M UTC}   status: {obs.status}\n"
                f"  fingerprint: {(obs.fingerprint or '')[:16]}\n",
                flush=True,
            )
            print("-" * 78, flush=True)

    for obs, reason in alerts:
        dispatch(
            message_for(obs, reason, stale_note), obs.level, cfg, args.dry_run, quiet=args.json
        )

    if not alerts and not renewals and not watchdog_alert and not args.json:
        if obs_list:
            worst = max(obs_list, key=lambda o: LEVEL_RANK[o.level])
            if worst.level == "ok":
                print(
                    f"no alerts: {len(obs_list)} certificate(s) checked, all >30 days from expiry",
                    flush=True,
                )
            else:
                print(
                    f"no new alerts: {len(obs_list)} certificate(s) checked "
                    f"(existing {worst.level.upper()} state unchanged)",
                    flush=True,
                )
        else:
            print("no active endpoints checked", flush=True)

    state["version"] = 1
    state["last_run"] = now.isoformat()
    state["eps"] = new_eps
    save_state(args.state_file, state)
    ping_heartbeat(cfg["heartbeat_url"], args.timeout)

    worst_rank = max((LEVEL_RANK[o.level] for o in obs_list), default=0)
    if watchdog_alert:
        worst_rank = max(worst_rank, LEVEL_RANK["critical"])
    if not args.json:
        worst_name = next(k for k, v in LEVEL_RANK.items() if v == worst_rank)
        print(
            f"summary: {len(obs_list)} certificate(s) checked, {len(pending)} pending, "
            f"{len(alerts)} alert(s), {len(renewals)} renewal notice(s), "
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
