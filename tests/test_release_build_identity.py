"""Cross-platform build-source provenance check, without GitHub or releases."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts import release_build_identity as provenance

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/release_build_identity.py"
HEAD = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


class BuildIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gwc-release-build-id-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.assets = self.path / "artifacts"
        self.assets.mkdir()
        self.env = dict(os.environ, GITHUB_SHA=HEAD,
                        GITHUB_RUN_ID="234567", GITHUB_RUN_ATTEMPT="2",
                        RELEASE_APPROVED_COMMIT_SHA=HEAD)

    def call(self, *args, env=None):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *args],
                              cwd=ROOT, env=env or self.env, text=True, capture_output=True,
                              timeout=8)

    def populate(self):
        for runner in provenance.RUNNERS:
            self.populate_missing(runner)

    def verify(self):
        return self.call("verify", "--directory", str(self.assets))

    def test_exact_four_records_are_verified_for_one_approved_head_and_run(self):
        self.populate()
        done = self.verify()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("RELEASE_BUILD_SOURCE_IDENTITIES_VERIFIED=4", done.stdout)

    def test_missing_or_extra_manifest_is_not_accepted(self):
        self.populate()
        (self.assets / provenance.manifest_name("windows-latest")).unlink()
        self.assertEqual(self.verify().returncode, 3)
        self.populate_missing("windows-latest")
        (self.assets / "release-source-attacker.json").write_text("{}")
        self.assertEqual(self.verify().returncode, 3)

    def populate_missing(self, runner):
        # Each matrix job has its own clean checkout. The publisher merges
        # artifacts only after each job created its manifest.
        source = self.path / ("matrix-" + runner)
        source.mkdir(exist_ok=True)
        (source / "launcher" / "artifacts").mkdir(parents=True, exist_ok=True)
        runtime = provenance.RUNTIMES[runner]
        (source / runtime).write_bytes(("runtime:" + runner).encode())
        (source / "launcher" / "artifacts" / (runner + ".zip")).write_bytes(
            ("installer:" + runner).encode())
        self.assertEqual(self.call("record", "--runner", runner,
                                   "--output", str(self.assets / provenance.manifest_name(runner)),
                                   "--artifact-root", str(source)).returncode, 0)
        for rel in (runtime, "launcher/artifacts/" + runner + ".zip"):
            destination = self.assets / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((source / rel).read_bytes())

    def test_source_commit_or_run_or_approved_value_mismatch_is_rejected(self):
        self.populate()
        file = self.assets / provenance.manifest_name("macos-15")
        original = json.loads(file.read_text())
        for key, wrong in [("source_sha", "b" * 40), ("workflow_sha", "f" * 40),
                           ("run_id", "234568"), ("run_attempt", "3"),
                           ("runner", "ubuntu-latest")]:
            file.write_text(json.dumps({**original, key: wrong}))
            self.assertEqual(self.verify().returncode, 3, key)
        file.write_text(json.dumps(original))
        self.assertEqual(self.verify().returncode, 0)
        bad_env = dict(self.env, RELEASE_APPROVED_COMMIT_SHA="b" * 40)
        self.assertEqual(self.call("verify", "--directory", str(self.assets), env=bad_env).returncode, 3)
        bad_env = dict(self.env, GITHUB_SHA="b" * 40, RELEASE_APPROVED_COMMIT_SHA="b" * 40)
        self.assertEqual(self.call("verify", "--directory", str(self.assets), env=bad_env).returncode, 3)

    def test_ambiguity_schema_unknown_runner_and_duplicate_json_rejected(self):
        self.populate()
        file = self.assets / provenance.manifest_name("windows-latest")
        data = json.loads(file.read_text())
        for body in [json.dumps(data) + " {}", '{"schema":"x","schema":"y"}',
                     json.dumps({**data, "unexpected": "field"}),
                     json.dumps(data) + "\x00"]:
            file.write_text(body)
            self.assertEqual(self.verify().returncode, 3)
        done = self.call("record", "--runner", "unknown",
                         "--output", str(self.assets / "release-source-unknown.json"))
        self.assertEqual(done.returncode, 3)

    def test_symlink_and_existing_record_not_overwritten(self):
        self.populate()
        file = self.assets / provenance.manifest_name("macos-15")
        self.assertEqual(self.call("record", "--runner", "macos-15",
                                    "--output", str(file),
                                    "--artifact-root", str(self.assets)).returncode, 3)
        file.unlink()
        file.symlink_to(self.assets / provenance.manifest_name("ubuntu-latest"))
        self.assertEqual(self.verify().returncode, 3)

    def test_stale_or_modified_binary_and_unlisted_file_are_rejected(self):
        self.populate()
        binary = self.assets / provenance.RUNTIMES["ubuntu-latest"]
        binary.write_bytes(b"modified binary after CI upload")
        self.assertEqual(self.verify().returncode, 3)
        binary.write_bytes(b"runtime:ubuntu-latest")
        self.assertEqual(self.verify().returncode, 0)
        (self.assets / "unrecorded.zip").write_bytes(b"unexpected extra binary")
        self.assertEqual(self.verify().returncode, 3)

    def test_missing_or_wrong_digest_in_one_matrix_manifest_is_rejected(self):
        self.populate()
        manifest = self.assets / provenance.manifest_name("windows-latest")
        data = json.loads(manifest.read_text())
        runtime = provenance.RUNTIMES["windows-latest"]
        data["files"][runtime] = "f" * 40
        manifest.write_text(json.dumps(data))
        self.assertEqual(self.verify().returncode, 3)

    def test_record_fails_if_checkout_head_differs_from_event(self):
        env = dict(self.env, GITHUB_SHA="b" * 40)
        result = self.call("record", "--runner", "macos-15",
                           "--output", str(self.assets / provenance.manifest_name("macos-15")),
                           "--artifact-root", str(self.assets), env=env)
        self.assertEqual(result.returncode, 3)
        self.assertFalse(any(p.name.startswith("release-source-") for p in self.assets.iterdir()))

    def test_workflow_runs_check_before_checksums_and_staging(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertIn("actions/setup-python@v6", workflow)
        self.assertEqual(workflow.count("python scripts/release_build_identity.py record"), 1)
        self.assertEqual(workflow.count("python scripts/release_build_identity.py verify"), 1)
        self.assertLess(workflow.index("Verify all four platform builds"),
                        workflow.index("Create checksums"))
        self.assertLess(workflow.index("Verify all four platform builds"),
                        workflow.index("Stage fresh checksummed"))
        self.assertIn("release-source-${{ matrix.runner }}.json", workflow)


if __name__ == "__main__":
    unittest.main()
