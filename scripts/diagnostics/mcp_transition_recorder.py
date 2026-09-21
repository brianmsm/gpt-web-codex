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
SENSITIVE_RE = re.compile(
    r"(?i)(authorization|api[_-]?key|token|secret|password|credential)"
)

ROLES = (
    "tunnel_client",
    "gwc_mcp",
    "herdr_server",
    "launcher_appimage",
    "launcher_main",
)

TUNNEL_EXECUTABLE = "/home/brian/.codex-chatgpt-web/bin/tunnel-client"
GWC_CLI = "/home/brian/.codex-chatgpt-web/versions/2.2.11-linux-x64/app/cli.js"
LAUNCHER_APPIMAGE = (
    "/home/brian/.local/lib/gpt-web-codex/2.2.11-herdr.3/GPT-Web-Codex.AppImage"
)

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

        out.append(arg)
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


def matches_role(role: str, ident: dict[str, Any]) -> bool:
    parts = ident["cmdline"]
    if not parts:
        return False

    if role == "tunnel_client":
        return (
            parts[0] == TUNNEL_EXECUTABLE
            and len(parts) >= 2
            and parts[1] == "run"
            and "--profile" in parts
            and "codex-chatgpt-web" in parts
        )

    if role == "gwc_mcp":
        return (
            len(parts) >= 3
            and parts[1] == GWC_CLI
            and parts[2] == "mcp"
        )

    if role == "herdr_server":
        return parts[:2] == ["/usr/bin/herdr", "server"]

    if role == "launcher_appimage":
        return parts[0] == LAUNCHER_APPIMAGE

    if role == "launcher_main":
        return Path(parts[0]).name == "gpt-web-codex-launcher"

    return False


def process_roles() -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {role: [] for role in ROLES}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        ident = proc_identity(int(entry.name))
        if not ident:
            continue
        for role in ROLES:
            if matches_role(role, ident):
                result[role].append(ident)
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
) -> tuple[tuple[int, int, int], ...]:
    return tuple(
        (x["pid"], x["ppid"], x["starttime"]) for x in items
    )


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
            "NAME,TYPE,DEVICE",
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


def spawn_monitor(
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
            f"monitor launch failed: {type(exc).__name__}: {exc}\n"
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
                        key: value
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
                    "tail_error": f"{type(exc).__name__}: {exc}",
                }
            )
        )


def safe_command_version(args: list[str]) -> str | None:
    result = run_local(args, timeout=0.5)
    return result["stdout"] if result["ok"] else None


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
            if isinstance(raw, dict):
                local = raw.get("local")
                if isinstance(local, dict):
                    local = dict(local)
                    log = local.get("log")
                    if isinstance(log, dict):
                        log = dict(log)
                        log.pop("tail", None)
                        local["log"] = log
                    raw["local"] = local
                raw.pop("repair_command", None)
                raw.pop("remote_lookup_auth_ref", None)
            payload["status"] = raw
        except json.JSONDecodeError:
            payload["parse_error"] = (
                "runtime status was not valid JSON"
            )
    else:
        payload["error"] = result["stderr"][-1000:]
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n"
    )


def write_metadata(
    path: Path,
    args: argparse.Namespace,
    initial_roles: dict[str, list[dict[str, Any]]],
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
        "versions": {
            "python": sys.version.split()[0],
            "kernel": platform.release(),
            "tunnel_client": safe_command_version(
                ["tunnel-client", "--version"]
            ),
            "herdr": safe_command_version(["herdr", "--version"]),
        },
        "initial_processes": add_lstart(initial_roles),
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
        "--health-url-file",
        type=Path,
        default=DEFAULT_HEALTH_URL_FILE,
    )
    parser.add_argument(
        "--tunnel-log", type=Path, default=DEFAULT_TUNNEL_LOG
    )
    args = parser.parse_args()

    if args.duration <= 0:
        parser.error("--duration must be > 0")
    if args.interval_ms < 100:
        parser.error("--interval-ms must be >= 100")

    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)

    initial_roles = process_roles()
    write_metadata(out / "metadata.json", args, initial_roles)
    capture_runtime_status(out / "runtime-status-before.json")

    monitors = {
        "ip": spawn_monitor(
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
        ),
        "networkmanager": spawn_monitor(
            [
                "journalctl",
                "-f",
                "-o",
                "short-iso-precise",
                "--since",
                "now",
                "-u",
                "NetworkManager.service",
            ],
            out / "journal-network.log",
        ),
        "proton": spawn_monitor(
            [
                "journalctl",
                "-f",
                "-o",
                "short-iso-precise",
                "--since",
                "now",
                "-u",
                "proton.VPN.service",
            ],
            out / "journal-proton.log",
        ),
    }

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

    previous = {
        role: identity_signature(items)
        for role, items in initial_roles.items()
    }
    process_events.write(
        json_line(
            {
                "epoch_ms": now_epoch_ms(),
                "human": now_human(),
                "event": "initial",
                "roles": add_lstart(initial_roles),
            }
        )
    )
    process_events.flush()

    start_monotonic = time.monotonic()
    deadline = start_monotonic + args.duration
    interval = args.interval_ms / 1000.0
    sample_index = 0
    next_tick = start_monotonic

    try:
        while time.monotonic() < deadline:
            roles = process_roles()
            for role, items in roles.items():
                sig = identity_signature(items)
                if sig != previous.get(role, ()):
                    process_events.write(
                        json_line(
                            {
                                "epoch_ms": now_epoch_ms(),
                                "human": now_human(),
                                "event": "identity_change",
                                "role": role,
                                "before": previous.get(role, ()),
                                "after": sig,
                                "identities": add_lstart(
                                    {role: items}
                                )[role],
                            }
                        )
                    )
                    process_events.flush()
                    previous[role] = sig

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
        for proc in monitors.values():
            stop_monitor(proc)
        capture_runtime_status(
            out / "runtime-status-after.json"
        )

        final_roles = process_roles()
        end = {
            "ended_epoch_ms": now_epoch_ms(),
            "ended_human": now_human(),
            "actual_duration_ms": round(
                (time.monotonic() - start_monotonic) * 1000,
                3,
            ),
            "sample_count": sample_index,
            "final_processes": add_lstart(final_roles),
            "monitor_returncodes": {
                key: None if proc is None else proc.returncode
                for key, proc in monitors.items()
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
            "- Analysis/classification: pending executor "
            "correlation with connector and invocation observations.\n"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
