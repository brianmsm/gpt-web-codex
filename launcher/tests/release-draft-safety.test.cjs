"use strict";

// Static publication invariants. The stateful GitHub CLI path is tested using
// a fake local command runner in tests/test_stage_release_draft.py.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("single-maintainer publication stages a draft, never publishes automatically", () => {
  const script = fs.readFileSync(path.join(root, "scripts/stage_release_draft.py"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(script, /"gh", "release", "create"/);
  assert.match(script, /"--draft"/);
  assert.match(script, /"--verify-tag"/);
  assert.match(script, /"checksum(s)?\.txt"/);
  assert.match(script, /Remote asset SHA-256/);
  assert.match(workflow, /Stage fresh checksummed GitHub Release draft/);
  assert.doesNotMatch(workflow, /release-staging|RELEASE_APPROVED_COMMIT_SHA/);
  assert.doesNotMatch(script, /"release", "publish"|--draft=false/);
});
