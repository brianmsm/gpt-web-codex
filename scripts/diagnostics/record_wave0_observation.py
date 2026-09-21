#!/usr/bin/env python3
"""Append timestamped lateral observations to one Wave 0 run."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

SENSITIVE_RE = re.compile(
    r"(?i)(authorization|api[_-]?key|token|secret|password|credential)"
)
AUTHORIZATION_RE = re.compile(
    r"(?i)\b(authorization)([\s]*[=:][\s]*)"
    r"(?:(?:basic|bearer|digest|negotiate)\s+)?[^\s,;]+"
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

EVENTS = (
    "run_armed",
    "vpn_connect_instruction",
    "vpn_connect_user_confirmed",
    "invocation_start",
    "invocation_result",
    "session_terminated_observed",
    "connector_probe_start",
    "connector_probe_result",
    "note",
)

OUTCOMES = (
    "success",
    "session_terminated",
    "timeout",
    "error",
    "ambiguous",
    "not_applicable",
)

SOURCES = (
    "executor",
    "user_observation",
    "tool_result",
    "tunnel_log",
    "network_observation",
    "manual_correlation",
)


def now_human() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def sanitize_text(value: str) -> str:
    value = AUTHORIZATION_RE.sub(r"\1\2<redacted>", value)
    value = BEARER_RE.sub(r"\1 <redacted>", value)
    value = SENSITIVE_ASSIGNMENT_RE.sub(r"\1\2<redacted>", value)
    value = SENSITIVE_QUERY_RE.sub(r"\1<redacted>", value)
    return value


def sanitize_optional(value: str | None) -> str | None:
    if value is None:
        return None
    return sanitize_text(value)


def append_atomic(path: Path, payload: dict[str, Any]) -> None:
    line = json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"
    fd = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC,
        0o600,
    )
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--event", choices=EVENTS, required=True)
    parser.add_argument("--source", choices=SOURCES, required=True)
    parser.add_argument("--run-kind", choices=("idle", "near-transition", "long-running"))
    parser.add_argument("--invocation-tag")
    parser.add_argument("--outcome", choices=OUTCOMES)
    parser.add_argument("--event-time")
    parser.add_argument("--request-id")
    parser.add_argument("--cmd-request-id")
    parser.add_argument("--detail", default="")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        parser.error("--run-dir must already exist")

    for value in (
        args.invocation_tag,
        args.request_id,
        args.cmd_request_id,
    ):
        if value and SENSITIVE_RE.search(value):
            parser.error("identifier arguments must not contain sensitive labels")

    payload = {
        "recorded_epoch_ms": time.time_ns() // 1_000_000,
        "recorded_human": now_human(),
        "event": args.event,
        "source": args.source,
        "run_kind": args.run_kind,
        "invocation_tag": sanitize_optional(args.invocation_tag),
        "outcome": args.outcome,
        "event_time": sanitize_optional(args.event_time),
        "request_id": sanitize_optional(args.request_id),
        "cmd_request_id": sanitize_optional(args.cmd_request_id),
        "detail": sanitize_text(args.detail),
    }
    append_atomic(run_dir / "observations.ndjson", payload)
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
