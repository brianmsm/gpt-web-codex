import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCapabilityProfile } from "../src/standalone/session-capabilities/admin";
import { parseSessionCapabilityConfig } from "../src/standalone/session-capabilities/config";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const sessionA = "chatgpt:" + "a".repeat(64);
const sessionB = "chatgpt:" + "b".repeat(64);

function testRoot() {
  const root = mkdtempSync(join(tmpdir(), "gwc-cap-admin-"));
  const file = join(root, "session-capabilities.json");
  const raw = {
    version: 1,
    default_policy: "legacy",
    max_external_sessions: 2,
    profiles: {
      "no-tools": { version: 1, native_tools: [], external_tools: [] },
      "diagnostics-only": { version: 1, native_tools: ["herdr_status"], external_tools: [] },
    },
    session_bindings: {},
  };
  writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  return { root, file };
}

test("generic supervisor binding is explicit, atomic, profile-agnostic and versioned", () => {
  const { root, file } = testRoot();
  try {
    const first = bindCapabilityProfile(file, sessionA, "no-tools");
    expect(first.profile).toBe("no-tools");
    expect(first.restart_required).toBe(true);
    const parsed = parseSessionCapabilityConfig(JSON.parse(readFileSync(file, "utf8")), file);
    expect(parsed.bindings.get(sessionA)).toBe("no-tools");
    expect(parsed.digest).toBe(first.config_sha256);
    expect(lstatSync(file).mode & 0o077).toBe(0);
    expect(existsSync(file + ".lock")).toBe(false);

    expect(() => bindCapabilityProfile(file, sessionA, "diagnostics-only")).toThrow("--replace");
    expect(() => bindCapabilityProfile(file, sessionB, "unknown")).toThrow("Unknown");
    expect(() => bindCapabilityProfile(file, "model-selected-id", "no-tools")).toThrow("--session-key");
    expect(() => bindCapabilityProfile(file, sessionA, "diagnostics-only", true)).not.toThrow();
    expect(() => bindCapabilityProfile(file, sessionB, "no-tools")).not.toThrow();

    const after = parseSessionCapabilityConfig(JSON.parse(readFileSync(file, "utf8")), file);
    expect(after.bindings.get(sessionA)).toBe("diagnostics-only");
    expect(after.bindings.get(sessionB)).toBe("no-tools");
    expect(after.defaultPolicy).toBe("legacy");
    expect(after.profiles.size).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic CLI can inspect and bind profiles without exposing third-party MCP values", () => {
  const { root, file } = testRoot();
  const invoke = (...args: string[]) => Bun.spawnSync({
    cmd: [process.execPath, cli, "capabilities", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CODEX_CHATGPT_WEB_SESSION_CAPABILITIES_CONFIG: file },
  });
  try {
    const check = invoke("check", "--config", file);
    expect(check.exitCode).toBe(0);
    const summary = JSON.parse(check.stdout.toString()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      default_policy: "legacy",
      configured_sessions: 0,
      live_client_discovery_verified: false,
    });
    expect(JSON.stringify(summary)).not.toContain("EXTERNAL_MCP_TEST_SECRET");

    const bind = invoke("bind", "--config", file, "--session-key", sessionA, "--profile", "diagnostics-only");
    expect(bind.exitCode).toBe(0);
    expect(JSON.parse(bind.stdout.toString())).toMatchObject({
      profile: "diagnostics-only", restart_required: true,
    });
    const sessionReport = invoke("check", "--config", file, "--session-key", sessionA);
    expect(JSON.parse(sessionReport.stdout.toString())).toMatchObject({
      configured_profile: "diagnostics-only",
      configured_native_tools: ["herdr_status"],
      configured_external_tools: [],
    });
    expect(invoke("bind", "--config", file, "--session-key", sessionA, "--profile", "no-tools").exitCode).not.toBe(0);
    expect(invoke("bind", "--config", file, "--session-key", sessionA,
      "--profile", "no-tools", "--replace").exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing administrative lock prevents concurrent policy binding", () => {
  const { root, file } = testRoot();
  try {
    writeFileSync(file + ".lock", "held", { mode: 0o600 });
    expect(() => bindCapabilityProfile(file, sessionA, "no-tools")).toThrow("locked");
    expect(parseSessionCapabilityConfig(JSON.parse(readFileSync(file, "utf8")), file).bindings.size).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the published example is a valid generic policy without external project files", () => {
  const example = join(import.meta.dir, "..", "session-capabilities.example.json");
  const parsed = parseSessionCapabilityConfig(JSON.parse(readFileSync(example, "utf8")), example);
  expect(parsed.defaultPolicy).toBe("legacy");
  expect(parsed.profiles.has("no-tools")).toBe(true);
  expect(parsed.profiles.has("diagnostics-only")).toBe(true);
  expect(parsed.bindings.size).toBe(0);
});

test("supervisor admin commands refuse writable configuration or symlink replacement", () => {
  if (process.platform === "win32") return;
  const { root, file } = testRoot();
  const link = join(root, "link.json");
  try {
    chmodSync(file, 0o666);
    expect(() => bindCapabilityProfile(file, sessionA, "no-tools")).toThrow("writable");
    chmodSync(file, 0o600);
    symlinkSync(file, link);
    expect(() => bindCapabilityProfile(link, sessionA, "no-tools")).toThrow("symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
