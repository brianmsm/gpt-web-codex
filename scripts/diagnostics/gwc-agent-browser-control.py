#!/usr/bin/python3
"""Private on-demand GWC Agent browser, independent of the launching terminal.

Chrome DevTools MCP remains in --browserUrl=http://127.0.0.1:9333 mode.
No changes to the GWC core, session policy, tunnels, keys, scientific outputs
or Chrome MCP registry are necessary for explicit wake via GWC terminal_exec.

--install    Install a disabled systemd user service and stable controller.
--status     Print whether port/CDP and service are ready.
--start      Start the user service on demand and wait for CDP.
--port-free  Internal systemd ExecCondition; skip if another process owns 9333.
--check-owned  Exit 0 only for the managed GWC Agent profile/port/OS socket.

Manual or otherwise unowned CDP listeners are refused (fail closed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
from urllib.parse import urlsplit

HOME = Path.home()
PROFILE = HOME / ".local/share/gwc-browser-agent"
STORE = HOME / ".local/state/gwc-agent-browser"
LOCAL_CONTROLLER = STORE / "control.py"
SERVICE = HOME / ".config/systemd/user/gwc-agent-browser.service"
UNIT = "gwc-agent-browser.service"
BROWSER = Path("/usr/bin/chromium")
CDP_HOST = "127.0.0.1"
CDP_PORT = 9333
URL = f"http://{CDP_HOST}:{CDP_PORT}/json/version"
UNIT_TEXT = """[Unit]
Description=GWC Agent isolated Chromium (loopback CDP 9333)
Documentation=https://github.com/brianmsm/gpt-web-codex/blob/main/docs/chrome-browser.md
After=graphical-session.target
PartOf=graphical-session.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
ExecCondition=/usr/bin/python3 -B %h/.local/state/gwc-agent-browser/control.py --port-free
ExecStart=/usr/bin/chromium --user-data-dir=%h/.local/share/gwc-browser-agent --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 --new-window about:blank
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=graphical-session.target
"""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def private_dir(p: Path, *, create: bool = False) -> None:
    if p.is_symlink():
        raise RuntimeError("Refusing symlinked directory")
    if create:
        p.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not p.is_dir() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077:
        raise RuntimeError("Browser controller/profile directory is absent or not private")


def private_existing(p: Path) -> bytes:
    if p.is_symlink() or not p.is_file() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077:
        raise RuntimeError("Existing private controller file is not trusted")
    return p.read_bytes()


def private_create(p: Path, content: bytes) -> None:
    if p.exists() or p.is_symlink():
        if private_existing(p) != content:
            raise RuntimeError("Existing browser management file differs; refusing overwrite")
        return
    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def command(args: list[str], timeout: int = 12, allow_failure: bool = False) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("User service operation timed out") from exc
    if result.returncode != 0 and not allow_failure:
        raise RuntimeError("User service operation failed")
    return result


def unit_status() -> dict[str, str]:
    r = command(["systemctl", "--user", "show", UNIT, "--property=LoadState,ActiveState,SubState,Result,MainPID,ExecStart,FragmentPath"], timeout=8)
    return dict(line.split("=", 1) for line in r.stdout.decode().splitlines() if "=" in line)


def port_taken() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.65)
        return s.connect_ex((CDP_HOST, CDP_PORT)) == 0


def cdp_ok() -> bool:
    try:
        with urlopen(URL, timeout=1.3) as r:
            if r.status != 200:
                return False
            payload = json.loads(r.read(16384))
            if not str(payload.get("Browser", "")).startswith("Chrome/"):
                return False
            socket_url = urlsplit(str(payload.get("webSocketDebuggerUrl", "")))
            return (
                socket_url.scheme == "ws"
                and socket_url.hostname == CDP_HOST
                and socket_url.port == CDP_PORT
                and socket_url.path.startswith("/devtools/browser/")
                and not socket_url.username
                and not socket_url.password
                and not socket_url.fragment
            )
    except Exception:
        return False


def _cdp_listener_inodes(proc_root: Path = Path("/proc")) -> set[str]:
    """Accept exactly one IPv4 listener bound to 127.0.0.1:9333.

    A wildcard listener or another IPv6 listener on the same port is rejected.
    Socket inodes, unlike JSON version strings, identify kernel resources.
    """
    matched: set[str] = set()
    for family in ("tcp", "tcp6"):
        try:
            lines = (proc_root / "net" / family).read_text().splitlines()[1:]
        except (OSError, UnicodeError):
            return set()
        for line in lines:
            cols = line.split()
            if len(cols) < 10 or cols[3] != "0A":
                continue
            host, separator, port = cols[1].upper().partition(":")
            if separator != ":" or port != f"{CDP_PORT:04X}":
                continue
            if family != "tcp" or host != "0100007F":
                return set()
            if not cols[9].isdigit() or cols[9] == "0":
                return set()
            matched.add(cols[9])
    return matched if len(matched) == 1 else set()


def _verified_service_argv(status: dict[str, str]) -> list[str] | None:
    """Use systemd's recorded ExecStart, not Chromium's mutable process title."""
    if status.get("FragmentPath") != str(SERVICE):
        return None
    try:
        if SERVICE.is_symlink() or not SERVICE.is_file():
            return None
        fs = SERVICE.stat()
        if fs.st_uid != os.getuid() or fs.st_mode & 0o077:
            return None
        # Fail closed if an old or mutated unit is installed: re-installing a
        # reviewed service must be an explicit administrator-controlled action.
        if SERVICE.read_bytes() != UNIT_TEXT.encode():
            return None
    except OSError:
        return None
    config = status.get("ExecStart", "")
    if config.count("argv[]=") != 1:
        return None
    raw = config.split("argv[]=", 1)[1].split(" ;", 1)[0].strip()
    try:
        argv = shlex.split(raw)
    except ValueError:
        return None
    if not argv or argv[0] != str(BROWSER):
        return None
    required = (
        f"--user-data-dir={PROFILE}",
        f"--remote-debugging-address={CDP_HOST}",
        f"--remote-debugging-port={CDP_PORT}",
    )
    if any(argv.count(arg) != 1 for arg in required):
        return None
    for name in ("--user-data-dir", "--remote-debugging-address",
                 "--remote-debugging-port"):
        if sum(arg == name or arg.startswith(name + "=") for arg in argv) != 1:
            return None
    return argv


def _owned_listener_process(status: dict[str, str],
                            proc_root: Path = Path("/proc")) -> bool:
    """Match systemd process identity, its exact private unit and socket FD.

    Chromium may overwrite /proc/PID/cmdline and migrate itself into a
    graphical scope, so neither a mutable process title nor cgroup ancestry
    is reliable. Instead, validate the trusted loaded ExecStart, active
    MainPID, OS user and FD belonging to the loopback kernel listener.
    This is not isolation from a malicious process with the same Linux UID.
    """
    if sys.platform != "linux":
        return False
    if status.get("LoadState") != "loaded" or status.get("ActiveState") != "active":
        return False
    if _verified_service_argv(status) is None:
        return False
    pid = status.get("MainPID", "")
    if not pid.isdecimal() or int(pid) < 1:
        return False
    master = proc_root / pid
    try:
        if master.stat().st_uid != os.getuid():
            return False
        real_browser = Path(os.readlink(master / "exe")).name.lower()
        if not real_browser.startswith(("chromium", "chrome")):
            return False
        inodes = _cdp_listener_inodes(proc_root)
        if not inodes:
            return False
        # The systemd MainPID must own this exact kernel CDP socket, not an
        # unrelated process with a plausible /json/version response.
        for fd in (master / "fd").iterdir():
            try:
                dest = os.readlink(fd)
            except OSError:
                continue
            if dest.startswith("socket:[") and dest.endswith("]"):
                if dest[8:-1] in inodes:
                    return True
    except (OSError, UnicodeError, ValueError):
        return False
    return False


def owned_cdp_ready(status: dict[str, str] | None = None,
                    proc_root: Path = Path("/proc")) -> bool:
    """Reject any Chrome-shaped CDP listener without unit/profile ownership."""
    try:
        private_dir(PROFILE)
        live = unit_status() if status is None else status
        return _owned_listener_process(live, proc_root) and cdp_ok()
    except (OSError, RuntimeError):
        return False


def preflight_files() -> None:
    private_dir(PROFILE)
    if not BROWSER.is_file() or not os.access(BROWSER, os.X_OK):
        raise RuntimeError("System Chromium executable unavailable")
    private_dir(STORE, create=True)
    if SERVICE.parent.is_symlink() or not SERVICE.parent.is_dir() or SERVICE.parent.stat().st_uid!=os.getuid() or SERVICE.parent.stat().st_mode & 0o022:
        raise RuntimeError("Systemd user unit directory is not user-owned or is group/world-writable")


def install() -> None:
    preflight_files()
    if SERVICE.is_symlink() or LOCAL_CONTROLLER.is_symlink():
        raise RuntimeError("Refuse linked browser service/controller")
    source = Path(__file__).resolve()
    source_bytes = source.read_bytes()
    private_create(LOCAL_CONTROLLER, source_bytes)
    private_create(SERVICE, UNIT_TEXT.encode())
    command(["systemctl", "--user", "daemon-reload"], timeout=12)
    status = unit_status()
    if status.get("LoadState") != "loaded":
        raise RuntimeError("Browser user unit did not load")
    enabled = command(["systemctl", "--user", "is-enabled", UNIT], allow_failure=True).stdout.decode().strip()
    if enabled != "disabled":
        raise RuntimeError("On-demand browser service must remain disabled at login")
    print("GWC_AGENT_BROWSER_USER_UNIT_INSTALLED=YES")
    print("GWC_AGENT_BROWSER_AUTO_START_AT_LOGIN=NO")
    print("GWC_AGENT_BROWSER_EXPLICIT_WAKE_AVAILABLE=YES")
    print("GWC_PROTECTED_MAIN_UNMODIFIED=YES")


def status() -> None:
    unit = unit_status()
    owned = owned_cdp_ready(unit)
    occupied = port_taken()
    print("GWC_AGENT_BROWSER_SYSTEMD_STATE=" + unit.get("ActiveState", "unknown"))
    print("GWC_AGENT_BROWSER_CDP_READY=" + str(owned).lower())
    print("GWC_AGENT_BROWSER_PORT_IN_USE=" + str(occupied).lower())
    print("GWC_AGENT_BROWSER_OWNER_MODE=" + (
        "systemd" if owned else "untrusted_or_manual" if occupied else "stopped"))


def wake() -> None:
    preflight_files()
    unit = unit_status()
    if unit.get("LoadState") != "loaded":
        raise RuntimeError("GWC Agent browser service not installed")
    if port_taken():
        if not owned_cdp_ready(unit):
            raise RuntimeError("CDP port occupied by a foreign or unowned browser")
        print("GWC_AGENT_BROWSER_READY_SYSTEMD=YES")
        return
    if unit.get("ActiveState") != "active":
        command(["systemctl", "--user", "start", UNIT], timeout=18)
    until = time.monotonic() + 25
    while time.monotonic() < until:
        unit = unit_status()
        if owned_cdp_ready(unit):
            print("GWC_AGENT_BROWSER_READY_SYSTEMD=YES")
            print("GWC_AGENT_BROWSER_CDP_9333=HTTP_200")
            return
        if unit.get("ActiveState") in ("failed", "inactive"):
            raise RuntimeError("User browser service stopped before owned CDP became available")
        time.sleep(0.8)
    raise RuntimeError("Browser service did not prove owned CDP within 25 seconds")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--install", action="store_true")
    group.add_argument("--status", action="store_true")
    group.add_argument("--start", action="store_true")
    group.add_argument("--port-free", action="store_true")
    group.add_argument("--check-owned", action="store_true")
    opts = parser.parse_args()
    if opts.port_free:
        # systemd ExecCondition: exit 1-254 skips unit start without claiming
        # or perturbing an existing manually-started browser profile.
        private_dir(PROFILE)
        if port_taken():
            sys.exit(1)
        return
    if opts.check_owned:
        if not owned_cdp_ready():
            sys.exit(1)
        return
    if opts.install:
        install()
    elif opts.status:
        status()
    elif opts.start:
        wake()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as e:
        print("GWC_AGENT_BROWSER_ERROR_CLASS="+type(e).__name__, file=sys.stderr)
        sys.exit(2)
