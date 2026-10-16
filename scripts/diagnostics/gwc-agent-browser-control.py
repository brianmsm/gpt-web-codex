#!/usr/bin/python3
"""Private on-demand GWC Agent browser, independent of the launching terminal.

Chrome DevTools MCP remains in --browserUrl=http://127.0.0.1:9333 mode.
No changes to the GWC core, session policy, tunnels, keys, scientific outputs
or Chrome MCP registry are necessary for explicit wake via GWC terminal_exec.

--install    Install a disabled systemd user service and stable controller.
--status     Print whether port/CDP and service are ready.
--start      Start the user service on demand and wait for CDP.
--port-free  Internal systemd ExecCondition; skip if another process owns 9333.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

HOME = Path.home()
PROFILE = HOME / ".local/share/gwc-browser-agent"
STORE = HOME / ".local/state/gwc-agent-browser"
LOCAL_CONTROLLER = STORE / "control.py"
SERVICE = HOME / ".config/systemd/user/gwc-agent-browser.service"
UNIT = "gwc-agent-browser.service"
BROWSER = Path("/usr/bin/chromium")
URL = "http://127.0.0.1:9333/json/version"
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
    r = command(["systemctl", "--user", "show", UNIT, "--property=LoadState,ActiveState,SubState,Result,MainPID"], timeout=8)
    return dict(line.split("=", 1) for line in r.stdout.decode().splitlines() if "=" in line)


def port_taken() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.65)
        return s.connect_ex(("127.0.0.1", 9333)) == 0


def cdp_ok() -> bool:
    try:
        with urlopen(URL, timeout=1.3) as r:
            if r.status != 200:
                return False
            payload = json.loads(r.read(16384))
            return bool(payload.get("webSocketDebuggerUrl")) and payload.get("Browser", "").startswith("Chrome/")
    except Exception:
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
    print("GWC_AGENT_BROWSER_SYSTEMD_STATE="+unit.get("ActiveState", "unknown"))
    print("GWC_AGENT_BROWSER_CDP_READY="+str(cdp_ok()).lower())
    print("GWC_AGENT_BROWSER_PORT_IN_USE="+str(port_taken()).lower())
    print("GWC_AGENT_BROWSER_OWNER_MODE="+(
        "systemd" if unit.get("ActiveState")=="active" else "external_manual" if cdp_ok() else "stopped"))


def wake() -> None:
    preflight_files()
    unit = unit_status()
    if unit.get("LoadState") != "loaded":
        raise RuntimeError("GWC Agent browser service not installed")
    if cdp_ok():
        if unit.get("ActiveState")=="active":
            print("GWC_AGENT_BROWSER_READY_SYSTEMD=YES")
        else:
            print("GWC_AGENT_BROWSER_READY_EXISTING_MANUAL=YES")
            print("GWC_AGENT_BROWSER_MANAGED_BY_SYSTEMD=NO")
        return
    if port_taken():
        raise RuntimeError("CDP 9333 port is occupied by an unexpected service")
    if unit.get("ActiveState")!="active":
        command(["systemctl", "--user", "start", UNIT], timeout=18)
    until = time.monotonic()+25
    while time.monotonic()<until:
        if cdp_ok() and unit_status().get("ActiveState")=="active":
            print("GWC_AGENT_BROWSER_READY_SYSTEMD=YES")
            print("GWC_AGENT_BROWSER_CDP_9333=HTTP_200")
            return
        if unit_status().get("ActiveState") in ("failed","inactive"):
            raise RuntimeError("User browser service stopped before CDP became available")
        time.sleep(0.8)
    raise RuntimeError("Browser service did not become ready within 25 seconds")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--install", action="store_true")
    group.add_argument("--status", action="store_true")
    group.add_argument("--start", action="store_true")
    group.add_argument("--port-free", action="store_true")
    opts = parser.parse_args()
    if opts.port_free:
        # systemd ExecCondition: exit 1-254 skips unit start without claiming
        # or perturbing an existing manually-started browser profile.
        private_dir(PROFILE)
        if port_taken():
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
