#!/usr/bin/python3
"""Supervisor-only enrollment of one ChatGPT conversation into one synthetic MCP.

The CLI never receives raw openai/session metadata, secret keys or rater data.
Copy the opaque session_fingerprint returned by study_identity from the intended
ChatGPT conversation. A role-specific local HMAC prevents trivial cross-role
fingerprint reuse, but does NOT authenticate arbitrary raw MCP clients.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Iterator

DEFAULT_LAB = Path.home() / ".local/state/gwc-synthetic-ab-connectors"
FINGERPRINT = re.compile(r"rater-session:(A|B):[a-f0-9]{64}\Z")


def private_file(path: Path, *, expected_size: int | None = None) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Supervisor binding file must be a regular file (no symlink)")
    st = path.stat()
    if os.name != "nt" and (st.st_uid != os.getuid() or st.st_mode & 0o077):
        raise ValueError("Supervisor binding file must be owned by user and private")
    if expected_size is not None and st.st_size != expected_size:
        raise ValueError("Role-specific identity key has incorrect size")


def private_dir(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise ValueError("Supervisor binding directory must be a real directory")
    st = path.stat()
    if os.name != "nt" and (st.st_uid != os.getuid() or st.st_mode & 0o077):
        raise ValueError("Supervisor binding directory must be private")


@contextmanager
def exclusive_lock(folder: Path) -> Iterator[None]:
    lock = folder / "session-binding.lock"
    if lock.exists() or lock.is_symlink():
        raise ValueError("An enrollment is already running or its lock requires manual inspection")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise ValueError("Concurrent enrollment refused") from exc
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, b"ADMIN_ENROLLMENT_IN_PROGRESS\n")
        yield
    finally:
        os.close(fd)
        lock.unlink()


def bind(role: str, base: Path, fingerprint: str | None, replace: bool,
         clear: bool = False) -> dict[str, object]:
    base = base.expanduser().absolute()
    private_dir(base)
    folder = base / role
    private_dir(folder)
    binding = folder / "authorized-session.txt"
    private_file(binding)
    private_file(folder / "session-identity-hmac.key", expected_size=32)
    if not clear and fingerprint is not None and (
        FINGERPRINT.fullmatch(fingerprint) is None
        or not fingerprint.startswith("rater-session:" + role + ":")
    ):
        raise ValueError("Fingerprint does not belong to the selected role")
    if clear and not replace:
        raise ValueError("Clearing a binding requires --replace")
    if fingerprint is None and not clear:
        return {
            "role": role,
            "bound": bool(binding.read_text(encoding="utf8").strip()),
            "enrollment_supervisor_only": True,
            "hot_reload_of_binding": True,
        }
    next_value = "" if clear else str(fingerprint)
    with exclusive_lock(folder):
        private_file(binding)
        current = binding.read_text(encoding="utf8").strip()
        if current and current != next_value and not replace:
            raise ValueError("Conversation is already bound; use --replace for an explicit change")
        if current and (FINGERPRINT.fullmatch(current) is None
                        or not current.startswith("rater-session:" + role + ":")):
            raise ValueError("Current binding is invalid; refuse to overwrite without investigation")
        fd, staged = tempfile.mkstemp(prefix=".session-binding-", suffix=".tmp", dir=folder)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf8") as stream:
                stream.write(next_value + ("\n" if next_value else ""))
                stream.flush()
                os.fsync(stream.fileno())
            private_file(binding)
            os.replace(staged, binding)
            # Best effort directory durability; the atomic rename already completed.
            try:
                dirfd = os.open(folder, os.O_RDONLY)
                try:
                    os.fsync(dirfd)
                finally:
                    os.close(dirfd)
            except OSError:
                pass
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(staged)
            except OSError:
                pass
            raise
    return {
        "role": role,
        "bound": bool(next_value),
        "enrollment_supervisor_only": True,
        "hot_reload_of_binding": True,
        "binding_changed": current != next_value,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", required=True, choices=["A", "B"])
    parser.add_argument("--lab-dir", type=Path, default=DEFAULT_LAB)
    parser.add_argument("--fingerprint",
                        help="Opaque role-specific token returned by study_identity in the intended chat")
    parser.add_argument("--replace", action="store_true", help="Explicitly replace an existing binding")
    parser.add_argument("--clear", action="store_true", help="Explicitly unbind the role")
    args = parser.parse_args()
    if args.clear and args.fingerprint:
        parser.error("--clear cannot be combined with --fingerprint")
    outcome = bind(args.role, args.lab_dir, args.fingerprint, args.replace, args.clear)
    for key, value in outcome.items():
        print(f"{key}={str(value).lower() if isinstance(value, bool) else value}")
    print("Never treat openai/session as cryptographic authentication at an untrusted MCP endpoint.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError) as exc:
        print("SUPERVISOR ENROLLMENT REFUSED: " + str(exc), file=sys.stderr)
        sys.exit(2)
