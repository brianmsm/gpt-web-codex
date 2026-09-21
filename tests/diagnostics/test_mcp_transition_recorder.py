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

    def test_identity_signature_ignores_reparenting(self):
        before = [{"pid": 10, "ppid": 20, "starttime": 30}]
        after = [{"pid": 10, "ppid": 1, "starttime": 30}]
        self.assertEqual(
            RECORDER.identity_signature(before),
            RECORDER.identity_signature(after),
        )
        self.assertNotEqual(
            RECORDER.parent_signature(before),
            RECORDER.parent_signature(after),
        )

    def test_sanitize_text_redacts_embedded_sensitive_values(self):
        raw = (
            "Authorization=Bearer-opaque "
            "token=abc123 "
            "header Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature "
            "https://example.test/path?api_key=qwerty&x=1"
        )
        sanitized = RECORDER.sanitize_text(raw)
        self.assertNotIn("abc123", sanitized)
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", sanitized)
        self.assertNotIn("qwerty", sanitized)
        self.assertIn("<redacted>", sanitized)

    def test_runtime_status_projection_is_minimal_and_redacted(self):
        projected = RECORDER.project_runtime_status(
            {
                "alias": "codex-chatgpt-web",
                "healthy": True,
                "ready": True,
                "process_running": True,
                "runtime_state": "ready",
                "stale": False,
                "remote": {
                    "organization_ids": ["org-secret"],
                    "runtime_token": "do-not-keep",
                },
                "remote_lookup_auth_ref": "file:/secret/key",
                "control_plane_poll_health": {
                    "state": "healthy",
                    "reason": "token=should-not-survive",
                },
                "local": {
                    "effective_health": {
                        "base_url": "http://127.0.0.1:42443",
                        "healthz": {"ok": True, "body": "live"},
                        "readyz": {"ok": True, "body": "ready"},
                    },
                    "control_plane_poll_health": {
                        "state": "healthy",
                        "reason": "Bearer opaque-secret",
                    },
                    "log": {"tail": "secret material"},
                },
                "process": {
                    "started_at": "2026-09-21T21:08:54Z",
                    "mode": "tmux",
                    "target_kind": "command",
                    "target_value": "sensitive command",
                },
                "tmux": {
                    "running": True,
                    "session_name": "safe-session",
                },
            }
        )
        self.assertNotIn("remote", projected)
        self.assertNotIn("remote_lookup_auth_ref", projected)
        self.assertNotIn("target_value", projected["process"])
        self.assertNotIn("log", projected["local"])
        rendered = str(projected)
        self.assertNotIn("should-not-survive", rendered)
        self.assertNotIn("opaque-secret", rendered)
        self.assertIn("<redacted>", rendered)

    def test_current_test_process_is_not_owned_by_gwc_or_tunnel(self):
        independence = RECORDER.recorder_independence()
        self.assertTrue(independence["independent_of_gwc_and_tunnel"])
        self.assertFalse(independence["runtime_ancestors"])

    def test_watcher_can_exclude_recorder_pid(self):
        results = RECORDER.watched_processes(
            ["unittest"],
            exclude_pids={os.getpid()},
        )
        self.assertNotIn(
            os.getpid(),
            [item["pid"] for item in results["unittest"]],
        )


if __name__ == "__main__":
    unittest.main()
