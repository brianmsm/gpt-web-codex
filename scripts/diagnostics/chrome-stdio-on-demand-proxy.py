#!/usr/bin/python3
"""On-demand GWC Agent browser wake for authorized Chrome MCP tools/call requests.

Transparently relays MCP stdio JSON-RPC to a pinned Chrome DevTools MCP child.
Only for an already policy-authorized "chrome" external MCP server. It checks
CDP availability before passing ANY tools/call request, and wakes the
non-autostart GWC Agent systemd user service if the profile is closed.

No write to GWC session policy/config, Chrome profile, login data or
scientific repositories. A wake failure returns a tool-level error WITHOUT
forwarding the requested browser operation. In particular, this wrapper
NEVER blindly retries a browser tool call after an uncertain result.

The pinned child package/connection flags are validated rather than accepting
arbitrary user-supplied commands. This is an MCP stdio byte relay, not a full
MCP JSON-RPC implementation; it only examines request framing and delegates
all other semantics to the original Chrome DevTools MCP implementation.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import BinaryIO
from urllib.request import urlopen

HOME = Path.home()
CONTROL = HOME / ".local/state/gwc-agent-browser/control.py"
URL = "http://127.0.0.1:9333/json/version"
CHILD_ARGS = (
    "-y",
    "chrome-devtools-mcp@1.10.1",
    "--browserUrl=http://127.0.0.1:9333",
    "--redactNetworkHeaders",
    "--no-usage-statistics",
)
MAX_MCP_LINE = 12 * 1024 * 1024
WAKE_TIMEOUT = 42
SAFE_FAIL_MESSAGE = (
    "GWC Agent browser unavailable; automatic wake via "
    "gwc-agent-browser.service did not succeed. Browser operation was not "
    "executed. Inspect the browser user service and retry only when ready."
)


def cdp_ready() -> bool:
    try:
        with urlopen(URL, timeout=1.5) as result:
            if result.status != 200:
                return False
            obj = json.loads(result.read(16384))
            return bool(obj.get("webSocketDebuggerUrl")) and str(obj.get("Browser", "")).startswith("Chrome/")
    except (OSError, ValueError, TimeoutError):
        return False


def _controlled_browser_check(action: str, timeout: int) -> bool:
    # Never accept the remote CDP /json/version as an identity claim.
    # The private controller verifies the active systemd service, profile,
    # service cgroup, and OS socket listener before authorizing the bridge.
    if CONTROL.is_symlink() or not CONTROL.is_file():
        return False
    try:
        st = CONTROL.stat()
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            return False
        result = subprocess.run(
            ["/usr/bin/python3", "-B", str(CONTROL), action],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def wake_browser() -> bool:
    if cdp_ready():
        # A random Chrome on :9333 must not be trusted, even if it is valid CDP.
        return _controlled_browser_check("--check-owned", timeout=8)
    if not _controlled_browser_check("--start", timeout=WAKE_TIMEOUT):
        return False
    return cdp_ready() and _controlled_browser_check("--check-owned", timeout=8)


def parse_tool_call(line: bytes) -> tuple[bool, object]:
    """Return (is_tools_call, id). Never interpret or mutate browser arguments."""
    if len(line) > MAX_MCP_LINE or not line.endswith(b"\n"):
        raise ValueError("Oversized or unterminated MCP stdio message")
    try:
        payload = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("Invalid MCP JSON-RPC message") from None
    if not isinstance(payload, dict):
        raise ValueError("Invalid MCP JSON-RPC object")
    if payload.get("method") == "tools/call":
        if "id" not in payload or not isinstance(payload["id"], (str, int)) or isinstance(payload["id"], bool):
            raise ValueError("MCP tools/call request without valid id")
        return True, payload["id"]
    return False, None


def fail_response(request_id: str | int) -> bytes:
    """MCP CallToolResult of isError=true, preserving JSON-RPC request identity."""
    return (
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": SAFE_FAIL_MESSAGE}],
                    "isError": True,
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf8")
        + b"\n"
    )


class OutputRelay:
    def __init__(self, output: BinaryIO) -> None:
        self._output = output
        self._lock = threading.Lock()
        self.broken = threading.Event()

    def write(self, data: bytes) -> None:
        if self.broken.is_set():
            raise BrokenPipeError
        with self._lock:
            try:
                self._output.write(data)
                self._output.flush()
            except (BrokenPipeError, OSError):
                self.broken.set()
                raise


def relay_stdout(child: subprocess.Popen[bytes], output: OutputRelay) -> None:
    if child.stdout is None:
        output.broken.set()
        return
    try:
        for line in child.stdout:
            if len(line) > MAX_MCP_LINE:
                output.broken.set()
                break
            output.write(line)
    except (BrokenPipeError, OSError, ValueError):
        output.broken.set()


def stop_child(child: subprocess.Popen[bytes]) -> None:
    if child.poll() is not None:
        return
    # npx spawns its own node child. Kill its isolated process group so the
    # Chrome MCP backend cannot survive a parent transport disconnect.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass


def relay(stdin: BinaryIO, stdout: BinaryIO, backend: tuple[str, ...]) -> None:
    executable = shutil.which("npx")
    if not executable or not os.path.isabs(executable):
        raise RuntimeError("Pinned Chrome MCP backend launcher npx is unavailable")
    child = subprocess.Popen(
        [executable, *backend],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        bufsize=0,
    )
    output = OutputRelay(stdout)
    worker = threading.Thread(target=relay_stdout, args=(child, output), daemon=True)
    worker.start()
    poll = selectors.DefaultSelector()
    try:
        # DO NOT combine selectors.select() with BufferedReader.readline().
        # The buffered reader may prefetch multiple JSON-RPC lines after the
        # first initialize request; a subsequent tools/list or tools/call can
        # then remain in its private buffer while select() waits forever.
        # Read the raw descriptor and frame the byte stream explicitly.
        stdin_fd = stdin.fileno()
        pending = bytearray()
        poll.register(stdin_fd, selectors.EVENT_READ)
        keep_running = True
        while keep_running and not output.broken.is_set() and child.poll() is None:
            if not poll.select(timeout=0.4):
                continue
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                break
            pending.extend(chunk)
            if len(pending) > MAX_MCP_LINE and b"\n" not in pending:
                break
            while True:
                end_of_line = pending.find(b"\n")
                if end_of_line < 0:
                    break
                incoming = bytes(pending[: end_of_line + 1])
                del pending[: end_of_line + 1]
                try:
                    is_browser_call, request_id = parse_tool_call(incoming)
                except ValueError:
                    # Protocol framing error: never forward unchecked request.
                    keep_running = False
                    break
                if is_browser_call and not wake_browser():
                    output.write(fail_response(request_id))  # type: ignore[arg-type]
                    continue
                if child.stdin is None:
                    keep_running = False
                    break
                try:
                    child.stdin.write(incoming)
                    child.stdin.flush()
                except (BrokenPipeError, OSError):
                    keep_running = False
                    break
    finally:
        poll.close()
        try:
            if child.stdin is not None:
                child.stdin.close()
        except OSError:
            pass
        stop_child(child)
        worker.join(timeout=3)


def main() -> None:
    if len(sys.argv) != len(CHILD_ARGS) + 2 or sys.argv[1] != "--" or tuple(sys.argv[2:]) != CHILD_ARGS:
        raise RuntimeError("Chrome MCP backend pin/args diverged from reviewed profile")
    # Protect against a newline protocol injection via CDP instructions: we
    # only ever invoke this fixed, local controller and then the pinned server.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    relay(sys.stdin.buffer, sys.stdout.buffer, CHILD_ARGS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        # Do not emit private browser profile paths, tool arguments or page URLs
        # to stdio/stderr. The stdio client detects process closure.
        print("GWC_CHROME_ON_DEMAND_PROXY_ERROR="+type(exc).__name__, file=sys.stderr)
        sys.exit(2)
