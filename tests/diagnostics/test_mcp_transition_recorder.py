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
                "/opt/tools/tunnel-client",
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

    def test_gwc_matcher_requires_structural_cli_shape(self):
        cli = "/tmp/install/app/cli.js"
        actual = {
            "cmdline": [
                "/tmp/runtime/bun",
                cli,
                "mcp",
                "--state-path",
                "/tmp/state.json",
            ]
        }
        wrapper = {
            "cmdline": [
                "bash",
                "-c",
                f"bun {cli} mcp --state-path /tmp/state.json",
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
            "token=abc123 "
            "header Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature "
            "https://example.test/path?api_key=qwerty&x=1\n"
            "Authorization=Bearer-opaque\n"
            "Authorization: Basic dXNlcjpwYXNz\n"
            "Authorization=Basic YWxpY2U6c2VjcmV0\n"
            'Authorization: Digest username="alice", realm="example", '
            'nonce="NONCESECRET", response="RESPSECRET"\n'
            "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE, "
            "SignedHeaders=host, Signature=SIGSECRET\n"
            "Authorization: CustomScheme opaque-part second-secret"
        )
        sanitized = RECORDER.sanitize_text(raw)
        self.assertNotIn("abc123", sanitized)
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", sanitized)
        self.assertNotIn("qwerty", sanitized)
        self.assertNotIn("dXNlcjpwYXNz", sanitized)
        self.assertNotIn("YWxpY2U6c2VjcmV0", sanitized)
        self.assertNotIn("NONCESECRET", sanitized)
        self.assertNotIn("RESPSECRET", sanitized)
        self.assertNotIn("AKIAEXAMPLE", sanitized)
        self.assertNotIn("SIGSECRET", sanitized)
        self.assertNotIn("opaque-part", sanitized)
        self.assertNotIn("second-secret", sanitized)
        self.assertIn("Authorization: <redacted>", sanitized)
        self.assertIn("Authorization=<redacted>", sanitized)
        self.assertIn("<redacted>", sanitized)

    def test_transition_validity_accepts_sustained_associated_outage(self):
        evidence = RECORDER.evaluate_transition_evidence(
            initial_proton_present=False,
            final_proton_present=True,
            proton_first_seen_epoch_ms=15_000,
            outage_episodes=[
                {
                    "last_reachable_before_epoch_ms": 9_750,
                    "first_unreachable_epoch_ms": 10_000,
                    "last_unreachable_epoch_ms": 17_750,
                    "unreachable_sample_count": 32,
                    "first_reachable_after_epoch_ms": 18_000,
                }
            ],
            ipv4_default_changed=False,
            ip_rule_changed=True,
        )
        self.assertTrue(evidence["transition_valid"])
        self.assertTrue(evidence["classification_allowed"])
        self.assertEqual(evidence["associated_outage_index"], 0)
        self.assertTrue(evidence["outage_episodes"][0]["sustained"])
        self.assertTrue(
            evidence["outage_episodes"][0][
                "proton_temporally_associated"
            ]
        )

    def test_transition_validity_rejects_unrelated_earlier_outage(self):
        evidence = RECORDER.evaluate_transition_evidence(
            initial_proton_present=False,
            final_proton_present=True,
            proton_first_seen_epoch_ms=60_000,
            outage_episodes=[
                {
                    "last_reachable_before_epoch_ms": 9_750,
                    "first_unreachable_epoch_ms": 10_000,
                    "last_unreachable_epoch_ms": 17_750,
                    "unreachable_sample_count": 32,
                    "first_reachable_after_epoch_ms": 18_000,
                }
            ],
            ipv4_default_changed=True,
            ip_rule_changed=True,
        )
        self.assertFalse(evidence["transition_valid"])
        self.assertIsNone(evidence["associated_outage_index"])

    def test_transition_validity_rejects_outage_after_proton(self):
        evidence = RECORDER.evaluate_transition_evidence(
            initial_proton_present=False,
            final_proton_present=True,
            proton_first_seen_epoch_ms=10_000,
            outage_episodes=[
                {
                    "last_reachable_before_epoch_ms": 59_750,
                    "first_unreachable_epoch_ms": 60_000,
                    "last_unreachable_epoch_ms": 67_750,
                    "unreachable_sample_count": 32,
                    "first_reachable_after_epoch_ms": 68_000,
                }
            ],
            ipv4_default_changed=True,
            ip_rule_changed=True,
        )
        self.assertFalse(evidence["transition_valid"])
        self.assertIsNone(evidence["associated_outage_index"])

    def test_transition_validity_rejects_single_tcp_hiccup(self):
        evidence = RECORDER.evaluate_transition_evidence(
            initial_proton_present=False,
            final_proton_present=True,
            proton_first_seen_epoch_ms=9_700,
            outage_episodes=[
                {
                    "last_reachable_before_epoch_ms": 9_250,
                    "first_unreachable_epoch_ms": 9_500,
                    "last_unreachable_epoch_ms": 9_500,
                    "unreachable_sample_count": 1,
                    "first_reachable_after_epoch_ms": 9_750,
                }
            ],
            ipv4_default_changed=True,
            ip_rule_changed=True,
        )
        self.assertFalse(evidence["transition_valid"])
        self.assertFalse(evidence["outage_episodes"][0]["sustained"])

    def test_transition_validity_accepts_immediately_preceding_outage(self):
        evidence = RECORDER.evaluate_transition_evidence(
            initial_proton_present=False,
            final_proton_present=True,
            proton_first_seen_epoch_ms=20_000,
            outage_episodes=[
                {
                    "last_reachable_before_epoch_ms": 9_750,
                    "first_unreachable_epoch_ms": 10_000,
                    "last_unreachable_epoch_ms": 17_750,
                    "unreachable_sample_count": 32,
                    "first_reachable_after_epoch_ms": 18_000,
                }
            ],
            ipv4_default_changed=True,
            ip_rule_changed=False,
        )
        self.assertTrue(evidence["transition_valid"])
        self.assertEqual(evidence["associated_outage_index"], 0)

    def test_transition_validity_requires_routing_evidence(self):
        evidence = RECORDER.evaluate_transition_evidence(
            initial_proton_present=False,
            final_proton_present=True,
            proton_first_seen_epoch_ms=15_000,
            outage_episodes=[
                {
                    "last_reachable_before_epoch_ms": 9_750,
                    "first_unreachable_epoch_ms": 10_000,
                    "last_unreachable_epoch_ms": 17_750,
                    "unreachable_sample_count": 32,
                    "first_reachable_after_epoch_ms": 18_000,
                }
            ],
            ipv4_default_changed=False,
            ip_rule_changed=False,
        )
        self.assertFalse(evidence["transition_valid"])
        self.assertIn(
            "no IPv4-default-route or ip-rule change was observed",
            evidence["invalid_reasons"],
        )

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

    def test_independence_accepts_synthetic_herdr_owned_chain(self):
        chain = [
            {
                "pid": 100,
                "ppid": 90,
                "starttime": 1000,
                "cmdline": ["python", "mcp_transition_recorder.py"],
            },
            {
                "pid": 90,
                "ppid": 80,
                "starttime": 900,
                "cmdline": ["bash"],
            },
            {
                "pid": 80,
                "ppid": 1,
                "starttime": 800,
                "cmdline": ["/usr/bin/herdr", "server"],
            },
        ]
        independence = RECORDER.assess_recorder_independence(chain)
        self.assertTrue(independence["independent_of_gwc_and_tunnel"])
        self.assertFalse(independence["runtime_ancestors"])

    def test_independence_rejects_synthetic_gwc_owned_chain(self):
        chain = [
            {
                "pid": 100,
                "ppid": 90,
                "starttime": 1000,
                "cmdline": ["python", "mcp_transition_recorder.py"],
            },
            {
                "pid": 90,
                "ppid": 70,
                "starttime": 900,
                "cmdline": [
                    "/tmp/runtime/bun",
                    "/tmp/install/app/cli.js",
                    "mcp",
                    "--state-path",
                    "/tmp/state.json",
                ],
            },
            {
                "pid": 70,
                "ppid": 1,
                "starttime": 700,
                "cmdline": [
                    "/opt/tools/tunnel-client",
                    "run",
                    "--profile",
                    "codex-chatgpt-web",
                ],
            },
        ]
        independence = RECORDER.assess_recorder_independence(chain)
        self.assertFalse(independence["independent_of_gwc_and_tunnel"])
        self.assertEqual(
            [item["pid"] for item in independence["runtime_ancestors"]],
            [90, 70],
        )

    def test_target_precondition_requires_unique_roles_and_ownership(self):
        tunnel = {
            "pid": 70,
            "ppid": 60,
            "starttime": 700,
            "cmdline": [
                "/opt/tools/tunnel-client",
                "run",
                "--profile",
                "codex-chatgpt-web",
            ],
        }
        gwc = {
            "pid": 90,
            "ppid": 70,
            "starttime": 900,
            "cmdline": [
                "/tmp/runtime/bun",
                "/tmp/install/app/cli.js",
                "mcp",
                "--state-path",
                "/tmp/state.json",
            ],
        }
        herdr = {
            "pid": 80,
            "ppid": 1,
            "starttime": 800,
            "cmdline": ["/usr/bin/herdr", "server"],
        }
        roles = {
            "tunnel_client": [tunnel],
            "gwc_mcp": [gwc],
            "herdr_server": [herdr],
        }
        valid = RECORDER.validate_target_preconditions(
            roles,
            ancestry_lookup=lambda _pid: [gwc, tunnel],
        )
        self.assertTrue(valid["valid"])
        self.assertTrue(valid["gwc_owned_by_tunnel"])
        self.assertTrue(valid["gwc_direct_child_of_tunnel"])

        missing = RECORDER.validate_target_preconditions(
            {**roles, "gwc_mcp": []},
            ancestry_lookup=lambda _pid: [],
        )
        self.assertFalse(missing["valid"])
        self.assertIn(
            "expected exactly one gwc_mcp, observed 0",
            missing["errors"],
        )

        multiple = RECORDER.validate_target_preconditions(
            {**roles, "tunnel_client": [tunnel, dict(tunnel, pid=71)]},
            ancestry_lookup=lambda _pid: [gwc, tunnel],
        )
        self.assertFalse(multiple["valid"])
        self.assertIn(
            "expected exactly one tunnel_client, observed 2",
            multiple["errors"],
        )

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
