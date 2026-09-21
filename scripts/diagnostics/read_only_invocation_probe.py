#!/usr/bin/env python3
"""Bounded read-only workload used as a deliberate MCP invocation probe."""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime
from pathlib import Path


READ_TARGETS = (
    Path("/proc/uptime"),
    Path("/proc/loadavg"),
    Path("/proc/net/route"),
)


def now_human() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--interval-ms", type=int, default=50)
    args = parser.parse_args()

    if args.duration <= 0 or args.duration > 120:
        parser.error("--duration must be > 0 and <= 120")
    if args.interval_ms < 10 or args.interval_ms > 1000:
        parser.error("--interval-ms must be between 10 and 1000")
    if not args.tag or any(ch.isspace() for ch in args.tag):
        parser.error("--tag must be a non-empty token without whitespace")

    start_mono = time.monotonic()
    deadline = start_mono + args.duration
    reads = 0
    bytes_read = 0
    stat_checks = 0
    first_observed = None
    last_observed = None

    while time.monotonic() < deadline:
        for target in READ_TARGETS:
            try:
                data = target.read_bytes()
                bytes_read += len(data)
                reads += 1
                if first_observed is None:
                    first_observed = data[:64].decode("utf-8", "replace")
                last_observed = data[:64].decode("utf-8", "replace")
            except (FileNotFoundError, PermissionError, OSError):
                pass

        for target in (
            Path("/proc/self/stat"),
            Path("/proc/self/status"),
            Path("/proc/net/tcp"),
        ):
            try:
                os.stat(target)
                stat_checks += 1
            except (FileNotFoundError, PermissionError, OSError):
                pass

        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(args.interval_ms / 1000.0, remaining))

    result = {
        "tag": args.tag,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "started_human": datetime.fromtimestamp(
            time.time() - (time.monotonic() - start_mono)
        ).astimezone().isoformat(timespec="milliseconds"),
        "ended_human": now_human(),
        "actual_duration_ms": round(
            (time.monotonic() - start_mono) * 1000, 3
        ),
        "reads": reads,
        "bytes_read": bytes_read,
        "stat_checks": stat_checks,
        "first_observed_prefix": first_observed,
        "last_observed_prefix": last_observed,
        "read_only": True,
    }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
