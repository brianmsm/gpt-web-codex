"""Offline tests for the single-maintainer draft-only GitHub CLI release flow."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import stage_release_draft as draft

ROOT = Path(__file__).resolve().parents[1]
HEAD = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
REPO = "brianmsm/gpt-web-codex"
TAG = "v2.3.0"
TAG_OBJECT = "b" * 40


class DraftReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gwc-simple-release-")
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        data = b"synthetic launcher data, never uploaded\n"
        (self.directory / "example.zip").write_bytes(data)
        self.digest = hashlib.sha256(data).hexdigest()
        self._checksums()
        self.env = patch.dict(os.environ, {
            "GITHUB_REPOSITORY": REPO, "GITHUB_REF_NAME": TAG,
            "GITHUB_REF_TYPE": "tag", "GITHUB_SHA": HEAD,
            "GH_TOKEN": "FAKE_TEST_TOKEN_NEVER_NETWORK",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.created = []
        self.mode = {}
        self.patch_command = patch.object(draft, "command", side_effect=self.fake_command)
        self.patch_command.start()
        self.addCleanup(self.patch_command.stop)

    def _checksums(self):
        (self.directory / "checksums.txt").write_text(self.digest + "  example.zip\n")

    def fake_command(self, args, **kwargs):
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            return HEAD
        if args[:2] == ["gh", "api"]:
            path = args[2]
            if path.endswith("/branches/main"):
                return json.dumps({"commit": {"sha": self.mode.get("main_sha", HEAD)}})
            if "/git/ref/tags/" in path:
                return json.dumps({"ref": "refs/tags/" + TAG,
                                   "object": {"type": "tag", "sha": TAG_OBJECT}})
            if "/git/tags/" in path:
                return json.dumps({"tag": TAG,
                                   "object": {"type": "commit",
                                              "sha": self.mode.get("tag_sha", HEAD)}})
            if path.endswith("/releases?per_page=100"):
                release = {"draft": not self.mode.get("published", False),
                           "tag_name": TAG, "id": 98765}
                if self.mode.get("no_draft"):
                    return json.dumps([])
                if self.mode.get("duplicate_draft"):
                    return json.dumps([release, dict(release)])
                if self.mode.get("full_page"):
                    return json.dumps([release] * 100)
                return json.dumps([release])
            if path.endswith("/releases/98765"):
                return json.dumps({"draft": not self.mode.get("published", False),
                                   "tag_name": TAG if not self.mode.get("wrong_draft_id") else "v9.9.9",
                                   "id": 98765})
            if "/releases/tags/" in path:
                raise draft.ReleaseError("GitHub hides drafts from get-by-tag")
            if "/releases/98765/assets" in path:
                asset = {"name": "example.zip", "size": 39, "state": "uploaded",
                         "digest": "sha256:" + self.digest}
                asset["size"] = (self.directory / "example.zip").stat().st_size
                if self.mode.get("bad_digest"):
                    asset["digest"] = "sha256:" + "f" * 64
                check = self.directory / "checksums.txt"
                checksum = {"name": "checksums.txt", "size": check.stat().st_size,
                            "state": "uploaded", "digest": "sha256:" + draft.hash_file(check)}
                return json.dumps([asset, checksum])
            raise AssertionError("Unexpected GitHub API request: " + path)
        if args[:3] == ["gh", "release", "create"]:
            self.created.append(args)
            if self.mode.get("creation_failed"):
                raise draft.ReleaseError("Synthetic uncertain upload")
            return "https://github.com/synthetic/draft"
        raise AssertionError("Unexpected command: " + repr(args))

    def test_success_stages_one_draft_and_checks_server_digests(self):
        self.assertEqual(draft.stage(self.directory), 98765)
        self.assertEqual(len(self.created), 1)
        args = self.created[0]
        for flag in ("--draft", "--verify-tag", "--latest=false", "--generate-notes"):
            self.assertIn(flag, args)
        self.assertIn("example.zip", " ".join(args))
        self.assertNotIn("publish", args)

    def test_wrong_source_or_mismatched_tag_denied_before_mutation(self):
        for changes in (
            {"GITHUB_SHA": "a" * 40},
            {"GITHUB_REF_TYPE": "branch"},
            {"GITHUB_REF_NAME": "v2.3.1"},
            {"GH_TOKEN": ""},
        ):
            with self.subTest(changes=changes), patch.dict(os.environ, changes):
                with self.assertRaises(draft.ReleaseError):
                    draft.stage(self.directory)
                self.assertEqual(self.created, [])
        self.mode["main_sha"] = "f" * 40
        with self.assertRaises(draft.ReleaseError):
            draft.stage(self.directory)
        self.mode.clear()
        self.mode["tag_sha"] = "a" * 40
        with self.assertRaises(draft.ReleaseError):
            draft.stage(self.directory)
        self.assertEqual(self.created, [])

    def test_checksums_and_inventory_reject_stale_extra_or_unsafe_files(self):
        (self.directory / "extra.exe").write_bytes(b"unexpected")
        with self.assertRaises(draft.ReleaseError):
            draft.stage(self.directory)
        (self.directory / "extra.exe").unlink()
        (self.directory / "example.zip").write_bytes(b"modified")
        with self.assertRaises(draft.ReleaseError):
            draft.stage(self.directory)
        (self.directory / "example.zip").write_bytes(b"synthetic launcher data, never uploaded\n")
        (self.directory / "unsafe.exe").symlink_to(self.directory / "example.zip")
        with self.assertRaises(draft.ReleaseError):
            draft.stage(self.directory)
        self.assertEqual(self.created, [])

    def test_remote_digest_or_draft_mismatch_is_not_silent(self):
        for mode in ({"bad_digest": True}, {"published": True}):
            self.mode = mode
            with self.assertRaises(draft.ReleaseError):
                draft.stage(self.directory)
        self.assertEqual(len(self.created), 2)  # One attempt each; no retry.

    def test_draft_by_tag_404_uses_listing_then_checks_immutable_id(self):
        # The mock deliberately raises on releases/tags/{tag}; the real
        # first v2.3.0 draft reproduced this 404 with its token.
        self.assertEqual(draft.stage(self.directory), 98765)
        self.assertEqual(len(self.created), 1)

    def test_ambiguous_or_mismatched_draft_denied_without_retry(self):
        for mode in ({"no_draft": True}, {"duplicate_draft": True},
                     {"full_page": True}, {"wrong_draft_id": True}):
            self.mode = mode
            with self.subTest(mode=mode), self.assertRaises(draft.ReleaseError):
                draft.stage(self.directory)
        self.assertEqual(len(self.created), 4)  # One create each, never retried.

    def test_uncertain_release_create_is_never_retried(self):
        self.mode["creation_failed"] = True
        with self.assertRaises(draft.ReleaseError):
            draft.stage(self.directory)
        self.assertEqual(len(self.created), 1)

    def test_missing_tag_api_fails_before_release(self):
        old = self.fake_command

        def refuse(args, **kwargs):
            if args[:2] == ["gh", "api"] and "/git/ref/tags/" in args[2]:
                raise draft.ReleaseError("Remote tag missing")
            return old(args, **kwargs)

        with patch.object(draft, "command", side_effect=refuse):
            with self.assertRaises(draft.ReleaseError):
                draft.stage(self.directory)
        self.assertEqual(self.created, [])


if __name__ == "__main__":
    unittest.main()
