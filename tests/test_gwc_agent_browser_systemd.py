#!/usr/bin/python3
"""Adversarial, offline tests for GWC Agent user-service and OS socket identity."""
from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

F = Path(__file__).resolve().parents[1] / "scripts/diagnostics/gwc-agent-browser-control.py"
spec = importlib.util.spec_from_file_location("gwc_browser_owner", F)
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SocketFixture:
    """Synthetic /proc tree, no real browser/port or systemd interaction."""
    PID = "2468"
    INODE = "987654"

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gwc-cdp-owner-fixture-")
        self.root = Path(self.temp.name)
        (self.root / "net").mkdir()
        (self.root / "net" / "tcp").write_text(
            "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
            "0: 0100007F:2475 00000000:0000 0A 00000000:00000000 00:00000000 "
            "00000000 1000 0 987654 1 00000000\n"
        )
        (self.root / "net" / "tcp6").write_text(
            "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
        )
        self.browser = self.root / self.PID
        self.browser.mkdir()
        self.fd = self.browser / "fd"
        self.fd.mkdir()
        (self.browser / "exe").symlink_to("/usr/lib/chromium/chromium")
        self.unit_file = self.root / "gwc-agent-browser.service"
        self.unit_file.write_bytes(m.UNIT_TEXT.encode())
        self.unit_file.chmod(0o600)
        self._unit_patch = patch.object(m, "SERVICE", self.unit_file)
        self._unit_patch.__enter__()
        (self.fd / "11").symlink_to("socket:[987654]")
        (self.browser / "cgroup").write_text(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gwc-agent-browser.service\n"
        )
        self.write_args(
            "/usr/bin/chromium", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=9333", f"--user-data-dir={m.PROFILE}",
            "--new-window", "about:blank",
        )
        self.status = {
            "LoadState": "loaded", "ActiveState": "active", "MainPID": self.PID,
            "FragmentPath": str(self.unit_file),
            "ExecStart": "{ path=/usr/bin/chromium ; argv[]=/usr/bin/chromium "
                         f"--user-data-dir={m.PROFILE} "
                         "--remote-debugging-address=127.0.0.1 "
                         "--remote-debugging-port=9333 --new-window about:blank ; "
                         "ignore_errors=no ; start_time=[n/a] }",
        }
        return self

    def __exit__(self, *_):
        self._unit_patch.__exit__(None, None, None)
        self.temp.cleanup()

    def write_args(self, *args):
        (self.browser / "cmdline").write_bytes(b"\0".join(arg.encode() for arg in args) + b"\0")


class SystemdBrowserOwnershipTests(unittest.TestCase):
    def test_service_disabled_by_default_and_private_profile(self):
        self.assertIn("Type=exec", m.UNIT_TEXT)
        self.assertIn("Restart=on-failure", m.UNIT_TEXT)
        self.assertIn("After=graphical-session.target", m.UNIT_TEXT)
        self.assertIn("PartOf=graphical-session.target", m.UNIT_TEXT)
        self.assertIn("ExecCondition=", m.UNIT_TEXT)
        self.assertIn("--remote-debugging-address=127.0.0.1", m.UNIT_TEXT)
        self.assertIn("--remote-debugging-port=9333", m.UNIT_TEXT)
        self.assertIn("gwc-browser-agent", m.UNIT_TEXT)
        self.assertNotIn("WantedBy=default.target", m.UNIT_TEXT)
        self.assertNotIn("--incognito", m.UNIT_TEXT)

    def test_managed_pid_exact_profile_and_socket_are_required(self):
        with SocketFixture() as f:
            self.assertTrue(m._owned_listener_process(f.status, f.root))
            with patch.object(m, "cdp_ok", return_value=True):
                self.assertTrue(m.owned_cdp_ready(f.status, f.root))

    def test_wrong_profile_in_loaded_service_is_rejected_despite_valid_cdp(self):
        with SocketFixture() as f:
            f.status["ExecStart"] = f.status["ExecStart"].replace(
                f"--user-data-dir={m.PROFILE}", "--user-data-dir=/tmp/other-profile"
            )
            with patch.object(m, "cdp_ok", return_value=True):
                self.assertFalse(m.owned_cdp_ready(f.status, f.root))

    def test_chromium_process_title_rewrite_does_not_erase_systemd_identity(self):
        with SocketFixture() as f:
            f.write_args("/tmp/agent-profile --remote-debugging-port=9333 about:blank")
            self.assertTrue(m._owned_listener_process(f.status, f.root))

    def test_inactive_systemd_never_accepts_manual_profile_or_foreign_browser(self):
        with SocketFixture() as f:
            f.status["ActiveState"] = "inactive"
            with patch.object(m, "cdp_ok", return_value=True):
                self.assertFalse(m.owned_cdp_ready(f.status, f.root))

    def test_wrong_main_pid_or_mutated_unit_is_denied(self):
        with SocketFixture() as f:
            other = dict(f.status, MainPID="2469")
            self.assertFalse(m._owned_listener_process(other, f.root))
            f.unit_file.write_text("untrusted unit replaced after deployment")
            self.assertFalse(m._owned_listener_process(f.status, f.root))

    def test_wrong_socket_owner_in_another_process_is_denied(self):
        with SocketFixture() as f:
            (f.fd / "11").unlink()
            stranger = f.root / "2469"
            (stranger / "fd").mkdir(parents=True)
            (stranger / "fd" / "7").symlink_to("socket:[987654]")
            (stranger / "cgroup").write_text("0::/user.slice/unrelated.service\n")
            self.assertFalse(m._owned_listener_process(f.status, f.root))

    def test_invalid_websocket_endpoint_host_cannot_fake_chrome_identity(self):
        import json
        class Response:
            status = 200
            def __init__(self, uri):
                self.uri = uri
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, *_):
                return json.dumps({"Browser":"Chrome/150.0",
                    "webSocketDebuggerUrl": self.uri}).encode()
        for uri in (
            "ws://evil.example:9333/devtools/browser/anything",
            "ws://127.0.0.1:1337/devtools/browser/anything",
            "wss://127.0.0.1:9333/devtools/browser/anything",
            "ws://127.0.0.1:9333/not-the-devtools-browser",
        ):
            with self.subTest(uri=uri), patch.object(m, "urlopen", return_value=Response(uri)):
                self.assertFalse(m.cdp_ok())
        valid = "ws://127.0.0.1:9333/devtools/browser/synthetic-id"
        with patch.object(m, "urlopen", return_value=Response(valid)):
            self.assertTrue(m.cdp_ok())

    def test_wildcard_and_ipv6_debugging_listener_is_rejected(self):
        with SocketFixture() as f:
            table = f.root / "net" / "tcp"
            table.write_text(table.read_text().replace("0100007F:2475", "00000000:2475"))
            self.assertFalse(m._owned_listener_process(f.status, f.root))
        with SocketFixture() as f:
            (f.root / "net" / "tcp6").write_text(
                "header\n0: 00000000000000000000000000000000:2475 "
                "00000000000000000000000000000000:0000 0A 0:0 00:00000000 00000000 1000 0 999\n"
            )
            self.assertFalse(m._owned_listener_process(f.status, f.root))

    def test_manual_valid_cdp_must_fail_without_start_or_adoption(self):
        with (patch.object(m, "preflight_files"),
              patch.object(m, "unit_status", return_value={"LoadState":"loaded","ActiveState":"inactive"}),
              patch.object(m, "port_taken", return_value=True),
              patch.object(m, "owned_cdp_ready", return_value=False),
              patch.object(m, "command", side_effect=AssertionError("no startup on foreign port"))):
            with self.assertRaisesRegex(RuntimeError, "foreign or unowned"):
                m.wake()

    def test_existing_owned_listener_requires_no_restart(self):
        out = io.StringIO()
        with (patch.object(m, "preflight_files"),
              patch.object(m, "unit_status", return_value={"LoadState":"loaded","ActiveState":"active"}),
              patch.object(m, "port_taken", return_value=True),
              patch.object(m, "owned_cdp_ready", return_value=True),
              patch.object(m, "command", side_effect=AssertionError("already ready")),
              redirect_stdout(out)):
            m.wake()
        self.assertIn("READY_SYSTEMD=YES", out.getvalue())

    def test_absent_browser_starts_service_and_waits_for_owned_listener(self):
        calls = []
        statuses = [
            {"LoadState": "loaded", "ActiveState": "inactive"},
            {"LoadState": "loaded", "ActiveState": "active"},
        ]
        def unit():
            return statuses.pop(0) if statuses else {"LoadState":"loaded","ActiveState":"active"}
        with (patch.object(m, "preflight_files"),
              patch.object(m, "unit_status", side_effect=unit),
              patch.object(m, "port_taken", return_value=False),
              patch.object(m, "owned_cdp_ready", return_value=True),
              patch.object(m, "command", side_effect=lambda args, **kw: calls.append(args)),
              patch.object(m.time, "sleep")):
            m.wake()
        self.assertEqual(calls, [["systemctl", "--user", "start", m.UNIT]])

    def test_fake_json_with_port_occupied_is_not_a_valid_browser(self):
        with (patch.object(m, "preflight_files"),
              patch.object(m, "unit_status", return_value={"LoadState":"loaded","ActiveState":"inactive"}),
              patch.object(m, "cdp_ok", return_value=True),
              patch.object(m, "port_taken", return_value=True),
              patch.object(m, "command", side_effect=AssertionError("must not run start"))):
            with self.assertRaises(RuntimeError):
                m.wake()

    def test_no_force_cleanup_and_no_personal_chromium_profile(self):
        unit = m.UNIT_TEXT
        self.assertNotIn("--user-data-dir=%h/.config/chromium", unit)
        self.assertNotIn("rm -", unit)
        self.assertNotIn("mcp-setup", unit)
        self.assertIn("--check-owned", m.__doc__)


if __name__ == "__main__":
    unittest.main()
