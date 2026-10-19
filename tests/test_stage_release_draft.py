"""Network-free, stateful and adversarial release staging regressions (R5).

The shim implements gh CLI command contracts, not the release script's parser.
No test accesses GitHub or creates/updates a real release or Git ref.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

STAGE_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "stage-release-draft.sh"
MOCK_GH = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
with Path(os.environ["MOCK_LOG"]).open("a") as handle:
    handle.write(json.dumps(args) + "\n")

target = os.environ["GITHUB_REF_NAME"]
state = Path(os.environ["MOCK_STATE_PATH"])
current = len(state.read_text().splitlines()) if state.exists() else 0

def release_entry(n, tag=None, name=None, draft=True):
    return {"id": n, "tag_name": tag if tag is not None else target,
            "name": name if name is not None else target,
            "draft": draft, "prerelease": False}

def http(kind, default_body):
    status = int(os.environ.get("MOCK_" + kind + "_STATUS", "404" if kind == "RELEASE" else "200"))
    body = os.environ.get("MOCK_" + kind + "_BODY", json.dumps(default_body))
    outcome = int(os.environ.get("MOCK_" + kind + "_EXIT",
                                 "0" if status < 400 else "1"))
    shape = os.environ.get("MOCK_" + kind + "_SHAPE", "normal")
    if shape == "transport":
        print("synthetic transport failure", file=sys.stderr)
        return 77
    if shape == "empty":
        return outcome
    if shape == "no_headers":
        sys.stdout.write(body)
        return outcome
    if shape == "bad_status":
        print("not an HTTP response")
    else:
        print("HTTP/2.0 " + str(status) + " " + ("Not Found" if status == 404 else "OK"))
    if shape != "missing_type":
        print("content-type: application/json; charset=utf-8")
    print("x-github-request-id: MOCK-NO-NETWORK")
    if shape == "location":
        print("location: https://invalid.example.test/redirect")
    if shape == "length_mismatch":
        print("content-length: 9000")
    if shape == "dual_length":
        print("content-length: 40\ncontent-length: 9000")
    if shape == "invalid_length":
        print("content-length: -5")
    if shape in ("transfer_chunked", "both_framing"):
        print("transfer-encoding: chunked")
    if shape == "both_framing":
        print("content-length: 123")
    print()
    if shape != "no_body":
        sys.stdout.write(body)
    return outcome

if args and args[0] == "api":
    endpoints = [a for a in args[1:] if a.startswith("repos/")]
    endpoint = endpoints[-1] if endpoints else ""
    if "--paginate" in args:
        if "--slurp" not in args or "per_page=100" not in endpoint:
            sys.exit(91)
        shape = os.environ.get("MOCK_LIST_SHAPE", "normal")
        status = int(os.environ.get("MOCK_LIST_STATUS", "200"))
        pages = [[release_entry(700 + i) for i in range(current)]] if current else [[]]
        body = os.environ.get("MOCK_LIST_PAGES", json.dumps(pages))
        outcome = int(os.environ.get("MOCK_LIST_EXIT", "0" if status < 400 else "1"))
        if shape == "transport":
            sys.stdout.write(body[:12])
            sys.exit(77)
        if shape == "partial":
            sys.stdout.write(body[:max(1, len(body) // 2)])
        elif shape == "null_byte":
            sys.stdout.buffer.write(body.encode() + b"\x00")
        elif shape == "invalid_utf8":
            sys.stdout.buffer.write(body.encode() + b"\xff")
        else:
            sys.stdout.write(body)
        sys.exit(outcome)
    if endpoint.startswith("repos/") and "/releases?per_page=100&page=" in endpoint:
        pages = [release_entry(900, "another-tag", "another-title")] if os.environ.get("MOCK_BOUNDARY_NONEMPTY") == "1" else []
        sys.exit(http("BOUNDARY", pages))
    if "/releases/tags/" in endpoint:
        sys.exit(http("RELEASE", {"message": "Not Found", "status": "404"}))
    if endpoint.startswith("repos/") and "/releases" not in endpoint:
        sys.exit(http("REPO", {"full_name": "example-org/release-safe",
                               "permissions": {"push": True}}))
    print("unexpected gh api endpoint", file=sys.stderr)
    sys.exit(90)

if args[:2] == ["release", "view"]:
    if "--json" in args:
        fields = args[args.index("--json") + 1]
        if fields != "isDraft,assets,databaseId,tagName":
            sys.exit(94)
        response = {"databaseId": 800001, "tagName": target, "isDraft": True,
                    "assets": [{"name": "checksums.txt"}, {"name": "good.zip"}]}
        sys.stdout.write(os.environ.get("MOCK_POST_BODY", json.dumps(response)))
        if os.environ.get("MOCK_POST_SUFFIX_NUL") == "1":
            sys.stdout.buffer.write(b"\x00")
        sys.exit(int(os.environ.get("MOCK_POST_EXIT", "0")))
    sys.exit(92)

if args[:2] == ["release", "create"]:
    with Path(os.environ["MOCK_CREATES"]).open("a") as handle:
        handle.write("attempt\n")
    if os.environ.get("MOCK_STATEFUL") == "1":
        with state.open("a") as handle:
            handle.write("created\n")
    sys.exit(int(os.environ.get("MOCK_CREATE_EXIT", "0")))

print("unexpected gh command", file=sys.stderr)
sys.exit(99)
'''

def entry(n, tag="old-tag", name="old-title", draft=False):
    return {"id": n, "tag_name": tag, "name": name,
            "draft": draft, "prerelease": False}


class DraftReleaseCliSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gh-release-r5-local-")
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
        (self.assets / "checksums.txt").write_text(
            hashlib.sha256(payload).hexdigest() + "  good.zip\n")
        self.log = self.root / "gh-calls.jsonl"
        self.creates = self.root / "creates.txt"
        self.state = self.root / "remote-state.txt"
        self.env = {**os.environ, "PATH": str(shim) + os.pathsep + os.environ["PATH"],
                    "GH_TOKEN": "SYNTHETIC-LOCAL-ONLY",
                    "GH_HOST": "github.com",
                    "GITHUB_REPOSITORY": "example-org/release-safe",
                    "GITHUB_REF_NAME": "v2.3.0",
                    "MOCK_LOG": str(self.log), "MOCK_CREATES": str(self.creates),
                    "MOCK_STATE_PATH": str(self.state)}
        for key in list(self.env):
            if key.startswith("MOCK_") and key not in {"MOCK_LOG", "MOCK_CREATES",
                                                         "MOCK_STATE_PATH"}:
                self.env.pop(key)

    def invoke(self, preserve=False, **overrides):
        if not preserve:
            self.log.unlink(missing_ok=True)
            self.creates.unlink(missing_ok=True)
            self.state.unlink(missing_ok=True)
        prior_creates = len(self.creates.read_text().splitlines()) if self.creates.exists() else 0
        prior_calls = len(self.log.read_text().splitlines()) if self.log.exists() else 0
        env = dict(self.env)
        env.update({k: str(v) for k, v in overrides.items()})
        result = subprocess.run(["bash", str(STAGE_SCRIPT), str(self.assets)],
                                cwd=self.root, env=env, capture_output=True,
                                text=True, timeout=20)
        creates = len(self.creates.read_text().splitlines()) if self.creates.exists() else 0
        calls = [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []
        uploads = sum(1 for x in calls if x[:2] == ["release", "upload"])
        only_new = calls[prior_calls:]
        create_delta = creates - prior_creates
        upload_delta = sum(1 for x in only_new if x[:2] == ["release", "upload"])
        ledger = os.environ.get("R5_CASE_LOG")
        if ledger:
            name = self._testMethodName
            if preserve and name == "test_partial_creation_postflight_failure_and_retry_preserves_draft":
                expected_exit, expected_create, state = 3, 0, "RETRY_BLOCKED"
            elif name in (
                "test_confirmed_empty_list_404_and_boundary_create_exactly_once",
                "test_more_than_one_hundred_results_without_target_is_valid",
                "test_http_metadata_transformed_by_cli_is_not_raw_framing",
            ):
                expected_exit, expected_create, state = 0, 1, "DRAFT_VERIFIED"
            elif name in (
                "test_invalid_postflight_json_and_provenance_require_manual_review",
                "test_postflight_cannot_reuse_preexisting_database_id",
                "test_partial_creation_postflight_failure_and_retry_preserves_draft",
            ):
                expected_exit, expected_create, state = 3, 1, "POSTFLIGHT_BLOCKED"
            elif name == "test_race_after_preflight_cannot_claim_atomicity":
                expected_exit, expected_create, state = "nonzero", 1, "RACE_REJECTED"
            elif name in (
                "test_repository_identity_authorization_and_context_fail_closed",
                "test_local_checksums_and_names_refuse_any_remote_call",
            ):
                expected_exit, expected_create, state = "nonzero", 0, "PREFLIGHT_BLOCKED"
            else:
                expected_exit, expected_create, state = 3, 0, "PREFLIGHT_BLOCKED"
            ok_exit = (result.returncode != 0 if expected_exit == "nonzero"
                       else result.returncode == expected_exit)
            normalized = {}
            for key, value in sorted(overrides.items()):
                raw = str(value)
                normalized[key] = (raw if len(raw) <= 80
                                   else {"bytes": len(raw), "sha256": hashlib.sha256(raw.encode()).hexdigest()})
            record = {
                "test": name, "case": normalized, "expected_state": state,
                "expected_exit": expected_exit, "observed_exit": result.returncode,
                "expected_create_calls": expected_create, "create_calls": create_delta,
                "expected_uploads": 0, "uploads": upload_delta,
                "fail_closed_before_mutation": (create_delta == 0 and upload_delta == 0),
                "matched_expectation": (ok_exit and create_delta == expected_create and upload_delta == 0),
            }
            with Path(ledger).open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, sort_keys=True) + "\n")
        return result, creates, uploads, calls

    def blocked(self, **overrides):
        result, count, uploads, _ = self.invoke(**overrides)
        self.assertEqual(result.returncode, 3, f"{overrides}\n{result.stdout}\n{result.stderr}")
        self.assertEqual(count, 0, f"created despite negative preflight: {overrides}")
        self.assertEqual(uploads, 0)

    def pages(self, value):
        return {"MOCK_LIST_PAGES": json.dumps(value)}

    def test_confirmed_empty_list_404_and_boundary_create_exactly_once(self):
        result, count, uploads, calls = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((count, uploads), (1, 0))
        self.assertIn("DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=2", result.stdout)
        self.assertEqual(sum("--paginate" in x for x in calls), 1)
        self.assertEqual(sum("per_page=100&page=2" in " ".join(x) for x in calls), 1)
        self.assertEqual(sum(x[:2] == ["release", "create"] for x in calls), 1)

    def test_existing_draft_page_one_or_later_is_rejected(self):
        self.blocked(**self.pages([[entry(1, "v2.3.0", draft=True)]]))
        first = [entry(i) for i in range(1, 101)]
        self.blocked(**self.pages([first, [entry(101, "v2.3.0", draft=True)]]))
        self.blocked(**self.pages([first, [entry(101), entry(102, "v2.3.0", draft=True)]]))

    def test_existing_published_release_and_404_by_tag_cannot_create(self):
        self.blocked(**self.pages([[entry(20, "v2.3.0", draft=False)]]))
        self.blocked(**self.pages([[entry(20, "V2.3.0", draft=True)]]))
        self.blocked(**self.pages([[entry(20, "other", name="v2.3.0")]]))

    def test_more_than_one_hundred_results_without_target_is_valid(self):
        first = [entry(i) for i in range(1, 101)]
        second = [entry(101, "other-101", "other-title-101")]
        # Distinct tags for all 101 entries.
        first = [entry(i, f"old-{i}", f"old-title-{i}") for i in range(1, 101)]
        result, creates, uploads, _ = self.invoke(**self.pages([first, second]))
        self.assertEqual((result.returncode, creates, uploads), (0, 1, 0), result.stderr)

    def test_two_drafts_matching_target_and_duplicate_tags_are_blocked(self):
        self.blocked(**self.pages([[entry(41, "v2.3.0", draft=True),
                                    entry(42, "v2.3.0", draft=True)]]))
        self.blocked(**self.pages([[entry(41, "old-tag"),
                                    entry(42, "old-tag")]]))

    def test_duplicate_ids_pages_and_inconsistent_page_topology(self):
        first = [entry(i, f"old-{i}") for i in range(1, 101)]
        for value in (
            [[entry(7), entry(7, "unique-tag")]],
            [first, [entry(7, "different-tag")]],
            [[entry(1)], [entry(2)]],
            [[], [entry(1)]],
            [[[1]]],
            [[entry(1)], []],
            [[entry(1)] * 101],
            [], [None], {"not": "pages"},
        ):
            with self.subTest(case=str(value)[:60]):
                self.blocked(**self.pages(value))

    def test_incomplete_listing_with_invisible_next_page_is_blocked(self):
        first = [entry(i, f"old-{i}") for i in range(1, 101)]
        self.blocked(**self.pages([first]), MOCK_BOUNDARY_NONEMPTY=1)
        self.blocked(**self.pages([[entry(1)]]), MOCK_BOUNDARY_NONEMPTY=1)
        self.blocked(MOCK_LIST_SHAPE="partial")
        self.blocked(MOCK_LIST_EXIT=77, MOCK_LIST_PAGES="[]")
        self.blocked(MOCK_LIST_EXIT=124, MOCK_LIST_PAGES='[[{"id":1}]]')
        self.blocked(MOCK_LIST_SHAPE="transport")

    def test_invalid_json_pages_types_and_duplicate_keys(self):
        for body in (
            '{"not":"pages"}', '[[{"id":1,"id":2}]]', '[[null]]',
            '[[{"id":1.0,"tag_name":"old","draft":false,"prerelease":false}]]',
            '[[{"id":true,"tag_name":"old","draft":false,"prerelease":false}]]',
            '[[{"id":1,"tag_name":"old","draft":"true","prerelease":false}]]',
            '[[{"id":1,"tag_name":"old","draft":true,"prerelease":null}]]',
            '[[{"id":1,"tag_name":false,"draft":true,"prerelease":false}]]',
            '[[{"id":1,"tag_name":"old","name":12,"draft":true,"prerelease":false}]]',
            '[[{"id":1,"tag_name":"old","draft":false,"prerelease":false}]]garbage',
            '[[{"id":1,"tag_name":"old","draft":false,"prerelease":false}]],[]',
            '[[NaN]]', '[[Infinity]]', '[[{',
        ):
            with self.subTest(body=body[:50]):
                self.blocked(MOCK_LIST_PAGES=body)
        self.blocked(MOCK_LIST_SHAPE="invalid_utf8")
        self.blocked(MOCK_LIST_SHAPE="null_byte")

    def test_preflight_api_errors_401_403_404_429_and_5xx(self):
        for code in (401, 403, 404, 429, 500, 502, 503):
            with self.subTest(code=code):
                self.blocked(MOCK_REPO_STATUS=code)
                self.blocked(MOCK_LIST_STATUS=code)
                self.blocked(MOCK_BOUNDARY_STATUS=code)
                if code != 404:
                    self.blocked(MOCK_RELEASE_STATUS=code)
                else:
                    self.blocked(MOCK_RELEASE_STATUS=404, MOCK_RELEASE_BODY='{"message":"Forbidden"}')

    def test_repository_identity_authorization_and_context_fail_closed(self):
        for overrides in (
            {"MOCK_REPO_BODY": '{"full_name":"other/repo","permissions":{"push":true}}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe"}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe","permissions":{"push":false}}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe","permissions":{"push":"true"}}'},
            {"MOCK_REPO_BODY": '{"full_name":"example-org/release-safe","permissions":{"push":true,"push":true}}'},
            {"GH_TOKEN": ""}, {"GH_HOST": "untrusted.invalid"},
            {"GITHUB_REPOSITORY": "../../other"}, {"GITHUB_REF_NAME": "../v2.3.0"},
        ):
            with self.subTest(**overrides):
                result, count, uploads, _ = self.invoke(**overrides)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual((count, uploads), (0, 0))

    def test_release_by_tag_404_must_be_unambiguous(self):
        for overrides in (
            {"MOCK_RELEASE_STATUS": 404, "MOCK_RELEASE_EXIT": 0},
            {"MOCK_RELEASE_STATUS": 404, "MOCK_RELEASE_EXIT": 77},
            {"MOCK_RELEASE_STATUS": 404, "MOCK_RELEASE_EXIT": 124},
            {"MOCK_RELEASE_BODY": '{"message":"Forbidden"}'},
            {"MOCK_RELEASE_BODY": '{"message":"Not Found","message":"Not Found"}'},
            {"MOCK_RELEASE_BODY": '{"message":"Not Found"}{"extra":true}'},
            {"MOCK_RELEASE_SHAPE": "no_headers"},
            {"MOCK_RELEASE_SHAPE": "missing_type"},
            {"MOCK_RELEASE_SHAPE": "no_body"},
            {"MOCK_RELEASE_SHAPE": "bad_status"},
            {"MOCK_RELEASE_SHAPE": "location"},
            {"MOCK_RELEASE_SHAPE": "dual_length"},
            {"MOCK_RELEASE_SHAPE": "invalid_length"},
            {"MOCK_RELEASE_SHAPE": "both_framing"},
        ):
            with self.subTest(**overrides):
                self.blocked(**overrides)

    def test_http_metadata_transformed_by_cli_is_not_raw_framing(self):
        # gh api --include output may be reserialized/decoded by the Go CLI:
        # neither exact Content-Length/body equality nor raw chunk delimiters
        # are claimed as a preflight security property.
        for shape in ("length_mismatch", "transfer_chunked"):
            with self.subTest(shape=shape):
                result, creates, uploads, _ = self.invoke(MOCK_RELEASE_SHAPE=shape)
                self.assertEqual((result.returncode, creates, uploads), (0, 1, 0), result.stderr)

    def test_invalid_postflight_json_and_provenance_require_manual_review(self):
        base = {"isDraft": True, "databaseId": 800001, "tagName": "v2.3.0",
                "assets": [{"name": "good.zip"}, {"name": "checksums.txt"}]}
        bad = [
            dict(base, isDraft=False), dict(base, isDraft="true"),
            dict(base, databaseId="800001"), dict(base, databaseId=1.5),
            dict(base, databaseId=0), dict(base, tagName="other-tag"),
            dict(base, assets=[{"name": "good.zip"}]),
            dict(base, assets=[{"name": "good.zip"}, {"name": "good.zip"}]),
            dict(base, assets=[{"name": "good.zip"}, {"name": "checksums.txt"},
                               {"name": "stale.zip"}]),
        ]
        for item in bad:
            with self.subTest(item=str(item)[:85]):
                result, count, uploads, _ = self.invoke(MOCK_POST_BODY=json.dumps(item))
                self.assertEqual((result.returncode, count, uploads), (3, 1, 0), result.stderr)
        for raw in ('{"isDraft":true,"isDraft":true}', '{"databaseId":',
                    json.dumps(base) + '{"extra":1}', "NaN", "[]"):
            with self.subTest(raw=raw[:60]):
                result, count, uploads, _ = self.invoke(MOCK_POST_BODY=raw)
                self.assertEqual((result.returncode, count, uploads), (3, 1, 0))
        result, count, _, _ = self.invoke(MOCK_POST_SUFFIX_NUL=1)
        self.assertEqual((result.returncode, count), (3, 1))
        result, count, _, _ = self.invoke(MOCK_POST_EXIT=77)
        self.assertEqual((result.returncode, count), (3, 1))

    def test_postflight_cannot_reuse_preexisting_database_id(self):
        listed = entry(800001, "unrelated-tag", "unrelated-name")
        result, count, uploads, _ = self.invoke(**self.pages([[listed]]))
        self.assertEqual((result.returncode, count, uploads), (3, 1, 0))

    def test_partial_creation_postflight_failure_and_retry_preserves_draft(self):
        first, creates, uploads, _ = self.invoke(MOCK_STATEFUL=1, MOCK_POST_EXIT=77)
        self.assertEqual((first.returncode, creates, uploads), (3, 1, 0), first.stderr)
        second, creates, uploads, calls = self.invoke(
            preserve=True, MOCK_STATEFUL=1, MOCK_RELEASE_STATUS=404)
        self.assertEqual((second.returncode, creates, uploads), (3, 1, 0), second.stderr)
        self.assertEqual(sum(x[:2] == ["release", "create"] for x in calls), 1)

    def test_race_after_preflight_cannot_claim_atomicity(self):
        # The external actor's race is outside the GET preflight guarantee.
        result, count, uploads, _ = self.invoke(MOCK_CREATE_EXIT=422)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((count, uploads), (1, 0))
        self.assertNotIn("DRAFT_STAGED_ASSET_INVENTORY_VERIFIED", result.stdout)

    def test_local_checksums_and_names_refuse_any_remote_call(self):
        (self.assets / "good.zip").write_bytes(b"mutated")
        result, count, uploads, calls = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((count, uploads, len(calls)), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
