#!/usr/bin/python3
"""Create TWO standalone, role-specific MCP wrappers with SYNTHETIC data only.

This is a ChatGPT connector-isolation diagnostic, NOT an assessor release.
No tunnel is contacted and no credentials are created or used. The generic GWC
Session Capability Profiles engine remains independent of this test fixture.
"""
from __future__ import annotations

import argparse
import secrets
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys

PROJECT = Path(__file__).resolve().parents[2]
FIXTURE = PROJECT / "tests/fixtures/session-rater-stdio.ts"
LOCKED_FIXTURE = PROJECT / "tests/fixtures/session-bound-rater-stdio.ts"
LOCKED_GUARD = PROJECT / "src/standalone/session-capabilities/role-session-guard.ts"
DEFAULT_LAB = Path.home() / ".local/state/gwc-synthetic-ab-connectors"
ROLES = ("A", "B")
TOOLS = (
    "study_identity", "get_case_plan", "list_materials", "read_material",
    "current_drafts", "save_artifact", "seal_submission",
)


def safe_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"Directory is a symbolic link: {path}")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not path.is_dir() or path.is_symlink():
        raise ValueError(f"Directory is not a real directory: {path}")
    path.chmod(0o700)


def private_file(path: Path, content: str = "", executable: bool = False) -> None:
    if path.is_symlink():
        raise ValueError(f"Refusing symlink: {path}")
    if path.exists():
        if not path.is_file():
            raise ValueError(f"Not a regular file: {path}")
        if executable and path.read_text() != content:
            raise ValueError(f"Existing launcher differs from frozen version: {path}")
    else:
        # Mode is set with fchmod; do not inherit a permissive process umask.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchmod(fd, 0o700 if executable else 0o600)
            with os.fdopen(fd, "w", encoding="utf8") as stream:
                stream.write(content)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
    path.chmod(0o700 if executable else 0o600)


def launcher(role: str, fixture_sha: str, bun: Path, fixture: Path, output: Path) -> str:
    # Executable Python wrapper: absolute paths, no shell interpretation and
    # no secrets inherited from the tunnel-client runtime environment.
    return """#!/usr/bin/python3
import hashlib
import os
import pathlib
import sys
ROLE = %r
BUN = %r
FIXTURE = %r
SHA = %r
OUTPUT = %r
source = pathlib.Path(FIXTURE)
output = pathlib.Path(OUTPUT)
if source.is_symlink() or not source.is_file():
    sys.exit('Trusted synthetic MCP fixture missing or symlinked')
if hashlib.sha256(source.read_bytes()).hexdigest() != SHA:
    sys.exit('Trusted synthetic MCP fixture changed; refuse execution')
if output.is_symlink() or not output.is_dir():
    sys.exit('Private synthetic output directory is unavailable')
os.execve(BUN, [BUN, FIXTURE], {
    'PATH': '/usr/bin:/bin',
    'HOME': '/nonexistent',
    'SYNTHETIC_RATER_ROLE': ROLE,
    'SYNTHETIC_RATER_OUTPUT': OUTPUT,
})
""" % (role, str(bun), str(fixture), fixture_sha, str(output))


def locked_launcher(role: str, bun: Path, fixture_sha: str, guard_sha: str,
                    output: Path, key: Path, binding: Path) -> str:
    # Private wrapper pins both implementation files before starting Bun.
    # Keep this file different from the old run-mcp.py: the existing A/B
    # tunnel runtimes remain untouched until the operator switches them.
    return """#!/usr/bin/python3
import hashlib
import os
import pathlib
import sys
ROLE = %r
BUN = %r
FIXTURE = %r
FIXTURE_SHA = %r
GUARD = %r
GUARD_SHA = %r
OUTPUT = %r
KEY = %r
BINDING = %r
for path_str, digest in ((FIXTURE, FIXTURE_SHA), (GUARD, GUARD_SHA)):
    path = pathlib.Path(path_str)
    if path.is_symlink() or not path.is_file():
        sys.exit('Expected trusted synthetic runtime source file is unavailable')
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        sys.exit('Trusted synthetic runtime code changed; refuse to start')
for private_file, expected_bytes in ((KEY, 32), (BINDING, None)):
    path = pathlib.Path(private_file)
    if not path.is_file() or path.is_symlink():
        sys.exit('Private role session policy is unavailable')
    st = path.stat()
    if st.st_uid != os.getuid() or st.st_mode & 0o077:
        sys.exit('Private role session policy must be owned by runtime user with mode 0600')
    if expected_bytes is not None and st.st_size != expected_bytes:
        sys.exit('Private role identity key must be exactly 32 bytes')
output = pathlib.Path(OUTPUT)
if output.is_symlink() or not output.is_dir():
    sys.exit('Private synthetic output directory is unavailable')
os.execve(BUN, [BUN, FIXTURE], {
    'PATH': '/usr/bin:/bin',
    'HOME': '/nonexistent',
    'SYNTHETIC_RATER_ROLE': ROLE,
    'SYNTHETIC_RATER_OUTPUT': OUTPUT,
    'GWC_SYNTHETIC_PRIVATE_IDENTITY_KEY_FILE': KEY,
    'GWC_SYNTHETIC_SESSION_BINDING_FILE': BINDING,
})
""" % (role, str(bun), str(LOCKED_FIXTURE), fixture_sha,
         str(LOCKED_GUARD), guard_sha, str(output), str(key), str(binding))


def private_random_key(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"Refusing symlink for private key: {path}")
    if path.exists():
        if not path.is_file():
            raise ValueError("Role HMAC identity key must be a regular file")
        st = path.stat()
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise ValueError("Role HMAC identity key must be private and user-owned")
        if st.st_size != 32:
            raise ValueError("Role HMAC identity key must contain exactly 32 random bytes")
    else:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(secrets.token_bytes(32))
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise


def prepare(base: Path, bun: Path) -> dict:
    base = base.expanduser().absolute()
    if base == PROJECT or PROJECT in base.parents:
        raise ValueError("Do not store runtime keys or synthetic lab state inside the GWC Git checkout")
    for source in (FIXTURE, LOCKED_FIXTURE, LOCKED_GUARD):
        if not source.is_file() or source.is_symlink():
            raise ValueError("Synthetic MCP trusted implementation unavailable")
    if not bun.is_file() or not os.access(bun, os.X_OK):
        raise ValueError("Bun executable unavailable")
    safe_directory(base)
    fixture_sha = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    locked_sha = hashlib.sha256(LOCKED_FIXTURE.read_bytes()).hexdigest()
    guard_sha = hashlib.sha256(LOCKED_GUARD.read_bytes()).hexdigest()
    entries = {}
    for role in ROLES:
        folder = base / role
        safe_directory(folder)
        output = folder / "output"
        safe_directory(output)
        private_file(folder / "tunnel-id.txt")
        private_file(folder / "runtime-key.txt")
        wrapper = folder / "run-mcp.py"
        private_file(wrapper, launcher(role, fixture_sha, bun, FIXTURE, output), executable=True)
        key_file = folder / "session-identity-hmac.key"
        private_random_key(key_file)
        binding_file = folder / "authorized-session.txt"
        private_file(binding_file)
        locked_wrapper = folder / "run-mcp-locked.py"
        private_file(locked_wrapper, locked_launcher(role, bun, locked_sha, guard_sha,
            output, key_file, binding_file), executable=True)
        entries[role] = {
            "runtime_alias": f"gwc-synthetic-rater-{role.lower()}",
            "runtime_profile": f"gwc-synthetic-rater-{role.lower()}",
            "mcp_command": str(wrapper),
            "locked_mcp_command": str(locked_wrapper),
            "session_binding_file": str(binding_file),
            "tunnel_id_file": str(folder / "tunnel-id.txt"),
            "runtime_key_file": str(folder / "runtime-key.txt"),
            "output_directory": str(output),
        }
    # No credentials, scientific source paths, or raw model responses in manifest.
    manifest = base / "manifest.json"
    manifest_data = {"schema": "gwc-synthetic-ab-connectors/v1", "synthetic_only": True,
                     "source_fixture_sha256": fixture_sha, "expected_tools": list(TOOLS), "roles": entries}
    if manifest.exists():
        existing_manifest = json.loads(manifest.read_text())
        # Upgrade a pre-existing test lab from the unbound test fixture to a
        # *staged* locked wrapper without editing its running run-mcp.py.
        for role in ROLES:
            original = {k: v for k, v in entries[role].items()
                        if k not in ("locked_mcp_command", "session_binding_file")}
            if existing_manifest.get("roles", {}).get(role) != original:
                raise ValueError("Existing role config differs; refuse to overwrite it")
        original_manifest = {k: v for k, v in manifest_data.items() if k != "roles"}
        original_existing = {k: v for k, v in existing_manifest.items() if k != "roles"}
        if original_manifest != original_existing:
            raise ValueError("Existing synthetic connector manifest differs; refuse to overwrite")
        # Keep the previous manifest unchanged while the running runtimes are
        # still using old role wrappers. Locked paths are published only in
        # the machine-readable dry-run output and separate explicit docs.
    else:
        private_file(manifest, json.dumps(manifest_data, indent=2) + "\n")
    return manifest_data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lab-dir", type=Path, default=DEFAULT_LAB)
    parser.add_argument("--bun", type=Path, default=None)
    args = parser.parse_args()
    default_bun = Path.home() / ".local/share/mise/installs/bun/1.3.14/bin/bun"
    bun = args.bun or (default_bun if default_bun.is_file() else Path(shutil.which("bun") or ""))
    info = prepare(args.lab_dir, bun)
    print("SYNTHETIC_ONLY_PREPARED")
    print("LAB_DIR=" + str(args.lab_dir.expanduser().absolute()))
    for role in ROLES:
        print(role + "_TUNNEL_ID_FILE=" + info["roles"][role]["tunnel_id_file"])
        print(role + "_RUNTIME_KEY_FILE=" + info["roles"][role]["runtime_key_file"])
        print(role + "_MCP_COMMAND=" + info["roles"][role]["mcp_command"])
        print(role + "_LOCKED_MCP_COMMAND=" + info["roles"][role]["locked_mcp_command"])
        print(role + "_BINDING_FILE=" + info["roles"][role]["session_binding_file"])
    print("Existing runtimes are UNCHANGED. The locked wrappers are staged only.")
    print("No tunnel/runtime was started. Do not use real scientific input in this synthetic lab.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print("SYNTHETIC LAB PREPARE REJECTED: " + str(exc), file=sys.stderr)
        sys.exit(2)
