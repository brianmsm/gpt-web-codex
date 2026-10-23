#!/usr/bin/env python3
"""Stage a single-maintainer GitHub Release draft (never publish automatically).

Use GitHub CLI for transport; never create/move tags or retry uncertain uploads.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+\Z")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


class ReleaseError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def command(args: list[str], *, timeout: int = 30) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise ReleaseError("Command failed: " + args[0] +
                           "; inspect the draft manually before retrying")
    return result.stdout.strip()


def api(path: str):
    response = command(["gh", "api", path])
    try:
        data = json.loads(response)
        require(isinstance(data, (dict, list)), "Unexpected GitHub API response type")
        return data
    except (ValueError, UnicodeError) as exc:
        raise ReleaseError("Unexpected GitHub API response") from exc


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def inventory(directory: Path) -> dict[str, tuple[str, int]]:
    require(directory.is_dir() and not directory.is_symlink(), "Unsafe assets directory")
    files = list(directory.iterdir())
    require(2 <= len(files) < 100, "Unexpected asset count")
    for path in files:
        require(path.is_file() and not path.is_symlink() and bool(NAME.fullmatch(path.name)),
                "Unsafe release asset path")
    manifest = directory / "checksums.txt"
    require(manifest.is_file() and manifest.stat().st_size <= 65536,
            "Missing or oversized checksum manifest")
    lines = manifest.read_text(encoding="ascii").splitlines()
    expected = {}
    for line in lines:
        require(len(line) >= 67 and line[64:66] == "  " and bool(DIGEST.fullmatch(line[:64]))
                and bool(NAME.fullmatch(line[66:])), "Malformed checksum entry")
        name = line[66:]
        require(name not in expected and name != "checksums.txt",
                "Duplicate/self-referencing checksum")
        expected[name] = line[:64]
    require(set(expected) == {path.name for path in files} - {"checksums.txt"},
            "Incomplete or unexpected checksum inventory")
    observed = {}
    for path in files:
        if path.name != "checksums.txt":
            digest = hash_file(path)
            require(digest == expected[path.name], "Release checksum mismatch")
            observed[path.name] = (digest, path.stat().st_size)
    return observed


def context() -> tuple[str, str, str]:
    repo = os.getenv("GITHUB_REPOSITORY", "")
    tag = os.getenv("GITHUB_REF_NAME", "")
    sha = os.getenv("GITHUB_SHA", "")
    require(bool(REPO.fullmatch(repo)) and bool(TAG.fullmatch(tag))
            and bool(SHA.fullmatch(sha)) and os.getenv("GITHUB_REF_TYPE") == "tag"
            and bool(os.getenv("GH_TOKEN")), "Invalid release event or missing GitHub token")
    version = json.loads(Path("package.json").read_text())["version"]
    require(tag == "v" + version, "Tag differs from package version")
    require(command(["git", "rev-parse", "HEAD"]) == sha,
            "Checkout differs from tag event")
    main = api(f"repos/{repo}/branches/main")
    require(isinstance(main, dict) and isinstance(main.get("commit"), dict)
            and main["commit"].get("sha") == sha,
            "Release tag must target the current public main HEAD")

    ref = api(f"repos/{repo}/git/ref/tags/{tag}")
    require(isinstance(ref, dict) and ref.get("ref") == "refs/tags/" + tag,
            "Remote tag not found")
    obj = ref.get("object", {})
    kind, oid = obj.get("type"), obj.get("sha")
    require(isinstance(oid, str) and SHA.fullmatch(oid) is not None,
            "Invalid remote tag object")
    if kind == "tag":
        annotation = api(f"repos/{repo}/git/tags/{oid}")
        require(isinstance(annotation, dict) and annotation.get("tag") == tag,
                "Annotated tag name mismatch")
        obj = annotation.get("object", {})
        kind, oid = obj.get("type"), obj.get("sha")
    require(kind == "commit" and oid == sha,
            "Remote tag does not resolve to approved main commit")
    return repo, tag, sha


def stage(directory: Path) -> int:
    # All checks precede the only remote mutation (gh release create).
    repo, tag, _sha = context()
    expected = inventory(directory)
    files = sorted(directory / name for name in expected)
    files.append(directory / "checksums.txt")
    command(["gh", "release", "create", tag, *(str(p) for p in files),
             "--repo", repo, "--draft", "--verify-tag", "--title", tag,
             "--generate-notes", "--latest=false"], timeout=3600)

    # This is best-effort postflight; failure leaves an uncertain DRAFT,
    # which must be inspected manually, not automatically retried.
    release = api(f"repos/{repo}/releases/tags/{tag}")
    ident = release.get("id")
    require(isinstance(release, dict) and release.get("draft") is True
            and release.get("tag_name") == tag
            and type(ident) is int and ident > 0, "Incorrect or published release")
    assets = api(f"repos/{repo}/releases/{ident}/assets?per_page=100")
    require(isinstance(assets, list) and len(assets) == len(files) and len(assets) < 100,
            "Unexpected remote asset inventory")
    all_files = dict(expected)
    all_files["checksums.txt"] = (hash_file(directory / "checksums.txt"),
                                  (directory / "checksums.txt").stat().st_size)
    remote = {}
    for asset in assets:
        require(isinstance(asset, dict), "Malformed remote asset entry")
        name, size, digest = asset.get("name"), asset.get("size"), asset.get("digest")
        require(type(name) is str and name not in remote
                and asset.get("state") == "uploaded" and type(size) is int
                and type(digest) is str and digest.startswith("sha256:"),
                "Missing or duplicate remote digest/asset")
        remote[name] = (digest[7:], size)
    require(remote == all_files, "Remote asset SHA-256/size/inventory differs")
    require(inventory(directory) == expected, "Local files changed during staging")
    print("DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=" + str(len(files)))
    print("DRAFT_STAGED_BINARY_DIGEST_VERIFIED=" + str(len(files)))
    print("RELEASE_STAGE_STATE=DRAFT_VERIFIED RELEASE_ID=" + str(ident))
    print("RELEASE_REQUIRES_MANUAL_PUBLICATION=true")
    return ident


def main() -> int:
    try:
        require(len(sys.argv) <= 2, "Usage: stage_release_draft.py [release-assets]")
        stage(Path(sys.argv[1] if len(sys.argv) == 2 else "release-assets"))
        return 0
    except (ReleaseError, OSError, KeyError, ValueError, UnicodeError,
            subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        # Never print subprocess output, exception representations, or tokens.
        print("RELEASE_DRAFT_BLOCKED: " + type(exc).__name__ +
              "; inspect GitHub drafts before any retry", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
