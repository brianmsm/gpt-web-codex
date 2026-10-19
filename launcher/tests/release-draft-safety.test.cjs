"use strict";

// Test exactly the shell script used by release.yml without touching GitHub.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const script = path.resolve(__dirname, "../../scripts/stage-release-draft.sh");
const runnable = process.platform !== "win32"
  && spawnSync("bash", ["-n", script]).status === 0
  && spawnSync("python3", ["--version"]).status === 0
  && spawnSync("jq", ["--version"]).status === 0
  && spawnSync("sha256sum", ["--version"]).status === 0;

function withFixture(options, check) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-r5-draft-contract-"));
  try {
    const bin = path.join(temp, "bin");
    const state = path.join(temp, "state");
    const assets = path.join(temp, "release-assets");
    fs.mkdirSync(bin); fs.mkdirSync(state); fs.mkdirSync(assets);
    const good = Buffer.from("synthetic-release-binary; no secrets");
    fs.writeFileSync(path.join(assets, "good.zip"), good);
    fs.writeFileSync(path.join(assets, "checksums.txt"),
      createHash("sha256").update(good).digest("hex") + "  good.zip\n");
    const mock = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf \"%s\\n\" \"$*\" >> \"$MOCK_STATE_DIR/gh.log\"",
      "if [[ \"${1:-}\" == api ]]; then",
      "  endpoint=\"${@: -1}\"",
      "  case \"$endpoint\" in",
      "    repos/example/gwc-test)",
      "      printf 'HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n{\"full_name\":\"example/gwc-test\",\"permissions\":{\"push\":true}}'",
      "      exit 0 ;;",
      "    \"repos/example/gwc-test/releases?per_page=100\")",
      "      if [[ \"$MOCK_EXISTING_RELEASE\" == 1 || -f \"$MOCK_STATE_DIR/created\" ]]; then",
      "        printf '[[{\"id\":711,\"tag_name\":\"v2.3.0\",\"name\":\"v2.3.0\",\"draft\":true,\"prerelease\":false}]]'",
      "      else",
      "        printf '[[]]'",
      "      fi",
      "      exit 0 ;;",
      "    \"repos/example/gwc-test/releases?per_page=100&page=2\")",
      "      printf 'HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n[]'",
      "      exit 0 ;;",
      "    repos/example/gwc-test/releases/tags/v2.3.0)",
      "      if [[ \"$MOCK_EXISTING_RELEASE\" == 1 && \"$MOCK_DRAFT_HIDDEN_BY_TAG\" != 1 || -f \"$MOCK_STATE_DIR/created\" ]]; then",
      "        printf 'HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n{\"tag_name\":\"v2.3.0\"}'",
      "        exit 0",
      "      fi",
      "      printf 'HTTP/2.0 404 Not Found\\ncontent-type: application/json\\n\\n{\"message\":\"Not Found\",\"status\":\"404\"}'",
      "      exit 1 ;;",
      "    *) exit 98 ;;",
      "  esac",
      "fi",
      "if [[ \"${1:-}\" != release ]]; then exit 98; fi",
      "case \"${2:-}\" in",
      "  view)",
      "    if [[ \" $* \" == *\" --json \"* ]]; then",
      "      if [[ ! -f \"$MOCK_STATE_DIR/created\" ]]; then exit 91; fi",
      "      case \"$MOCK_REMOTE_CASE\" in",
      "        exact) printf '{\"databaseId\":811,\"tagName\":\"v2.3.0\",\"isDraft\":true,\"assets\":[{\"name\":\"good.zip\"},{\"name\":\"checksums.txt\"}]}\\n' ;;",
      "        stale) printf '{\"databaseId\":811,\"tagName\":\"v2.3.0\",\"isDraft\":true,\"assets\":[{\"name\":\"good.zip\"},{\"name\":\"checksums.txt\"},{\"name\":\"stale.zip\"}]}\\n' ;;",
      "        published) printf '{\"databaseId\":811,\"tagName\":\"v2.3.0\",\"isDraft\":false,\"assets\":[{\"name\":\"good.zip\"},{\"name\":\"checksums.txt\"}]}\\n' ;;",
      "        *) exit 99 ;;",
      "      esac",
      "    else",
      "      exit 95",
      "    fi",
      "    ;;",
      "  create)",
      "    if [[ \"$MOCK_EXISTING_RELEASE\" == 1 ]]; then exit 97; fi",
      "    touch \"$MOCK_STATE_DIR/created\"",
      "    ;;",
      "  *) exit 96 ;;",
      "esac",
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(bin, "gh"), mock, { mode: 0o700 });
    const env = {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MOCK_STATE_DIR: state,
      MOCK_EXISTING_RELEASE: options.existing ? "1" : "0",
      MOCK_DRAFT_HIDDEN_BY_TAG: options.hiddenDraft ? "1" : "0",
      MOCK_REMOTE_CASE: options.remote || "exact",
      GITHUB_REF_NAME: "v2.3.0",
      GITHUB_REPOSITORY: "example/gwc-test",
      GH_TOKEN: "SYNTHETIC-LOCAL-ONLY",
      GH_HOST: "github.com",
    };
    check({ temp, assets, env, state });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function execute(ctx) {
  const run = spawnSync("bash", [script, ctx.assets], {
    cwd: ctx.temp, env: ctx.env, encoding: "utf8", timeout: 10_000,
  });
  const events = fs.existsSync(path.join(ctx.state, "gh.log"))
    ? fs.readFileSync(path.join(ctx.state, "gh.log"), "utf8").trim().split("\n") : [];
  return { ...run, events };
}

test("fresh tag creates a draft with exact checksummed assets", { skip: !runnable }, () => {
  withFixture({}, ctx => {
    const r = execute(ctx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=2/);
    assert.equal(r.events.filter(x => x.includes(" api ") || x.startsWith("api ")).length, 4);
    assert.ok(r.events.some(x => x.includes("release create") && x.includes("--verify-tag") && x.includes("--draft")));
    assert.ok(!r.events.some(x => x.includes("release upload")));
  });
});
test("existing draft with stale asset is rejected before any upload", { skip: !runnable }, () => {
  withFixture({ existing: true }, ctx => {
    const r = execute(ctx);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Cannot prove absence of draft\/published release/);
    assert.ok(!r.events.some(x => x.includes("release create") || x.includes("release upload")));
  });
});
test("existing published release is rejected before mutation", { skip: !runnable }, () => {
  withFixture({ existing: true, remote: "published" }, ctx => {
    const r = execute(ctx);
    assert.equal(r.status, 3);
    assert.ok(!r.events.some(x => x.includes("release create") || x.includes("release upload")));
  });
});
test("unexpected post-create stale asset fails closed", { skip: !runnable }, () => {
  withFixture({ remote: "stale" }, ctx => {
    const r = execute(ctx);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Remote release response is invalid or draft asset names differ/);
    assert.ok(!r.events.some(x => x.includes("release upload")));
  });
});
test("non-draft response fails rather than claiming success", { skip: !runnable }, () => {
  withFixture({ remote: "published" }, ctx => {
    const r = execute(ctx);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Remote release response is invalid or draft asset names differ/);
  });
});
test("unchecksummed local asset is rejected before GitHub access", { skip: !runnable }, () => {
  withFixture({}, ctx => {
    fs.writeFileSync(path.join(ctx.assets, "stale.zip"), "unmanifested");
    const r = execute(ctx);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Checksum manifest does not exactly describe/);
    assert.equal(r.events.length, 0);
  });
});
test("corrupted checksum is rejected before GitHub access", { skip: !runnable }, () => {
  withFixture({}, ctx => {
    fs.writeFileSync(path.join(ctx.assets, "good.zip"), "changed-after-manifest");
    const r = execute(ctx);
    assert.notEqual(r.status, 0);
    assert.equal(r.events.length, 0);
  });
});

test("draft in REST listing blocks even when get-by-tag returns 404", { skip: !runnable }, () => {
  withFixture({ existing: true, hiddenDraft: true }, ctx => {
    const r = execute(ctx);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Cannot prove absence/);
    assert.ok(!r.events.some(x => x.includes("release create") || x.includes("release upload")));
  });
});
