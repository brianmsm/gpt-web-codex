#!/usr/bin/python3
"""No production changes: tests for private GWC Agent systemd on-demand launcher."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from io import StringIO
from contextlib import redirect_stdout

F=Path(__file__).resolve().parents[1]/"scripts/diagnostics/gwc-agent-browser-control.py"
spec=importlib.util.spec_from_file_location("test_gwc_agent_browser_control",F)
assert spec and spec.loader
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SystemdWakeTests(unittest.TestCase):
    def test_unit_is_opt_in_and_restarts_only_on_failure(self):
        self.assertIn("Type=exec",m.UNIT_TEXT)
        self.assertIn("Restart=on-failure",m.UNIT_TEXT)
        self.assertNotIn("Restart=always",m.UNIT_TEXT)
        self.assertIn("After=graphical-session.target",m.UNIT_TEXT)
        self.assertIn("PartOf=graphical-session.target",m.UNIT_TEXT)
        self.assertIn("ExecCondition=",m.UNIT_TEXT)
        self.assertIn("--remote-debugging-address=127.0.0.1",m.UNIT_TEXT)
        self.assertIn("--remote-debugging-port=9333",m.UNIT_TEXT)
        self.assertIn("gwc-browser-agent",m.UNIT_TEXT)
        self.assertNotIn("ExecStartPost=/usr/bin/systemctl",m.UNIT_TEXT)

    def test_current_manual_browser_requires_no_restart(self):
        output=StringIO()
        with (patch.object(m,"preflight_files"),
              patch.object(m,"unit_status",return_value={"LoadState":"loaded","ActiveState":"inactive"}),
              patch.object(m,"cdp_ok",return_value=True),
              patch.object(m,"command",side_effect=AssertionError("must not start when manual browser runs")),
              redirect_stdout(output)):
            m.wake()
        self.assertIn("READY_EXISTING_MANUAL=YES",output.getvalue())

    def test_absent_browser_is_started_from_systemd(self):
        calls=[]
        states=["inactive","active","active"]
        ready=[False,False,True]
        def status():
            return {"LoadState":"loaded","ActiveState":states.pop(0) if states else "active"}
        def cdp():
            return ready.pop(0) if ready else True
        with (patch.object(m,"preflight_files"),
              patch.object(m,"unit_status",side_effect=status),
              patch.object(m,"cdp_ok",side_effect=cdp),
              patch.object(m,"port_taken",return_value=False),
              patch.object(m,"command",side_effect=lambda args,**kw: calls.append(args)),
              patch.object(m.time,"sleep")):
            m.wake()
        self.assertEqual(calls,[["systemctl","--user","start",m.UNIT]])

    def test_invalid_port_is_not_treated_as_cdp(self):
        with (patch.object(m,"preflight_files"),
              patch.object(m,"unit_status",return_value={"LoadState":"loaded","ActiveState":"inactive"}),
              patch.object(m,"cdp_ok",return_value=False),
              patch.object(m,"port_taken",return_value=True),
              patch.object(m,"command",side_effect=AssertionError("must not start foreign listener"))):
            with self.assertRaisesRegex(RuntimeError,"occupied"):
                m.wake()

    def test_never_cleans_or_recreates_existing_profile(self):
        unit=m.UNIT_TEXT
        self.assertNotIn("--isolated",unit)
        self.assertNotIn("--incognito",unit)
        self.assertNotIn("--user-data-dir=%h/.config/chromium",unit)
        self.assertNotIn("rm -",unit)
        self.assertNotIn("mcp-setup",unit)


if __name__=="__main__":
    unittest.main()
