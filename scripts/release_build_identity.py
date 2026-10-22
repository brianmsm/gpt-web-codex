#!/usr/bin/env python3
"""Record and verify the exact source commit of every release build.

Self-reported CI provenance, not a signed artifact attestation. This prevents
the publish job from staging outputs of a different commit or workflow run.
Never sends network traffic or reads secret tokens.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

RUNNERS = ("macos-15", "macos-15-intel", "ubuntu-latest", "windows-latest")
RUNTIMES = {
    "macos-15": "codex-chatgpt-web-darwin-arm64.tar.gz",
    "macos-15-intel": "codex-chatgpt-web-darwin-amd64.tar.gz",
    "ubuntu-latest": "codex-chatgpt-web-linux-amd64.tar.gz",
    "windows-latest": "codex-chatgpt-web-windows-amd64.zip",
}
INSTALLER_EXTENSIONS = (".dmg", ".zip", ".exe", ".AppImage")
SHA = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
NUMBER = re.compile(r"[1-9][0-9]*\Z")
SCHEMA = "gwc-release-source-commit/v1"
FIELDS = {"schema", "runner", "source_sha", "workflow_sha", "run_id", "run_attempt", "files"}


def fail(message: str) -> None:
    raise ValueError(message)


def validated_environment() -> dict:
    values = {}
    for key in ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        item = os.environ.get(key, "")
        if not (SHA.fullmatch(item) if key == "GITHUB_SHA" else NUMBER.fullmatch(item)):
            fail("Invalid GitHub workflow identity")
        values[key] = item
    result = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                            text=True, check=True, timeout=10)
    if result.stdout.strip() != values["GITHUB_SHA"]:
        fail("Checked-out source HEAD differs from the workflow event SHA")
    return values


def manifest_name(runner: str) -> str:
    if runner not in RUNNERS:
        fail("Unknown release build matrix runner")
    return f"release-source-{runner}.json"


def read_strict(path: Path) -> dict:
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                fail("Duplicate field in release source manifest")
            out[key] = value
        return out
    if path.is_symlink() or not path.is_file():
        fail("Release source manifest missing or symlinked")
    if path.stat().st_size > 4096:
        fail("Oversized release source manifest")
    value = json.loads(path.read_bytes().decode("utf-8"), object_pairs_hook=pairs,
                       parse_constant=lambda _: fail("Invalid numeric constant"))
    if type(value) is not dict or set(value) != FIELDS:
        fail("Unexpected release source manifest schema")
    if not all(type(v) is str for key, v in value.items() if key != "files"):
        fail("Invalid source manifest identity field types")
    files = value["files"]
    if type(files) is not dict or not files or not all(
        type(k) is str and type(v) is str and SHA256.fullmatch(v) for k, v in files.items()
    ):
        fail("Missing or invalid recorded build asset digests")
    return value


def checksum(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        fail("Release asset missing, nonregular or symlinked")
    hash_ = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            hash_.update(chunk)
    return hash_.hexdigest()


def recorded_files(root: Path, runner: str) -> dict[str, str]:
    runtime = RUNTIMES[runner]
    launcher = root / "launcher" / "artifacts"
    if launcher.is_symlink() or not launcher.is_dir():
        fail("Launcher artifacts directory missing")
    installers = [
        p for p in launcher.iterdir()
        if p.is_file() and p.name.endswith(INSTALLER_EXTENSIONS)
    ]
    if not installers or any(p.is_symlink() for p in installers):
        fail("No safe installer artifacts for platform")
    paths = [root / runtime, *installers]
    return {
        path.relative_to(root).as_posix(): checksum(path)
        for path in paths
    }


def record(runner: str, output: Path, artifact_root: Path) -> None:
    env = validated_environment()
    if output.name != manifest_name(runner) or output.is_symlink() or output.exists():
        fail("Unsafe or existing release source manifest path")
    files = recorded_files(artifact_root, runner)
    body = {
        "schema": SCHEMA, "runner": runner, "source_sha": env["GITHUB_SHA"],
        "workflow_sha": env["GITHUB_SHA"], "run_id": env["GITHUB_RUN_ID"],
        "run_attempt": env["GITHUB_RUN_ATTEMPT"], "files": files,
    }
    data = (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode()
    with output.open("xb") as handle:
        handle.write(data)
    print("RELEASE_BUILD_SOURCE_RECORDED=" + runner)


def verify(directory: Path) -> None:
    env = validated_environment()
    if not directory.is_dir() or directory.is_symlink():
        fail("Missing release assets directory")
    existing = {p.name for p in directory.iterdir() if p.name.startswith("release-source-")}
    names = {manifest_name(runner) for runner in RUNNERS}
    if existing != names:
        fail("Incomplete or unexpected matrix source identities")
    expected_files = {}
    for runner in RUNNERS:
        record = read_strict(directory / manifest_name(runner))
        expected = {
            "schema": SCHEMA, "runner": runner, "source_sha": env["GITHUB_SHA"],
            "workflow_sha": env["GITHUB_SHA"], "run_id": env["GITHUB_RUN_ID"],
            "run_attempt": env["GITHUB_RUN_ATTEMPT"],
        }
        if any(record[k] != value for k, value in expected.items()):
            fail("Build artifact source identity or workflow run mismatch")
        asset_digests = record["files"]
        runtime = RUNTIMES[runner]
        if runtime not in asset_digests or not any(
            key.startswith("launcher/artifacts/") for key in asset_digests
        ):
            fail("Platform build lacks runtime or packaged installer")
        for filename, digest in asset_digests.items():
            if filename in expected_files:
                fail("Release build artifact collision across matrix jobs")
            valid_name = (filename == runtime or (
                filename.startswith("launcher/artifacts/")
                and "/" not in filename[len("launcher/artifacts/"):]
                and filename.endswith(INSTALLER_EXTENSIONS)
            ))
            if not valid_name:
                fail("Unexpected recorded release artifact path")
            expected_files[filename] = digest
    observed = {}
    for path in directory.rglob("*"):
        if path.is_symlink():
            fail("Symlink in downloaded release artifact tree")
        if path.is_file():
            relative = path.relative_to(directory).as_posix()
            if relative not in names:
                observed[relative] = checksum(path)
    if observed != expected_files:
        fail("Release binary bytes or complete artifact inventory differ from matrix uploads")
    print("RELEASE_BUILD_SOURCE_IDENTITIES_VERIFIED=4")
    print("RELEASE_BUILD_ASSET_DIGESTS_VERIFIED=" + str(len(expected_files)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    recorder = sub.add_parser("record")
    recorder.add_argument("--runner", required=True)
    recorder.add_argument("--output", type=Path, required=True)
    recorder.add_argument("--artifact-root", type=Path, default=Path("."))
    verifier = sub.add_parser("verify")
    verifier.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.operation == "record":
            record(args.runner, args.output, args.artifact_root)
        else:
            verify(args.directory)
    except (ValueError, OSError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired, UnicodeError, json.JSONDecodeError) as exc:
        print("RELEASE_BUILD_SOURCE_IDENTITY_REJECTED=" + type(exc).__name__, file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
