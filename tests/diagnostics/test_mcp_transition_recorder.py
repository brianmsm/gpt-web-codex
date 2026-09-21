import importlib.util
import os
from pathlib import Path
import unittest


SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "scripts"
    / "diagnostics"
    / "mcp_transition_recorder.py"
)
SPEC = importlib.util.spec_from_file_location("mcp_transition_recorder", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RECORDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECORDER)


class RecorderUnitTests(unittest.TestCase):
    def test_sanitize_cmdline_redacts_secret_values(self):
        parts = [
            "cmd",
            "--api-key",
            "super-secret",
            "AUTH_TOKEN=other-secret",
            "--normal=value",
        ]
        self.assertEqual(
            RECORDER.sanitize_cmdline(parts),
            [
                "cmd",
                "--api-key",
                "<redacted>",
                "AUTH_TOKEN=<redacted>",
                "--normal=value",
            ],
        )

    def test_safe_subprocess_env_does_not_copy_arbitrary_environment(self):
        old = os.environ.get("WAVE0_SECRET_TOKEN")
        os.environ["WAVE0_SECRET_TOKEN"] = "must-not-leak"
        try:
            env = RECORDER.safe_subprocess_env()
        finally:
            if old is None:
                os.environ.pop("WAVE0_SECRET_TOKEN", None)
            else:
                os.environ["WAVE0_SECRET_TOKEN"] = old

        self.assertNotIn("WAVE0_SECRET_TOKEN", env)
        self.assertIn("HOME", env)
        self.assertIn("PATH", env)

    def test_tunnel_matcher_rejects_tmux_or_shell_wrapper(self):
        wrapped = {
            "cmdline": [
                "bash",
                "-c",
                (
                    "/home/brian/.codex-chatgpt-web/bin/tunnel-client run "
                    "--profile codex-chatgpt-web"
                ),
            ]
        }
        self.assertFalse(
            RECORDER.matches_role("tunnel_client", wrapped)
        )

    def test_tunnel_matcher_accepts_actual_executable(self):
        actual = {
            "cmdline": [
                RECORDER.TUNNEL_EXECUTABLE,
                "run",
                "--profile-dir",
                "/tmp/profiles",
                "--profile",
                "codex-chatgpt-web",
            ]
        }
        self.assertTrue(
            RECORDER.matches_role("tunnel_client", actual)
        )

    def test_gwc_matcher_requires_cli_as_second_argv(self):
        actual = {
            "cmdline": [
                "/tmp/runtime/bun",
                RECORDER.GWC_CLI,
                "mcp",
                "--state-path",
                "/tmp/state.json",
            ]
        }
        wrapper = {
            "cmdline": [
                "bash",
                "-c",
                f"bun {RECORDER.GWC_CLI} mcp",
            ]
        }
        self.assertTrue(RECORDER.matches_role("gwc_mcp", actual))
        self.assertFalse(RECORDER.matches_role("gwc_mcp", wrapper))

    def test_proc_identity_contains_strong_identity_fields(self):
        ident = RECORDER.proc_identity(os.getpid())
        self.assertIsNotNone(ident)
        assert ident is not None
        self.assertEqual(ident["pid"], os.getpid())
        self.assertIsInstance(ident["ppid"], int)
        self.assertGreater(ident["starttime"], 0)
        self.assertTrue(ident["cmdline"])


if __name__ == "__main__":
    unittest.main()
