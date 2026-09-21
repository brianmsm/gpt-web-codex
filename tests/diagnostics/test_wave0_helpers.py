import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
OBSERVATION = ROOT / "scripts" / "diagnostics" / "record_wave0_observation.py"
READ_ONLY_PROBE = ROOT / "scripts" / "diagnostics" / "read_only_invocation_probe.py"


class Wave0HelperTests(unittest.TestCase):
    def test_observation_helper_appends_sanitized_ndjson(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            cp = subprocess.run(
                [
                    sys.executable,
                    str(OBSERVATION),
                    "--run-dir",
                    str(run_dir),
                    "--event",
                    "note",
                    "--source",
                    "executor",
                    "--detail",
                    (
                        "token=abc123 "
                        "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\n"
                        "Authorization=opaque\n"
                        "Authorization: Basic dXNlcjpwYXNz\n"
                        "Authorization=Basic YWxpY2U6c2VjcmV0\n"
                        'Authorization: Digest username="alice", '
                        'nonce="NONCESECRET", response="RESPSECRET"\n'
                        "Authorization: AWS4-HMAC-SHA256 "
                        "Credential=AKIAEXAMPLE, Signature=SIGSECRET\n"
                        "Authorization: CustomScheme opaque-part second-secret"
                    ),
                ],
                check=True,
                text=True,
                capture_output=True,
            )
            self.assertEqual(cp.returncode, 0)
            lines = (run_dir / "observations.ndjson").read_text().splitlines()
            self.assertEqual(len(lines), 1)
            event = json.loads(lines[0])
            rendered = json.dumps(event)
            self.assertNotIn("abc123", rendered)
            self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", rendered)
            self.assertNotIn("Authorization=opaque", rendered)
            self.assertNotIn("dXNlcjpwYXNz", rendered)
            self.assertNotIn("YWxpY2U6c2VjcmV0", rendered)
            self.assertNotIn("NONCESECRET", rendered)
            self.assertNotIn("RESPSECRET", rendered)
            self.assertNotIn("AKIAEXAMPLE", rendered)
            self.assertNotIn("SIGSECRET", rendered)
            self.assertNotIn("opaque-part", rendered)
            self.assertNotIn("second-secret", rendered)
            self.assertIn("<redacted>", rendered)

    def test_read_only_invocation_probe_completes_with_read_activity(self):
        cp = subprocess.run(
            [
                sys.executable,
                str(READ_ONLY_PROBE),
                "--duration",
                "0.05",
                "--interval-ms",
                "10",
                "--tag",
                "WAVE0_HELPER_TEST",
            ],
            check=True,
            text=True,
            capture_output=True,
        )
        result = json.loads(cp.stdout)
        self.assertEqual(result["tag"], "WAVE0_HELPER_TEST")
        self.assertTrue(result["read_only"])
        self.assertGreater(result["reads"], 0)
        self.assertGreater(result["stat_checks"], 0)
        self.assertGreaterEqual(result["actual_duration_ms"], 40)


if __name__ == "__main__":
    unittest.main()
