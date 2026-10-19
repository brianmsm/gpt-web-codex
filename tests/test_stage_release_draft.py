"""Local adversarial GH CLI mock for GitHub Release draft creation safety.

No tests in this module invoke a real GitHub endpoint or write any refs.
Set R4_STAGE_SCRIPT to the absolute path of the old R3 script to reproduce
pre-remediation failures using exactly the same negative test cases.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


STAGE_SCRIPT = Path(os.environ.get("R4_STAGE_SCRIPT", str(Path(__file__).resolve().parents[1] / "scripts" / "stage-release-draft.sh")))
MOCK_GH = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
log = Path(os.environ["MOCK_LOG"])
with log.open("a") as handle:
    handle.write(json.dumps(args) + "\n")

original = {"isDraft": True, "assets": [{"name": "checksums.txt"}, {"name": "good.zip"}]}

def output_http(kind, default_body):
    status = int(os.environ.get("MOCK_" + kind + "_STATUS", "200"))
    body = os.environ.get("MOCK_" + kind + "_BODY", json.dumps(default_body))
    outcome = int(os.environ.get("MOCK_" + kind + "_EXIT", "0" if status < 400 else "1"))
    shape = os.environ.get("MOCK_" + kind + "_SHAPE", "normal")
    if shape == "empty":
        return outcome
    if shape == "transport":
        print("network error", file=sys.stderr)
        return 77
    if shape == "no_headers":
        print(body)
        return outcome
    if shape == "bad_status":
        print("not an HTTP response")
    else:
        print("HTTP/2.0 " + str(status) + " " + ("Not Found" if status == 404 else "Response"))
    if shape != "missing_type":
        print("content-type: application/json; charset=utf-8")
    print("x-github-request-id: MOCK-NO-NETWORK")
    print()
    if shape != "no_body":
        print(body, end="")
    return outcome

if args and args[0] == "api":
    endpoint = next((a for a in args[1:] if a.startswith("repos/")), "")
    if endpoint.endswith("/releases?per_page=1"):
        sys.exit(output_http("LIST", []))
    if "/releases/tags/" in endpoint:
        sys.exit(output_http("RELEASE", {"message": "Not Found", "status": "404"}))
    if endpoint.startswith("repos/"):
        sys.exit(output_http("REPO", {"full_name": "example-org/release-safe", "permissions": {"push": True}}))
    print("unknown api endpoint", file=sys.stderr)
    sys.exit(90)

if args[:2] == ["release", "view"]:
    if "--json" in args:
        print(os.environ.get("MOCK_POST_BODY", json.dumps(original)), end="")
        sys.exit(int(os.environ.get("MOCK_POST_EXIT", "0")))
    status = int(os.environ.get("MOCK_RELEASE_STATUS", "404"))
    if status == 200:
        print(json.dumps(original))
        sys.exit(0)
    sys.exit(int(os.environ.get("MOCK_RELEASE_EXIT", "1")))

if args[:2] == ["release", "create"]:
    with Path(os.environ["MOCK_CREATES"]).open("a") as handle:
        handle.write("attempt\n")
    sys.exit(int(os.environ.get("MOCK_CREATE_EXIT", "0")))

print("Unknown gh command", file=sys.stderr)
sys.exit(99)
'''


class DraftReleaseCliSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gh-release-r4-local-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shim = self.root / "bin"
        shim.mkdir()
        executable = shim / "gh"
        executable.write_text(MOCK_GH)
        executable.chmod(0o700)
        self.assets = self.root / "assets"
        self.assets.mkdir()
        payload = b"synthetic zipped bytes; not a real release\n"
        (self.assets / "good.zip").write_bytes(payload)
        (self.assets / "checksums.txt").write_text(hashlib.sha256(payload).hexdigest() + "  good.zip\n")
        self.log = self.root / "gh-calls.jsonl"
        self.creates = self.root / "creates.txt"
        self.env = os.environ.copy()
        self.env.update({
            "PATH": str(shim) + os.pathsep + self.env.get("PATH", ""),
            "GH_TOKEN": "SYNTHETIC-LOCAL-ONLY",
            "GITHUB_REPOSITORY": "example-org/release-safe",
            "GITHUB_REF_NAME": "v2.3.0",
            "MOCK_LOG": str(self.log),
            "MOCK_CREATES": str(self.creates),
            "MOCK_RELEASE_STATUS": "404",
        })
        for name in ("MOCK_REPO_STATUS", "MOCK_REPO_BODY", "MOCK_REPO_SHAPE",
                     "MOCK_REPO_EXIT", "MOCK_LIST_STATUS", "MOCK_LIST_BODY", "MOCK_LIST_SHAPE",
                     "MOCK_LIST_EXIT", "MOCK_RELEASE_BODY", "MOCK_RELEASE_SHAPE", "MOCK_RELEASE_EXIT",
                     "MOCK_POST_BODY", "MOCK_POST_EXIT", "MOCK_CREATE_EXIT"):
            self.env.pop(name, None)

    def invoke(self, **changes):
        # Every subtest is an independent mock execution and fresh draft state.
        self.log.unlink(missing_ok=True)
        self.creates.unlink(missing_ok=True)
        env = self.env.copy()
        env.update({k: str(v) for k, v in changes.items()})
        run = subprocess.run(["bash", str(STAGE_SCRIPT), str(self.assets)],
                             cwd=self.root, env=env, capture_output=True, text=True, timeout=15)
        count = len(self.creates.read_text().splitlines()) if self.creates.exists() else 0
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return run, count, calls

    def test_confirmed_404_creates_once_and_verifies_nominal_inventory(self):
        result, count, calls = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(count, 1)
        self.assertIn("DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=2", result.stdout)
        self.assertEqual(len([x for x in calls if x[:2] == ["release", "create"]]), 1)

    def test_existing_release_and_preflight_http_failures_never_create(self):
        for status in (200, 401, 403, 404, 429, 500, 502, 503):
            with self.subTest(status=status):
                if status == 404:
                    # The malformed GitHub 404 *body* disproves confirmed absence.
                    overrides = {"MOCK_RELEASE_STATUS": status, "MOCK_RELEASE_BODY": '{"message":"Forbidden"}'}
                else:
                    overrides = {"MOCK_RELEASE_STATUS": status}
                result, count, _ = self.invoke(**overrides)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(count, 0, f"status={status}, {result.stdout}, {result.stderr}")

    def test_release_http_transport_timeout_and_ambiguous_responses_never_create(self):
        cases = [
            {"MOCK_RELEASE_SHAPE": "transport"},
            {"MOCK_RELEASE_STATUS": 404, "MOCK_RELEASE_EXIT": 124},
            {"MOCK_RELEASE_STATUS": 404, "MOCK_RELEASE_EXIT": 77},
            {"MOCK_RELEASE_STATUS": 404, "MOCK_RELEASE_EXIT": 0},
            {"MOCK_RELEASE_SHAPE": "no_headers"},
            {"MOCK_RELEASE_SHAPE": "missing_type"},
            {"MOCK_RELEASE_SHAPE": "no_body"},
            {"MOCK_RELEASE_SHAPE": "bad_status"},
            {"MOCK_RELEASE_BODY": '{"message":"Not Found"}{"incomplete":'},
            {"MOCK_RELEASE_BODY": '{"message":"Not Found"} {"message":"Not Found"}'},
            {"MOCK_RELEASE_BODY": '[{"message":"Not Found"}]'},
            {"MOCK_RELEASE_BODY": '{"message":"Forbidden","message":"Not Found"}'},
        ]
        for overrides in cases:
            with self.subTest(**overrides):
                result, count, _ = self.invoke(**overrides)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(count, 0, f"{overrides}, {result.stderr}")

    def test_repository_identity_authorization_and_list_scope_gates(self):
        cases = [
            {"MOCK_REPO_STATUS": 401},
            {"MOCK_REPO_STATUS": 403},
            {"MOCK_REPO_STATUS": 404},
            {"MOCK_REPO_STATUS": 429},
            {"MOCK_REPO_STATUS": 503},
            {"MOCK_REPO_SHAPE": "transport"},
            {"MOCK_REPO_BODY": '{"full_name":"different/remote","permissions":{"push":true}}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe","permissions":{"push":false}}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe"}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe","permissions":{"push":"true"}}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe","permissions":{"push":true}} trailing'},
            {"MOCK_LIST_STATUS": 401},
            {"MOCK_LIST_STATUS": 403},
            {"MOCK_LIST_STATUS": 404},
            {"MOCK_LIST_STATUS": 429},
            {"MOCK_LIST_STATUS": 503},
            {"MOCK_LIST_SHAPE": "no_headers"},
            {"MOCK_LIST_BODY": '{"message":"not a list"}'},
            {"GITHUB_REPOSITORY": "../../other/repo"},
            {"GITHUB_REF_NAME": "../../v2.3.0"},
            {"GH_TOKEN": ""},
            {"GH_HOST": "unexpected.invalid"},
        ]
        for overrides in cases:
            with self.subTest(**overrides):
                result, count, _ = self.invoke(**overrides)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(count, 0, f"{overrides}, {result.stderr}")

    def test_bad_post_creation_json_must_never_yield_a_verified_draft(self):
        base = {"isDraft": True, "assets": [{"name": "good.zip"}, {"name": "checksums.txt"}]}
        responses = [
            json.dumps(base) + '{"broken"',
            json.dumps(base) + ' {"isDraft":true}',
            '{"isDraft":true,"assets":[{"name":"good.zip"},{"name":"checksums.txt"}',
            json.dumps(dict(base, isDraft="true")),
            json.dumps(dict(base, isDraft=1)),
            json.dumps(dict(base, isDraft=False)),
            json.dumps(dict(base, assets={"one": {"name": "good.zip"}, "two": {"name": "checksums.txt"}})),
            json.dumps(dict(base, assets=None)),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": "checksums.txt"}, 42])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": "checksums.txt"}, None])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": 123}])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {}])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": "checksums.txt"}, {"name": "extra.zip"}])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": "good.zip"}])),
            json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": "GOOD.ZIP"}, {"name": "checksums.txt"}])),
            *[json.dumps(dict(base, assets=[{"name": "good.zip"}, {"name": weird}]))
              for weird in ("", " ../good.zip", "../good.zip", "a/b.zip", "good.zip ", "good.zip\n", ".hidden", "bad\\\\name", "good.zip.", "bad\u0000name", "a" * 256)],
            '{"isDraft":false,"isDraft":true,"assets":[{"name":"good.zip"},{"name":"checksums.txt"}]}',
            '{"isDraft":true,"assets":[{"name":"wrong.zip","name":"good.zip"},{"name":"checksums.txt"}]}',
            "[]", "null", "true", "42", "{}", "not json",
        ]
        for index, response in enumerate(responses):
            with self.subTest(response_index=index):
                result, count, _ = self.invoke(MOCK_POST_BODY=response)
                self.assertNotEqual(result.returncode, 0, f"index {index}: {result.stdout}")
                self.assertNotIn("DRAFT_STAGED_ASSET_INVENTORY_VERIFIED", result.stdout)
                self.assertEqual(count, 1, f"mock draft was already created: {index}")

    def test_post_creation_partial_output_plus_cli_failure_is_rejected(self):
        valid = json.dumps({"isDraft": True, "assets": [{"name": "good.zip"}, {"name": "checksums.txt"}]})
        result, count, _ = self.invoke(MOCK_POST_BODY=valid, MOCK_POST_EXIT=88)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DRAFT_STAGED_ASSET_INVENTORY_VERIFIED", result.stdout)
        self.assertEqual(count, 1)

    def test_local_checksums_and_names_refuse_before_any_remote_call(self):
        with (self.assets / "checksums.txt").open("w") as handle:
            handle.write("0" * 64 + "  good.zip\n")
        result, count, calls = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(count, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
