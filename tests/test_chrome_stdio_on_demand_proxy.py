#!/usr/bin/python3
"""Synthetic, offline verification of transparent Chrome MCP wake wrapper."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "scripts/diagnostics/chrome-stdio-on-demand-proxy.py"
spec = importlib.util.spec_from_file_location("chrome_on_demand_proxy", SRC)
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ChromeOnDemandProxyTests(TestCase):
    def test_chrome_tool_request_preserves_numeric_identity(self) -> None:
        raw=b'{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}\n'
        self.assertEqual(m.parse_tool_call(raw), (True,42))

    def test_unrelated_call_is_not_instrumented(self) -> None:
        for raw in [
            b'{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}\n',
            b'{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}\n',
            b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n',
        ]:
            self.assertEqual(m.parse_tool_call(raw), (False,None))

    def test_broken_or_oversize_frame_is_denied(self) -> None:
        for line in [
            b'{"jsonrpc":"2.0","id":3,"method":"tools/call"}',
            b'{}'* (m.MAX_MCP_LINE//2+1) + b'\n',
            b'not json\n',
            b'{"jsonrpc":"2.0","id":null,"method":"tools/call"}\n',
            b'{"jsonrpc":"2.0","id":true,"method":"tools/call"}\n',
        ]:
            with self.assertRaises(ValueError):
                m.parse_tool_call(line)

    def test_failure_does_not_forward_browser_operation(self) -> None:
        parsed=json.loads(m.fail_response("secret-id"))
        self.assertEqual(parsed["id"],"secret-id")
        self.assertTrue(parsed["result"]["isError"])
        self.assertEqual(parsed["result"]["content"][0]["type"],"text")
        self.assertNotIn("secret-id",parsed["result"]["content"][0]["text"])
        self.assertIn("NOT",parsed["result"]["content"][0]["text"].upper())

    def test_if_cdp_ready_controller_not_invoked(self) -> None:
        with patch.object(m,"cdp_ready",return_value=True),patch.object(m.subprocess,"run") as sub:
            self.assertTrue(m.wake_browser())
            sub.assert_not_called()

    def test_if_service_unavailable_never_attempts_browser_operation(self) -> None:
        with patch.object(m,"cdp_ready",return_value=False),patch.object(m,"CONTROL",Path("/tmp/gwc-auto-wake-proxy-definitely-missing-controller")):
            self.assertFalse(m.wake_browser())

    def test_controlled_wake_is_bounded_and_has_no_terminal_stdout(self) -> None:
        with (patch.object(m,"cdp_ready",side_effect=[False,True]),
              patch.object(m.subprocess,"run") as sub):
            sub.return_value.returncode=0
            self.assertTrue(m.wake_browser())
            args, kwargs=sub.call_args
            self.assertEqual(args[0],["/usr/bin/python3","-B",str(m.CONTROL),"--start"])
            self.assertEqual(kwargs["timeout"],m.WAKE_TIMEOUT)
            self.assertEqual(kwargs["stdout"],m.subprocess.DEVNULL)
            self.assertEqual(kwargs["stderr"],m.subprocess.DEVNULL)

    def test_output_relay_is_exact_byte_transport(self) -> None:
        data=b'{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"test"}]}}\n'
        io_out=io.BytesIO()
        r=m.OutputRelay(io_out)
        r.write(data)
        self.assertEqual(io_out.getvalue(),data)

    def test_args_remain_pinned_and_redaction_enabled(self) -> None:
        self.assertEqual(m.CHILD_ARGS[1],"chrome-devtools-mcp@1.10.1")
        self.assertIn("--browserUrl=http://127.0.0.1:9333",m.CHILD_ARGS)
        self.assertIn("--redactNetworkHeaders",m.CHILD_ARGS)
        self.assertIn("--no-usage-statistics",m.CHILD_ARGS)
        self.assertNotIn("--executablePath", " ".join(m.CHILD_ARGS))
        self.assertNotIn("--userDataDir"," ".join(m.CHILD_ARGS))


if __name__=="__main__":
    main()
