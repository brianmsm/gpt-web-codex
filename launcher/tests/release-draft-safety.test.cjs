"use strict";

// R6 entrypoint and client contracts. The Python release suite owns stateful
// REST/TLS tests; no case in this file can contact or mutate GitHub.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/stage-release-draft.sh");
const python = path.join(root, "scripts/stage_release_draft.py");
const runnable = process.platform !== "win32"
  && spawnSync("bash", ["-n", script]).status === 0
  && spawnSync("python3", ["-B", "-c", "import ssl,http.client,json"]).status === 0;

function fixture(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gwc-r6-local-"));
  try {
    const assets = path.join(temp, "assets");
    fs.mkdirSync(assets);
    const data = Buffer.from("synthetic R6 local input\n");
    fs.writeFileSync(path.join(assets, "good.zip"), data);
    fs.writeFileSync(path.join(assets, "checksums.txt"),
      createHash("sha256").update(data).digest("hex") + "  good.zip\n");
    const env = {
      ...process.env,
      GITHUB_REF_NAME: "v2.3.0",
      GITHUB_REPOSITORY: "synthetic/release-fixture",
      GH_HOST: "github.com",
      GH_TOKEN: "R6_SYNTHETIC_NO_REAL_ACCESS",
      RELEASE_APPROVED_COMMIT_SHA: "",
      RELEASE_STAGE_JOURNAL: path.join(temp, "journal.json"),
    };
    fn({ temp, assets, env });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function run(ctx) {
  return spawnSync("bash", [script, ctx.assets], {
    cwd: ctx.temp, env: ctx.env, encoding: "utf8", timeout: 7000,
  });
}

function checkPython(code) {
  const result = spawnSync("python3", ["-B", "-c",
    "import sys;sys.path.insert(0," + JSON.stringify(path.join(root, "scripts")) + ");" + code], {
    encoding: "utf8", timeout: 7000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("release workflow entrypoint delegates to strict REST Python, not gh", { skip: !runnable }, () => {
  assert.match(fs.readFileSync(script, "utf8"), /exec python3 -B/);
  assert.doesNotMatch(fs.readFileSync(script, "utf8"), /gh release (?:create|view|upload)/);
  assert.match(fs.readFileSync(python, "utf8"), /http\.client\.HTTPSConnection/);
});

test("missing independent SHA prevents any remote call", { skip: !runnable }, () => {
  fixture(ctx => {
    const r = run(ctx);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Invalid commit SHA/);
    assert.equal(fs.existsSync(ctx.env.RELEASE_STAGE_JOURNAL), false);
  });
});

test("unchecksummed file is refused before any remote access", { skip: !runnable }, () => {
  fixture(ctx => {
    fs.writeFileSync(path.join(ctx.assets, "stale.zip"), "stale");
    const r = run(ctx);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Checksum manifest/);
    assert.equal(fs.existsSync(ctx.env.RELEASE_STAGE_JOURNAL), false);
  });
});

test("a mutated checksummed binary is refused", { skip: !runnable }, () => {
  fixture(ctx => {
    fs.writeFileSync(path.join(ctx.assets, "good.zip"), "mutated");
    const r = run(ctx);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Checksum verification failed/);
    assert.equal(fs.existsSync(ctx.env.RELEASE_STAGE_JOURNAL), false);
  });
});

test("REST JSON requires full consumption and casefold-unique keys", { skip: !runnable }, () => {
  checkPython(`import stage_release_draft as s
for b in (b'{}\\0',b'{} junk',b'{}{}',b'{"draft":false,"draft":true}',b'{"DRAFT":false,"draft":true}',b'[NaN]'):
 try:s.strict_json(b);assert False,b
 except s.StageError:pass
assert s.strict_json(b'{"ok":true}') == {'ok':True}`);
});

test("release ID never accepts postflight object B", { skip: !runnable }, () => {
  checkPython(`import stage_release_draft as s
stem='/repos/synthetic/release-fixture/releases'
r={'id':100101,'tag_name':'v2.3.0','name':'v2.3.0','draft':True,'prerelease':False,'url':s.API+stem+'/100101','upload_url':s.UPLOADS+stem+'/100101/assets{?name,label}','assets':[]}
try:s.release_identity(r,stem,'v2.3.0',100001);assert False
except s.StageError:pass`);
});

test("missing name invalid, name null valid", { skip: !runnable }, () => {
  checkPython(`import stage_release_draft as s
r={'id':1,'tag_name':'old','draft':False,'prerelease':False}
try:s.release_entry(r,'v2.3.0');assert False
except s.StageError:pass
r['name']=None;assert s.release_entry(r,'v2.3.0')==(1,'old')`);
});

test("upload_url refuses release-ID substitution and external host", { skip: !runnable }, () => {
  checkPython(`import stage_release_draft as s
stem='/repos/synthetic/release-fixture/releases'
for url in ('https://evil.invalid'+stem+'/100001/assets{?name,label}',s.UPLOADS+stem+'/100101/assets{?name,label}'):
 try:s.upload_template({'upload_url':url},stem,100001);assert False
 except s.StageError:pass`);
});

test("asset SHA-256 and uploaded state are gates, not just filenames", { skip: !runnable }, () => {
  checkPython(`import stage_release_draft as s
r={'id':1,'name':'test.zip','state':'uploaded','size':3,'digest':'sha256:'+'0'*64}
try:s.asset_identity(r,'test.zip',3,'f'*64,set(),'/repos/synthetic/release-fixture/releases');assert False
except s.StageError:pass
r['digest']='sha256:'+'f'*64;r['state']='starter'
try:s.asset_identity(r,'test.zip',3,'f'*64,set(),'/repos/synthetic/release-fixture/releases');assert False
except s.StageError:pass`);
});
