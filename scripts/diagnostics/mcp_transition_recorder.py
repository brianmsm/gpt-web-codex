#!/usr/bin/env python3
"""Finite autonomous recorder for MCP/VPN transition diagnostics.

This file is deliberately isolated from the production runtime. It performs
read-only observations only and exits on its own after --duration seconds.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

DEFAULT_HEALTH_URL_FILE = Path(
    "/home/brian/.local/state/tunnel-client/health/codex-chatgpt-web.url"
)
DEFAULT_TUNNEL_LOG = Path(
    "/home/brian/.local/state/tunnel-client/logs/codex-chatgpt-web.log"
)
TARGET_INTERFACES = ("wlp99s0", "proton0", "pvpnksintrf0")
MIN_KILL_SWITCH_WINDOW_MS = 2_000
MIN_KILL_SWITCH_UNREACHABLE_SAMPLES = 2
SENSITIVE_RE = re.compile(
    r"(?i)(authorization|api[_-]?key|token|secret|password|credential)"
)
AUTHORIZATION_RE = re.compile(
    r"(?im)\b(authorization)([\t ]*[=:][\t ]*)[^\r\n]*"
)
BEARER_RE = re.compile(r"(?i)\b(Bearer)\s+[^\s,;]+")
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(api[_ -]?key|token|secret|password|credential)"
    r"([\s]*[=:][\s]*)([^\s,;]+)"
)
SENSITIVE_QUERY_RE = re.compile(
    r"(?i)([?&](?:authorization|api[_-]?key|token|secret|password|credential)=)"
    r"([^&#\s]+)"
)

ROLES = (
    "tunnel_client",
    "gwc_mcp",
    "herdr_server",
    "launcher_appimage",
    "launcher_main",
)

TUNNEL_EXECUTABLE_NAME = "tunnel-client"
GWC_ENTRYPOINT_NAME = "cli.js"
EXPECTED_PROFILE = "codex-chatgpt-web"
LAUNCHER_APPIMAGE_NAME = "GPT-Web-Codex.AppImage"

TUNNEL_EVENT_KEYS = {
    "time",
    "level",
    "msg",
    "component",
    "request_id",
    "cmd_request_id",
    "rpc_request_id",
    "client_instance_id",
    "tunnel_id",
    "status",
    "error",
    "attempt",
    "backoff",
    "retry_after",
    "runtime",
    "first_failing_dependency",
}


def now_epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def now_human() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def json_line(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n"


def safe_subprocess_env() -> dict[str, str]:
    env = {
        "PATH": os.environ.get(
            "PATH", "/usr/local/sbin:/usr/local/bin:/usr/bin"
        ),
        "LANG": "C",
        "LC_ALL": "C",
        "HOME": os.environ.get("HOME", str(Path.home())),
    }
    for key in ("XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


def run_local(args: list[str], timeout: float = 0.15) -> dict[str, Any]:
    started = time.monotonic()
    try:
        cp = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            env=safe_subprocess_env(),
        )
        return {
            "ok": cp.returncode == 0,
            "returncode": cp.returncode,
            "stdout": cp.stdout.strip(),
            "stderr": cp.stderr.strip(),
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            "timeout": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "returncode": None,
            "stdout": (exc.stdout or "").strip() if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "").strip() if isinstance(exc.stderr, str) else "",
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            "timeout": True,
        }
    except Exception as exc:
        return {
            "ok": False,
            "returncode": None,
            "stdout": "",
            "stderr": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            "timeout": False,
        }


def sanitize_text(value: str) -> str:
    value = AUTHORIZATION_RE.sub(r"\1\2<redacted>", value)
    value = BEARER_RE.sub(r"\1 <redacted>", value)
    value = SENSITIVE_ASSIGNMENT_RE.sub(r"\1\2<redacted>", value)
    value = SENSITIVE_QUERY_RE.sub(r"\1<redacted>", value)
    return value


def sanitize_value(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: (
                "<redacted>"
                if SENSITIVE_RE.search(str(key))
                else sanitize_value(item)
            )
            for key, item in value.items()
        }
    return value


def sanitize_cmdline(parts: Iterable[str]) -> list[str]:
    out: list[str] = []
    redact_next = False
    for arg in parts:
        if redact_next:
            out.append("<redacted>")
            redact_next = False
            continue

        if "=" in arg:
            key, _value = arg.split("=", 1)
            if SENSITIVE_RE.search(key):
                out.append(f"{key}=<redacted>")
                continue

        if arg.startswith("--") and SENSITIVE_RE.search(arg):
            out.append(arg)
            redact_next = "=" not in arg
            continue

        out.append(sanitize_text(arg))
    return out


def proc_identity(pid: int) -> dict[str, Any] | None:
    proc = Path("/proc") / str(pid)
    try:
        stat = (proc / "stat").read_text()
        close = stat.rfind(")")
        fields = stat[close + 2 :].split()
        ppid = int(fields[1])
        starttime = int(fields[19])
        raw = (proc / "cmdline").read_bytes().split(b"\0")
        parts = [p.decode("utf-8", "replace") for p in raw if p]
        if not parts:
            parts = [f"[{(proc / 'comm').read_text(errors='replace').strip()}]"]
        return {
            "pid": pid,
            "ppid": ppid,
            "starttime": starttime,
            "cmdline": sanitize_cmdline(parts),
        }
    except (
        FileNotFoundError,
        ProcessLookupError,
        PermissionError,
        ValueError,
        IndexError,
    ):
        return None


def matches_role(
    role: str, ident: dict[str, Any], expected_profile: str = EXPECTED_PROFILE
) -> bool:
    parts = ident["cmdline"]
    if not parts:
        return False

    if role == "tunnel_client":
        return (
            Path(parts[0]).name == TUNNEL_EXECUTABLE_NAME
            and len(parts) >= 2
            and parts[1] == "run"
            and "--profile" in parts
            and expected_profile in parts
        )

    if role == "gwc_mcp":
        return (
            len(parts) >= 3
            and Path(parts[1]).name == GWC_ENTRYPOINT_NAME
            and Path(parts[1]).parent.name == "app"
            and parts[2] == "mcp"
            and "--state-path" in parts
        )

    if role == "herdr_server":
        return (
            len(parts) >= 2
            and Path(parts[0]).name == "herdr"
            and parts[1] == "server"
        )

    if role == "launcher_appimage":
        return Path(parts[0]).name == LAUNCHER_APPIMAGE_NAME

    if role == "launcher_main":
        return Path(parts[0]).name == "gpt-web-codex-launcher"

    return False


def process_roles(
    expected_profile: str = EXPECTED_PROFILE,
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {role: [] for role in ROLES}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        ident = proc_identity(int(entry.name))
        if not ident:
            continue
        for role in ROLES:
            if matches_role(role, ident, expected_profile):
                result[role].append(ident)
    for identities in result.values():
        identities.sort(key=lambda item: (item["pid"], item["starttime"]))
    return result


def watched_processes(
    patterns: list[str],
    exclude_pids: set[int] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {pattern: [] for pattern in patterns}
    if not patterns:
        return result
    excluded = exclude_pids or set()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in excluded:
            continue
        ident = proc_identity(pid)
        if not ident:
            continue
        cmdline = " ".join(ident["cmdline"])
        for pattern in patterns:
            if pattern in cmdline:
                result[pattern].append(ident)
    for identities in result.values():
        identities.sort(key=lambda item: (item["pid"], item["starttime"]))
    return result


def add_lstart(
    identities: dict[str, list[dict[str, Any]]]
) -> dict[str, list[dict[str, Any]]]:
    enriched = json.loads(json.dumps(identities))
    for items in enriched.values():
        for item in items:
            ps = run_local(
                ["ps", "-p", str(item["pid"]), "-o", "lstart="], timeout=0.2
            )
            item["lstart"] = ps["stdout"] if ps["ok"] else None
    return enriched


def identity_signature(
    items: list[dict[str, Any]],
) -> tuple[tuple[int, int], ...]:
    return tuple((x["pid"], x["starttime"]) for x in items)


def parent_signature(
    items: list[dict[str, Any]],
) -> tuple[tuple[int, int, int], ...]:
    return tuple(
        (x["pid"], x["starttime"], x["ppid"]) for x in items
    )


def process_ancestry(pid: int, max_depth: int = 16) -> list[dict[str, Any]]:
    chain: list[dict[str, Any]] = []
    seen: set[int] = set()
    current = pid
    for _ in range(max_depth):
        if current <= 0 or current in seen:
            break
        seen.add(current)
        ident = proc_identity(current)
        if ident is None:
            break
        chain.append(ident)
        if ident["ppid"] in (0, current):
            break
        current = ident["ppid"]
    return chain


def process_topology(
    roles: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    gwc = {
        str(item["pid"]): process_ancestry(item["pid"])
        for item in roles.get("gwc_mcp", [])
    }
    tunnel = {
        str(item["pid"]): process_ancestry(item["pid"])
        for item in roles.get("tunnel_client", [])
    }
    return {
        "gwc_ancestry": gwc,
        "tunnel_ancestry": tunnel,
    }


def assess_recorder_independence(
    chain: list[dict[str, Any]],
    expected_profile: str = EXPECTED_PROFILE,
) -> dict[str, Any]:
    runtime_ancestors = [
        ident
        for ident in chain[1:]
        if matches_role("gwc_mcp", ident, expected_profile)
        or matches_role("tunnel_client", ident, expected_profile)
    ]
    return {
        "recorder": chain[0] if chain else None,
        "ancestry": chain,
        "independent_of_gwc_and_tunnel": not runtime_ancestors,
        "runtime_ancestors": runtime_ancestors,
    }


def recorder_independence(
    expected_profile: str = EXPECTED_PROFILE,
) -> dict[str, Any]:
    return assess_recorder_independence(
        process_ancestry(os.getpid()), expected_profile
    )


def validate_target_preconditions(
    roles: dict[str, list[dict[str, Any]]],
    ancestry_lookup: Any = None,
) -> dict[str, Any]:
    if ancestry_lookup is None:
        ancestry_lookup = process_ancestry
    errors: list[str] = []
    required = ("tunnel_client", "gwc_mcp", "herdr_server")
    counts = {role: len(roles.get(role, [])) for role in required}

    for role in required:
        count = counts[role]
        if count != 1:
            errors.append(
                f"expected exactly one {role}, observed {count}"
            )

    topology: dict[str, Any] | None = None
    gwc_owned_by_tunnel: bool | None = None
    direct_child: bool | None = None

    if counts["tunnel_client"] == 1 and counts["gwc_mcp"] == 1:
        tunnel = roles["tunnel_client"][0]
        gwc = roles["gwc_mcp"][0]
        ancestry = ancestry_lookup(gwc["pid"])
        topology = {
            "gwc_ancestry": ancestry,
            "tunnel_identity": tunnel,
        }
        gwc_owned_by_tunnel = any(
            item["pid"] == tunnel["pid"]
            and item["starttime"] == tunnel["starttime"]
            for item in ancestry[1:]
        )
        direct_child = gwc["ppid"] == tunnel["pid"]
        if not gwc_owned_by_tunnel:
            errors.append(
                "GWC MCP ancestry does not contain the unique tunnel-client"
            )

    return {
        "valid": not errors,
        "errors": errors,
        "counts": counts,
        "gwc_owned_by_tunnel": gwc_owned_by_tunnel,
        "gwc_direct_child_of_tunnel": direct_child,
        "topology": topology,
    }


def evaluate_transition_evidence(
    *,
    initial_proton_present: bool | None,
    final_proton_present: bool | None,
    proton_first_seen_epoch_ms: int | None,
    initial_kill_switch_present: bool | None,
    final_kill_switch_present: bool | None,
    kill_switch_first_seen_epoch_ms: int | None,
    kill_switch_first_absent_after_seen_epoch_ms: int | None,
    kill_switch_unreachable_sample_count: int,
    final_reachable: bool | None,
    outage_episodes: list[dict[str, Any]],
    ipv4_default_changed: bool,
    ip_rule_changed: bool,
    min_kill_switch_window_ms: int = MIN_KILL_SWITCH_WINDOW_MS,
    min_kill_switch_unreachable_samples: int = (
        MIN_KILL_SWITCH_UNREACHABLE_SAMPLES
    ),
) -> dict[str, Any]:
    evaluated_episodes: list[dict[str, Any]] = []
    for raw in outage_episodes:
        episode = dict(raw)
        episode.pop("sustained", None)
        episode.pop("proton_temporally_associated", None)
        first_unreachable = episode.get("first_unreachable_epoch_ms")
        last_unreachable = episode.get("last_unreachable_epoch_ms")
        first_reachable_after = episode.get(
            "first_reachable_after_epoch_ms"
        )
        duration_ms: int | None = None
        if isinstance(first_unreachable, int):
            if isinstance(first_reachable_after, int):
                duration_ms = first_reachable_after - first_unreachable
            elif isinstance(last_unreachable, int):
                duration_ms = last_unreachable - first_unreachable
        episode["duration_ms"] = duration_ms
        evaluated_episodes.append(episode)

    kill_switch_window_ms: int | None = None
    if (
        isinstance(kill_switch_first_seen_epoch_ms, int)
        and isinstance(kill_switch_first_absent_after_seen_epoch_ms, int)
    ):
        kill_switch_window_ms = (
            kill_switch_first_absent_after_seen_epoch_ms
            - kill_switch_first_seen_epoch_ms
        )

    kill_switch_sustained = bool(
        kill_switch_window_ms is not None
        and kill_switch_window_ms >= min_kill_switch_window_ms
    )
    proton_during_kill_switch = bool(
        isinstance(proton_first_seen_epoch_ms, int)
        and isinstance(kill_switch_first_seen_epoch_ms, int)
        and isinstance(kill_switch_first_absent_after_seen_epoch_ms, int)
        and kill_switch_first_seen_epoch_ms
        <= proton_first_seen_epoch_ms
        <= kill_switch_first_absent_after_seen_epoch_ms
    )
    reachability_impact_observed = (
        kill_switch_unreachable_sample_count
        >= min_kill_switch_unreachable_samples
    )
    routing_transition_observed = bool(
        ipv4_default_changed or ip_rule_changed
    )

    reasons: list[str] = []
    if initial_proton_present is not False:
        reasons.append("run did not start with proton0 absent")
    if initial_kill_switch_present is not False:
        reasons.append("run did not start with pvpnksintrf0 absent")
    if proton_first_seen_epoch_ms is None:
        reasons.append("proton0 was never observed")
    if final_proton_present is not True:
        reasons.append("run did not end with proton0 present")
    if kill_switch_first_seen_epoch_ms is None:
        reasons.append("pvpnksintrf0 was never observed")
    if kill_switch_first_absent_after_seen_epoch_ms is None:
        reasons.append(
            "pvpnksintrf0 disappearance after activation was not observed"
        )
    if not kill_switch_sustained:
        reasons.append(
            "pvpnksintrf0 transition window was shorter than the "
            f"{min_kill_switch_window_ms} ms minimum"
        )
    if not proton_during_kill_switch:
        reasons.append(
            "proton0 did not first appear during the pvpnksintrf0 window"
        )
    if final_kill_switch_present is not False:
        reasons.append("run did not end with pvpnksintrf0 absent")
    if not reachability_impact_observed:
        reasons.append(
            "insufficient public-reachability failures were observed "
            "while pvpnksintrf0 was active"
        )
    if final_reachable is not True:
        reasons.append("public reachability was not restored by run end")
    if not routing_transition_observed:
        reasons.append("no IPv4-default-route or ip-rule change was observed")

    transition_valid = not reasons
    return {
        "initial_proton_present": initial_proton_present,
        "proton_first_seen_epoch_ms": proton_first_seen_epoch_ms,
        "final_proton_present": final_proton_present,
        "initial_kill_switch_present": initial_kill_switch_present,
        "kill_switch_first_seen_epoch_ms": kill_switch_first_seen_epoch_ms,
        "kill_switch_first_absent_after_seen_epoch_ms": (
            kill_switch_first_absent_after_seen_epoch_ms
        ),
        "final_kill_switch_present": final_kill_switch_present,
        "kill_switch_window_ms": kill_switch_window_ms,
        "kill_switch_sustained": kill_switch_sustained,
        "kill_switch_unreachable_sample_count": (
            kill_switch_unreachable_sample_count
        ),
        "minimum_kill_switch_window_ms": min_kill_switch_window_ms,
        "minimum_kill_switch_unreachable_samples": (
            min_kill_switch_unreachable_samples
        ),
        "proton_during_kill_switch": proton_during_kill_switch,
        "reachability_impact_observed": reachability_impact_observed,
        "final_reachable": final_reachable,
        "outage_episodes": evaluated_episodes,
        "ipv4_default_changed": ipv4_default_changed,
        "ip_rule_changed": ip_rule_changed,
        "routing_transition_observed": routing_transition_observed,
        "transition_valid": transition_valid,
        "classification_allowed": transition_valid,
        "invalid_reasons": reasons,
    }


def read_health_base(path: Path) -> tuple[str | None, str | None]:
    try:
        raw = path.read_text().strip()
        if not raw:
            return None, "empty health URL file"
        if not raw.startswith("http://127.0.0.1:"):
            return None, f"refusing non-loopback health URL: {raw}"
        return raw.rstrip("/"), None
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def local_http_probe(url: str, timeout: float = 0.08) -> dict[str, Any]:
    started = time.monotonic()
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read(128).decode("utf-8", "replace")
            return {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "body": body,
                "error": "",
                "elapsed_ms": round(
                    (time.monotonic() - started) * 1000, 3
                ),
            }
    except Exception as exc:
        return {
            "ok": False,
            "status": None,
            "body": "",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        }


def tcp_probe(
    host: str, port: int, timeout: float = 0.12
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
        return {
            "ok": True,
            "error": "",
            "elapsed_ms": round(
                (time.monotonic() - started) * 1000, 3
            ),
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": round(
                (time.monotonic() - started) * 1000, 3
            ),
        }


def ip_output(args: list[str]) -> str:
    result = run_local(["ip", *args], timeout=0.12)
    if result["ok"]:
        return result["stdout"]
    return (
        f"<unavailable rc={result['returncode']} "
        f"timeout={result['timeout']}: {result['stderr']}>"
    )


def interface_snapshot(name: str) -> dict[str, Any]:
    link = run_local(
        ["ip", "-o", "link", "show", "dev", name], timeout=0.12
    )
    if not link["ok"]:
        return {
            "exists": False,
            "detail": link["stderr"] or link["stdout"],
            "timeout": link["timeout"],
        }
    operstate = None
    try:
        operstate = (
            Path("/sys/class/net") / name / "operstate"
        ).read_text().strip()
    except Exception:
        pass
    return {
        "exists": True,
        "operstate": operstate,
        "detail": link["stdout"],
    }


def tunnel_socket_snapshot(tunnel_pids: set[int]) -> list[str]:
    if not tunnel_pids:
        return []
    result = run_local(["ss", "-Htpn"], timeout=0.15)
    if not result["ok"]:
        return [f"<ss unavailable: {result['stderr']}>"]
    needles = [f"pid={pid}," for pid in tunnel_pids]
    return [
        line
        for line in result["stdout"].splitlines()
        if any(needle in line for needle in needles)
    ]


def dns_snapshot() -> dict[str, Any]:
    dns = run_local(["resolvectl", "dns"], timeout=0.15)
    domains = run_local(["resolvectl", "domain"], timeout=0.15)
    lookup = run_local(
        ["getent", "ahostsv4", "api.openai.com"], timeout=0.18
    )
    return {
        "resolvectl_dns": dns["stdout"] if dns["ok"] else None,
        "resolvectl_dns_error": dns["stderr"] if not dns["ok"] else "",
        "resolvectl_domain": domains["stdout"] if domains["ok"] else None,
        "resolvectl_domain_error": (
            domains["stderr"] if not domains["ok"] else ""
        ),
        "api_openai_lookup_ok": lookup["ok"],
        "api_openai_lookup_timeout": lookup["timeout"],
        "api_openai_lookup": (
            lookup["stdout"].splitlines()[:4] if lookup["ok"] else []
        ),
        "api_openai_lookup_error": (
            lookup["stderr"] if not lookup["ok"] else ""
        ),
    }


def nm_active_snapshot() -> dict[str, Any]:
    result = run_local(
        [
            "nmcli",
            "-t",
            "-f",
            "TYPE,DEVICE",
            "connection",
            "show",
            "--active",
        ],
        timeout=0.2,
    )
    return {
        "ok": result["ok"],
        "connections": (
            result["stdout"].splitlines() if result["ok"] else []
        ),
        "error": result["stderr"] if not result["ok"] else "",
        "timeout": result["timeout"],
    }


def spawn_raw_monitor(
    args: list[str], output_path: Path
) -> subprocess.Popen[str] | None:
    try:
        stream = output_path.open("w")
        proc = subprocess.Popen(
            args,
            stdout=stream,
            stderr=subprocess.STDOUT,
            text=True,
            env=safe_subprocess_env(),
        )
        proc._diagnostic_stream = stream  # type: ignore[attr-defined]
        return proc
    except Exception as exc:
        output_path.write_text(
            json_line(
                {
                    "monitor_launch_error": sanitize_text(
                        f"{type(exc).__name__}: {exc}"
                    )
                }
            )
        )
        return None


def stop_monitor(proc: subprocess.Popen[str] | None) -> None:
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=1.0)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=1.0)
        except Exception:
            pass
    stream = getattr(proc, "_diagnostic_stream", None)
    if stream is not None:
        try:
            stream.close()
        except Exception:
            pass


class SanitizedJournalFollower:
    def __init__(self, unit: str, output_path: Path) -> None:
        self.unit = unit
        self.output_path = output_path
        self.proc: subprocess.Popen[str] | None = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.returncode: int | None = None

    def start(self) -> None:
        try:
            self.proc = subprocess.Popen(
                [
                    "journalctl",
                    "-f",
                    "-o",
                    "json",
                    "--since",
                    "now",
                    "-u",
                    self.unit,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=safe_subprocess_env(),
                bufsize=1,
            )
            self.thread = threading.Thread(
                target=self._pump,
                name=f"wave0-journal-{self.unit}",
                daemon=True,
            )
            self.thread.start()
        except Exception as exc:
            self.output_path.write_text(
                json_line(
                    {
                        "journal_launch_error": sanitize_text(
                            f"{type(exc).__name__}: {exc}"
                        ),
                        "unit": self.unit,
                    }
                )
            )

    def _pump(self) -> None:
        try:
            with self.output_path.open("w") as dst:
                assert self.proc is not None
                assert self.proc.stdout is not None
                while not self.stop_event.is_set():
                    line = self.proc.stdout.readline()
                    if not line:
                        if self.proc.poll() is not None:
                            break
                        self.stop_event.wait(0.05)
                        continue
                    try:
                        raw = json.loads(line)
                        event = {
                            "realtime_timestamp": raw.get(
                                "__REALTIME_TIMESTAMP"
                            ),
                            "unit": raw.get("_SYSTEMD_UNIT", self.unit),
                            "priority": raw.get("PRIORITY"),
                            "message": sanitize_text(
                                str(raw.get("MESSAGE", ""))
                            ),
                            "recorder_seen_epoch_ms": now_epoch_ms(),
                        }
                    except json.JSONDecodeError:
                        event = {
                            "unit": self.unit,
                            "recorder_seen_epoch_ms": now_epoch_ms(),
                            "parse_error": "journal line omitted",
                        }
                    dst.write(json_line(event))
                    dst.flush()
        except Exception as exc:
            try:
                with self.output_path.open("a") as dst:
                    dst.write(
                        json_line(
                            {
                                "unit": self.unit,
                                "journal_pump_error": sanitize_text(
                                    f"{type(exc).__name__}: {exc}"
                                ),
                                "recorder_seen_epoch_ms": now_epoch_ms(),
                            }
                        )
                    )
            except Exception:
                pass

    def stop(self) -> None:
        self.stop_event.set()
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=1.0)
            except Exception:
                try:
                    self.proc.kill()
                    self.proc.wait(timeout=1.0)
                except Exception:
                    pass
            self.returncode = self.proc.returncode
        if self.thread is not None:
            self.thread.join(timeout=1.0)


def tail_tunnel_events(
    source: Path, destination: Path, stop: threading.Event
) -> None:
    try:
        with source.open(
            "r", errors="replace"
        ) as src, destination.open("w") as dst:
            src.seek(0, os.SEEK_END)
            while not stop.is_set():
                line = src.readline()
                if not line:
                    stop.wait(0.05)
                    continue
                try:
                    obj = json.loads(line)
                    filtered = {
                        key: sanitize_value(value)
                        for key, value in obj.items()
                        if key in TUNNEL_EVENT_KEYS
                        and not SENSITIVE_RE.search(key)
                    }
                    filtered["recorder_seen_epoch_ms"] = now_epoch_ms()
                    dst.write(json_line(filtered))
                    dst.flush()
                except json.JSONDecodeError:
                    dst.write(
                        json_line(
                            {
                                "recorder_seen_epoch_ms": now_epoch_ms(),
                                "parse_error": (
                                    "non-json tunnel log line omitted"
                                ),
                            }
                        )
                    )
                    dst.flush()
    except Exception as exc:
        destination.write_text(
            json_line(
                {
                    "recorder_seen_epoch_ms": now_epoch_ms(),
                    "tail_error": sanitize_text(
                        f"{type(exc).__name__}: {exc}"
                    ),
                }
            )
        )


def safe_command_version(args: list[str]) -> str | None:
    result = run_local(args, timeout=0.5)
    return result["stdout"] if result["ok"] else None


def project_runtime_status(raw: dict[str, Any]) -> dict[str, Any]:
    local = raw.get("local") if isinstance(raw.get("local"), dict) else {}
    effective = (
        local.get("effective_health")
        if isinstance(local.get("effective_health"), dict)
        else {}
    )
    process = raw.get("process") if isinstance(raw.get("process"), dict) else {}
    tmux = raw.get("tmux") if isinstance(raw.get("tmux"), dict) else {}

    return sanitize_value(
        {
            "alias": raw.get("alias"),
            "healthy": raw.get("healthy"),
            "ready": raw.get("ready"),
            "process_running": raw.get("process_running"),
            "runtime_state": raw.get("runtime_state"),
            "stale": raw.get("stale"),
            "control_plane_poll_health": raw.get(
                "control_plane_poll_health"
            ),
            "local": {
                "control_plane_poll_health": local.get(
                    "control_plane_poll_health"
                ),
                "effective_health": {
                    "base_url": effective.get("base_url"),
                    "healthz": effective.get("healthz"),
                    "readyz": effective.get("readyz"),
                },
            },
            "process": {
                "started_at": process.get("started_at"),
                "mode": process.get("mode"),
                "target_kind": process.get("target_kind"),
            },
            "tmux": {
                "running": tmux.get("running"),
                "session_name": tmux.get("session_name"),
            },
        }
    )


def capture_runtime_status(path: Path) -> None:
    result = run_local(
        [
            "tunnel-client",
            "runtimes",
            "status",
            "codex-chatgpt-web",
            "--json",
        ],
        timeout=3.0,
    )
    payload: dict[str, Any] = {
        "observed_epoch_ms": now_epoch_ms(),
        "observed_human": now_human(),
        "command_ok": result["ok"],
        "timeout": result["timeout"],
        "returncode": result["returncode"],
    }
    if result["ok"]:
        try:
            raw = json.loads(result["stdout"])
            if not isinstance(raw, dict):
                raise ValueError("runtime status root was not an object")
            payload["status"] = project_runtime_status(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            payload["parse_error"] = sanitize_text(str(exc))
    else:
        payload["error"] = sanitize_text(result["stderr"][-1000:])
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n"
    )


def write_metadata(
    path: Path,
    args: argparse.Namespace,
    initial_roles: dict[str, list[dict[str, Any]]],
    independence: dict[str, Any],
    target_precondition: dict[str, Any],
) -> None:
    meta = {
        "schema": 1,
        "purpose": (
            "Wave 0 resilient MCP transport diagnostic recorder"
        ),
        "read_only_observation": True,
        "started_epoch_ms": now_epoch_ms(),
        "started_human": now_human(),
        "duration_seconds": args.duration,
        "interval_ms": args.interval_ms,
        "label": args.label,
        "health_url_file": str(args.health_url_file),
        "tunnel_log_source": str(args.tunnel_log),
        "target_interfaces": list(TARGET_INTERFACES),
        "watch_patterns": list(args.watch_pattern),
        "recorder_independence": independence,
        "target_precondition": target_precondition,
        "versions": {
            "python": sys.version.split()[0],
            "kernel": platform.release(),
            "tunnel_client": safe_command_version(
                ["tunnel-client", "--version"]
            ),
            "herdr": safe_command_version(["herdr", "--version"]),
        },
        "initial_processes": add_lstart(initial_roles),
        "initial_topology": process_topology(initial_roles),
        "notes": [
            "No environment variables are captured.",
            (
                "Cmdlines are sanitized for "
                "token/key/authorization-like arguments."
            ),
            (
                "Tunnel log capture is a whitelist projection; "
                "raw tunnel log lines are not copied."
            ),
            (
                "NetworkManager and Proton journal capture is projected "
                "to timestamp/unit/priority/message and text-redacted."
            ),
            (
                "Runtime status is projected to local process/health/"
                "control-plane observability fields only."
            ),
            (
                "Local /healthz and /readyz are loopback observations, "
                "not proof of control-plane reachability."
            ),
            (
                "Public reachability probe uses TCP 1.1.1.1:443 "
                "and does not authenticate."
            ),
        ],
    }
    path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument("--interval-ms", type=int, default=250)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", default="")
    parser.add_argument(
        "--watch-pattern",
        action="append",
        default=[],
        help=(
            "Record identities for any process whose sanitized cmdline contains "
            "this non-secret tag. May be repeated."
        ),
    )
    parser.add_argument(
        "--health-url-file",
        type=Path,
        default=DEFAULT_HEALTH_URL_FILE,
    )
    parser.add_argument(
        "--tunnel-log", type=Path, default=DEFAULT_TUNNEL_LOG
    )
    parser.add_argument(
        "--expected-profile",
        default=EXPECTED_PROFILE,
        help="Exact tunnel-client --profile value required by the target matcher.",
    )
    args = parser.parse_args()

    if args.duration <= 0:
        parser.error("--duration must be > 0")
    if args.interval_ms < 100:
        parser.error("--interval-ms must be >= 100")
    if not args.expected_profile or SENSITIVE_RE.search(args.expected_profile):
        parser.error("--expected-profile must be non-empty and non-sensitive")
    for pattern in args.watch_pattern:
        if not pattern or SENSITIVE_RE.search(pattern):
            parser.error(
                "--watch-pattern must be a non-empty, non-sensitive tag"
            )

    independence = recorder_independence(args.expected_profile)
    if not independence["independent_of_gwc_and_tunnel"]:
        parser.error(
            "recorder is owned by the GWC/tunnel process tree; "
            "launch it from an independent Herdr pane"
        )

    initial_roles = process_roles(args.expected_profile)
    target_precondition = validate_target_preconditions(initial_roles)
    if not target_precondition["valid"]:
        parser.error(
            "target process precondition failed: "
            + "; ".join(target_precondition["errors"])
        )

    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)

    write_metadata(
        out / "metadata.json",
        args,
        initial_roles,
        independence,
        target_precondition,
    )
    capture_runtime_status(out / "runtime-status-before.json")

    ip_monitor = spawn_raw_monitor(
        [
            "stdbuf",
            "-oL",
            "ip",
            "-ts",
            "monitor",
            "link",
            "route",
            "rule",
        ],
        out / "ip-monitor.log",
    )
    journal_followers = {
        "networkmanager": SanitizedJournalFollower(
            "NetworkManager.service", out / "journal-network.ndjson"
        ),
        "proton": SanitizedJournalFollower(
            "proton.VPN.service", out / "journal-proton.ndjson"
        ),
    }
    for follower in journal_followers.values():
        follower.start()

    tail_stop = threading.Event()
    tail_thread = threading.Thread(
        target=tail_tunnel_events,
        args=(
            args.tunnel_log,
            out / "tunnel-events.ndjson",
            tail_stop,
        ),
        daemon=True,
    )
    tail_thread.start()

    process_events = (out / "process-events.log").open("w")
    samples = (out / "samples.ndjson").open("w")
    health_samples = (out / "tunnel-health.ndjson").open("w")

    previous_identity = {
        role: identity_signature(items)
        for role, items in initial_roles.items()
    }
    previous_parent = {
        role: parent_signature(items)
        for role, items in initial_roles.items()
    }
    process_events.write(
        json_line(
            {
                "epoch_ms": now_epoch_ms(),
                "human": now_human(),
                "event": "initial",
                "roles": add_lstart(initial_roles),
                "topology": process_topology(initial_roles),
            }
        )
    )
    process_events.flush()

    start_monotonic = time.monotonic()
    deadline = start_monotonic + args.duration
    interval = args.interval_ms / 1000.0
    sample_index = 0
    next_tick = start_monotonic

    initial_proton_present: bool | None = None
    final_proton_present: bool | None = None
    proton_first_seen_epoch_ms: int | None = None
    initial_kill_switch_present: bool | None = None
    final_kill_switch_present: bool | None = None
    kill_switch_first_seen_epoch_ms: int | None = None
    kill_switch_first_absent_after_seen_epoch_ms: int | None = None
    kill_switch_unreachable_sample_count = 0
    final_reachable: bool | None = None
    initial_ipv4_default: str | None = None
    initial_ip_rule: str | None = None
    ipv4_default_changed = False
    ip_rule_changed = False
    last_reachable_epoch_ms: int | None = None
    active_outage: dict[str, Any] | None = None
    outage_episodes: list[dict[str, Any]] = []

    try:
        while time.monotonic() < deadline:
            roles = process_roles(args.expected_profile)
            for role, items in roles.items():
                identity_sig = identity_signature(items)
                parent_sig = parent_signature(items)
                if identity_sig != previous_identity.get(role, ()):
                    process_events.write(
                        json_line(
                            {
                                "epoch_ms": now_epoch_ms(),
                                "human": now_human(),
                                "event": "process_identity_change",
                                "role": role,
                                "before": previous_identity.get(role, ()),
                                "after": identity_sig,
                                "identities": add_lstart(
                                    {role: items}
                                )[role],
                                "topology": process_topology(roles),
                            }
                        )
                    )
                    process_events.flush()
                    previous_identity[role] = identity_sig
                    previous_parent[role] = parent_sig
                elif parent_sig != previous_parent.get(role, ()):
                    process_events.write(
                        json_line(
                            {
                                "epoch_ms": now_epoch_ms(),
                                "human": now_human(),
                                "event": "parent_relationship_change",
                                "role": role,
                                "before": previous_parent.get(role, ()),
                                "after": parent_sig,
                                "identities": add_lstart(
                                    {role: items}
                                )[role],
                                "topology": process_topology(roles),
                            }
                        )
                    )
                    process_events.flush()
                    previous_parent[role] = parent_sig

            tunnel_pids = {
                item["pid"] for item in roles["tunnel_client"]
            }
            health_base, health_base_error = read_health_base(
                args.health_url_file
            )
            healthz = (
                local_http_probe(f"{health_base}/healthz")
                if health_base
                else None
            )
            readyz = (
                local_http_probe(f"{health_base}/readyz")
                if health_base
                else None
            )

            sample: dict[str, Any] = {
                "index": sample_index,
                "epoch_ms": now_epoch_ms(),
                "human": now_human(),
                "monotonic_offset_ms": round(
                    (time.monotonic() - start_monotonic) * 1000,
                    3,
                ),
                "processes": roles,
                "watched_processes": watched_processes(
                    args.watch_pattern,
                    exclude_pids={os.getpid()},
                ),
                "network": {
                    "default_route_ipv4": ip_output(
                        ["-4", "route", "show", "default"]
                    ),
                    "default_route_ipv6": ip_output(
                        ["-6", "route", "show", "default"]
                    ),
                    "ip_rule": ip_output(["rule", "show"]),
                    "interfaces": {
                        name: interface_snapshot(name)
                        for name in TARGET_INTERFACES
                    },
                    "tcp_1_1_1_1_443": tcp_probe(
                        "1.1.1.1", 443
                    ),
                    "tunnel_sockets": tunnel_socket_snapshot(
                        tunnel_pids
                    ),
                },
                "tunnel_health": {
                    "base_url": health_base,
                    "base_url_error": health_base_error,
                    "healthz": healthz,
                    "readyz": readyz,
                },
            }

            proton_present = sample["network"]["interfaces"]["proton0"]["exists"]
            kill_switch_present = sample["network"]["interfaces"][
                "pvpnksintrf0"
            ]["exists"]
            reachable = sample["network"]["tcp_1_1_1_1_443"]["ok"]
            epoch_ms = sample["epoch_ms"]
            current_ipv4_default = sample["network"]["default_route_ipv4"]
            current_ip_rule = sample["network"]["ip_rule"]

            if sample_index == 0:
                initial_proton_present = proton_present
                initial_kill_switch_present = kill_switch_present
                initial_ipv4_default = current_ipv4_default
                initial_ip_rule = current_ip_rule
            final_proton_present = proton_present
            final_kill_switch_present = kill_switch_present
            final_reachable = reachable

            if proton_present and proton_first_seen_epoch_ms is None:
                proton_first_seen_epoch_ms = epoch_ms
            if kill_switch_present:
                if kill_switch_first_seen_epoch_ms is None:
                    kill_switch_first_seen_epoch_ms = epoch_ms
                if not reachable:
                    kill_switch_unreachable_sample_count += 1
            elif (
                kill_switch_first_seen_epoch_ms is not None
                and kill_switch_first_absent_after_seen_epoch_ms is None
            ):
                kill_switch_first_absent_after_seen_epoch_ms = epoch_ms

            if (
                initial_ipv4_default is not None
                and current_ipv4_default != initial_ipv4_default
            ):
                ipv4_default_changed = True
            if initial_ip_rule is not None and current_ip_rule != initial_ip_rule:
                ip_rule_changed = True

            if reachable:
                if active_outage is not None:
                    active_outage["first_reachable_after_epoch_ms"] = epoch_ms
                    outage_episodes.append(active_outage)
                    active_outage = None
                last_reachable_epoch_ms = epoch_ms
            else:
                if active_outage is None:
                    active_outage = {
                        "last_reachable_before_epoch_ms": last_reachable_epoch_ms,
                        "first_unreachable_epoch_ms": epoch_ms,
                        "last_unreachable_epoch_ms": epoch_ms,
                        "unreachable_sample_count": 1,
                        "first_reachable_after_epoch_ms": None,
                    }
                else:
                    active_outage["last_unreachable_epoch_ms"] = epoch_ms
                    active_outage["unreachable_sample_count"] += 1

            if sample_index % 4 == 0:
                sample["dns"] = dns_snapshot()
                sample["network_manager_active"] = (
                    nm_active_snapshot()
                )

            samples.write(json_line(sample))
            samples.flush()
            health_samples.write(
                json_line(
                    {
                        "index": sample_index,
                        "epoch_ms": sample["epoch_ms"],
                        "human": sample["human"],
                        "tunnel_processes": roles[
                            "tunnel_client"
                        ],
                        "health": sample["tunnel_health"],
                    }
                )
            )
            health_samples.flush()

            sample_index += 1
            next_tick += interval
            sleep_for = next_tick - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                next_tick = time.monotonic()
    finally:
        samples.close()
        health_samples.close()
        process_events.close()
        tail_stop.set()
        tail_thread.join(timeout=1.0)
        stop_monitor(ip_monitor)
        for follower in journal_followers.values():
            follower.stop()
        capture_runtime_status(
            out / "runtime-status-after.json"
        )

        if active_outage is not None:
            outage_episodes.append(active_outage)
            active_outage = None

        transition_evidence = evaluate_transition_evidence(
            initial_proton_present=initial_proton_present,
            final_proton_present=final_proton_present,
            proton_first_seen_epoch_ms=proton_first_seen_epoch_ms,
            initial_kill_switch_present=initial_kill_switch_present,
            final_kill_switch_present=final_kill_switch_present,
            kill_switch_first_seen_epoch_ms=(
                kill_switch_first_seen_epoch_ms
            ),
            kill_switch_first_absent_after_seen_epoch_ms=(
                kill_switch_first_absent_after_seen_epoch_ms
            ),
            kill_switch_unreachable_sample_count=(
                kill_switch_unreachable_sample_count
            ),
            final_reachable=final_reachable,
            outage_episodes=outage_episodes,
            ipv4_default_changed=ipv4_default_changed,
            ip_rule_changed=ip_rule_changed,
        )

        final_roles = process_roles(args.expected_profile)
        end = {
            "ended_epoch_ms": now_epoch_ms(),
            "ended_human": now_human(),
            "actual_duration_ms": round(
                (time.monotonic() - start_monotonic) * 1000,
                3,
            ),
            "sample_count": sample_index,
            "transition_evidence": transition_evidence,
            "final_processes": add_lstart(final_roles),
            "final_topology": process_topology(final_roles),
            "recorder_final_identity": proc_identity(os.getpid()),
            "monitor_returncodes": {
                "ip": None if ip_monitor is None else ip_monitor.returncode,
                **{
                    key: follower.returncode
                    for key, follower in journal_followers.items()
                },
            },
        }
        (out / "recorder-result.json").write_text(
            json.dumps(end, indent=2, sort_keys=True) + "\n"
        )
        (out / "summary.md").write_text(
            "# MCP transition diagnostic run\n\n"
            f"- Label: {args.label or '(none)'}\n"
            f"- Samples: {sample_index}\n"
            f"- Requested duration: {args.duration:.3f} s\n"
            f"- Actual duration: "
            f"{end['actual_duration_ms'] / 1000:.3f} s\n"
            f"- Physical Proton transition valid: "
            f"{transition_evidence['transition_valid']}\n"
            f"- A/B/C/D classification allowed: "
            f"{transition_evidence['classification_allowed']}\n"
            "- Analysis/classification: pending executor "
            "correlation with connector and invocation observations.\n"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
