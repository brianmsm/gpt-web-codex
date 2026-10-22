import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sessionKeyFromOpenAiMetadata,
  parseSessionCapabilityConfig,
} from "../src/standalone/session-capabilities/config";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const fixture = join(import.meta.dir, "fixtures", "external-mcp-stdio.ts");
const syntheticA = "synthetic-web-conversation-A-2026";
const syntheticB = "synthetic-web-conversation-B-2026";
const syntheticCoordinator = "synthetic-web-coordinator-2026";

function config(root: string, role: string) {
  const path = join(root, role + "-external.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    servers: {
      fixture: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        tools: { allow: ["env_probe", "pid_status", "readonly_status", "mutate"] },
        env: { EXTERNAL_MCP_TEST_LITERAL: role },
      },
    },
  }), "utf8");
  return path;
}

function meta(session: string) {
  return { "openai/session": session };
}

function exposed(names: string[]) {
  return [...names].sort();
}

async function connect(statePath: string, configPath: string, globalPath: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--state-path", statePath],
    env: {
      ...getDefaultEnvironment(),
      CODEX_CHATGPT_WEB_SESSION_CAPABILITIES_CONFIG: configPath,
      CODEX_CHATGPT_WEB_EXTERNAL_MCP_CONFIG: globalPath,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client(
    { name: "gwc-session-policy-test", version: "1.0.0" },
    { jsonSchemaValidator: new AjvJsonSchemaValidator() },
  );
  await client.connect(transport, { timeout: 5000, maxTotalTimeout: 5000 });
  return client;
}

async function call(client: Client, session: string | undefined, name: string, args: Record<string, unknown> = {}) {
  const output = await client.callTool({
    name,
    arguments: args,
    ...(session ? { _meta: meta(session) } : {}),
  });
  if ("toolResult" in output) throw new Error("Task response not expected");
  return output;
}

test("capability parser is strict, opt-in and rejects wildcard or unbound external grants", () => {
  const base = {
    version: 1,
    default_policy: "deny",
    profiles: { evaluator: { version: 1, native_tools: [], external_tools: [] } },
    session_bindings: { [sessionKeyFromOpenAiMetadata(meta(syntheticA))]: "evaluator" },
  };
  expect(parseSessionCapabilityConfig(base, "/tmp/abs.json").profiles.size).toBe(1);
  expect(() => parseSessionCapabilityConfig({
    ...base, profiles: { evaluator: { version: 1, native_tools: ["*"], external_tools: [] } },
  }, "/tmp/abs.json")).toThrow("wildcard");
  expect(() => parseSessionCapabilityConfig({
    ...base, profiles: { evaluator: { version: 1, native_tools: [], external_tools: ["fixture__secret"] } },
  }, "/tmp/abs.json")).toThrow("dedicated");
  expect(() => parseSessionCapabilityConfig({
    ...base, session_bindings: { "model-chosen-id": "evaluator" },
  }, "/tmp/abs.json")).toThrow("chatgpt:<sha256>");
  expect(() => parseSessionCapabilityConfig({
    ...base, unknown: true,
  }, "/tmp/abs.json")).toThrow("unsupported");
  const root = mkdtempSync(join(tmpdir(), "gwc-cap-http-deny-"));
  try {
    const externalPath = join(root, "external.json");
    writeFileSync(externalPath, JSON.stringify({
      version: 1, servers: { remote: { transport: "streamable-http", url: "http://127.0.0.1:9000/mcp" } },
    }));
    expect(() => parseSessionCapabilityConfig({
      ...base,
      profiles: { evaluator: {
        version: 1, native_tools: [], external_tools: ["remote__read"], external_mcp_config: externalPath,
      } },
    }, "/tmp/abs.json")).toThrow("session-private stdio");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared discovery catalogs all registered tools while enforcing exact per-session dispatch grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-shared-session-policy-"));
  const globalPath = join(root, "global.json");
  writeFileSync(globalPath, JSON.stringify({ version: 1, servers: {
    global: { transport: "stdio", command: process.execPath, args: [fixture],
      tools: { allow: ["readonly_status", "mutate"] } },
  } }));
  const policyPath = join(root, "policy.json");
  const policy = {
    version: 1,
    catalog_mode: "shared",
    default_policy: "legacy",
    profiles: {
      readonly: {
        version: 1, native_tools: ["external_mcp_status"],
        external_tools: ["global__readonly_status"],
      },
      sealed: { version: 1, native_tools: [], external_tools: [] },
    },
    session_bindings: {
      [sessionKeyFromOpenAiMetadata(meta(syntheticA))]: "readonly",
      [sessionKeyFromOpenAiMetadata(meta(syntheticB))]: "sealed",
    },
  };
  writeFileSync(policyPath, JSON.stringify(policy));
  let client: Client | undefined;
  try {
    client = await connect(join(root, "state.json"), policyPath, globalPath);
    const catalog = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(catalog).toContain("terminal_exec");
    expect(catalog).toContain("file_read");
    expect(catalog).toContain("global__readonly_status");
    expect(catalog).toContain("global__mutate");
    expect(catalog).toContain("capability_identity");
    // ChatGPT supplies no openai/session on tools/list. Unlike the previous
    // per-session mode, shared discovery remains stable across conversations.
    expect((await client.listTools({ _meta: meta(syntheticA) })).tools.map(t => t.name).sort())
      .toEqual(catalog);
    expect((await client.listTools({ _meta: meta(syntheticB) })).tools.map(t => t.name).sort())
      .toEqual(catalog);
    expect((await client.listTools({ _meta: meta(syntheticCoordinator) })).tools.map(t => t.name).sort())
      .toEqual(catalog);

    const allowedNative = await call(client, syntheticA, "external_mcp_status");
    expect(allowedNative.isError).not.toBe(true);
    const allowedExternal = await call(client, syntheticA, "global__readonly_status");
    expect(allowedExternal.isError).not.toBe(true);
    expect(allowedExternal.content).toContainEqual({ type: "text", text: "fixture-ok" });
    const inspector = await call(client, syntheticCoordinator, "capability_identity");
    expect(inspector.structuredContent).toMatchObject({
      catalog_mode: "shared", selected_profile: "legacy",
      effective_tools_verified_by_real_client: false,
    });

    for (const forbidden of ["terminal_exec", "file_read", "file_write", "herdr_pane_run",
      "codexluna_start", "global__mutate", "capability_identity"]) {
      expect((await call(client, syntheticA, forbidden)).isError).toBe(true);
    }
    for (const forbidden of ["terminal_exec", "file_read", "external_mcp_status",
      "global__readonly_status", "global__mutate", "capability_identity"]) {
      expect((await call(client, syntheticB, forbidden)).isError).toBe(true);
    }
    expect((await call(client, undefined, "global__readonly_status")).isError).toBe(true);
    expect((await call(client, syntheticA, "global__mutate", {
      web_session_id: sessionKeyFromOpenAiMetadata(meta(syntheticCoordinator)), value: "BAD",
    })).isError).toBe(true);
    expect((await call(client, syntheticCoordinator, "global__readonly_status")).isError).not.toBe(true);
    // The Windows SDK stdio transport can leave resources/list pending after
    // intensive external MCP traffic. Validate this non-tool denial through a
    // separate native in-memory MCP transport on every platform, while the
    // per-session stdio test below still exercises resource denial on Windows.
    if (process.platform !== "win32") {
      await expect(client.listResources({ _meta: meta(syntheticA) })).rejects.toThrow();
    }
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared catalog mode rejects private external MCP configs, unknown modes and misleading policies", () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-shared-policy-validation-"));
  try {
    const privateServer = config(root, "P");
    const base = {
      version: 1, default_policy: "legacy", catalog_mode: "shared",
      profiles: { test: { version: 1, native_tools: [], external_tools: ["fixture__readonly_status"] } },
      session_bindings: {},
    };
    expect(parseSessionCapabilityConfig(base, join(root, "test.json")).catalogMode).toBe("shared");
    expect(() => parseSessionCapabilityConfig({ ...base, catalog_mode: "invalid" }, join(root, "test.json")))
      .toThrow("catalog_mode");
    expect(() => parseSessionCapabilityConfig({ ...base, profiles: { test: {
      version: 1, native_tools: [], external_tools: ["fixture__readonly_status"],
      external_mcp_config: privateServer,
    } } }, join(root, "test.json"))).toThrow("cannot launch session-private external MCP");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real MCP stdio: per-session catalog and dispatch deny cross-session, native and global tools", async () => {
  if (process.platform === "win32") {
    // The MCP SDK's stdio client explicitly targets Node.js. On Windows
    // Bun 1.3.14 has been observed to lose repeated error responses when
    // acting as the client, even when an identical Node client succeeds
    // against the same Bun-based GWC server. Exercise ALL authorization
    // and cross-session assertions using the supported SDK client runtime;
    // never skip this security test or accept request timeout as denial.
    const child = Bun.spawn({
      cmd: [
        "node",
        join(import.meta.dir, "fixtures", "windows-stdio-node-client.mjs"),
        process.execPath,
        cli,
        fixture,
      ],
      cwd: join(import.meta.dir, ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) {
      // The helper uses synthetic policy data and suppresses request bodies.
      console.error("GWC_WINDOWS_NODE_POLICY_FAILURE=" + stderr.slice(-450));
    }
    expect(exit).toBe(0);
    expect(stdout).toContain("GWC_NODE_WINDOWS_STDIO_POLICY_FULL_PARITY_PASS");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "gwc-session-policy-"));
  const profileA = config(root, "A");
  const profileB = config(root, "B");
  const globalPath = join(root, "global.json");
  writeFileSync(globalPath, JSON.stringify({
    version: 1,
    servers: {
      chrome: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        tools: { allow: ["readonly_status"] },
      },
    },
  }), "utf8");

  const policyPath = join(root, "capabilities.json");
  writeFileSync(policyPath, JSON.stringify({
    version: 1,
    default_policy: "legacy",
    max_external_sessions: 2,
    profiles: {
      evaluatorA: {
        version: 1,
        native_tools: [],
        external_tools: ["fixture__env_probe", "fixture__pid_status", "fixture__readonly_status"],
        external_mcp_config: profileA,
      },
      evaluatorB: {
        version: 1,
        native_tools: [],
        external_tools: ["fixture__env_probe", "fixture__pid_status", "fixture__mutate"],
        external_mcp_config: profileB,
      },
    },
    session_bindings: {
      [sessionKeyFromOpenAiMetadata(meta(syntheticA))]: "evaluatorA",
      [sessionKeyFromOpenAiMetadata(meta(syntheticB))]: "evaluatorB",
    },
  }), "utf8");

  let client: Client | undefined;
  try {
    client = await connect(join(root, "state.json"), policyPath, globalPath);

    const a = await client.listTools({ _meta: meta(syntheticA) });
    const b = await client.listTools({ _meta: meta(syntheticB) });
    const coordinator = await client.listTools({ _meta: meta(syntheticCoordinator) });
    expect(exposed(a.tools.map(t => t.name))).toEqual([
      "fixture__env_probe", "fixture__pid_status", "fixture__readonly_status",
    ]);
    expect(exposed(b.tools.map(t => t.name))).toEqual([
      "fixture__env_probe", "fixture__mutate", "fixture__pid_status",
    ]);
    expect(coordinator.tools.some(t => t.name === "terminal_exec")).toBe(true);
    expect(coordinator.tools.some(t => t.name === "file_read")).toBe(true);
    expect(coordinator.tools.some(t => t.name === "chrome__readonly_status")).toBe(true);
    expect(coordinator.tools.some(t => t.name === "fixture__pid_status")).toBe(false);

    for (const nativeName of ["terminal_exec", "file_read", "herdr_status", "codexluna_start",
      "external_mcp_status", "chrome__readonly_status", "fixture__mutate"]) {
      expect((await call(client, syntheticA, nativeName)).isError).toBe(true);
    }
    expect((await call(client, syntheticB, "fixture__readonly_status")).isError).toBe(true);
    // Deliberately proves the upstream trust limit: an unrestricted raw MCP
    // client can claim either session using unauthenticated request metadata.
    // This is NOT a passing impersonation-defense test for real ChatGPT.
    expect((await call(client, syntheticA, "fixture__env_probe")).structuredContent)
      .toMatchObject({ literal: "A" });
    expect((await call(client, syntheticB, "fixture__env_probe")).structuredContent)
      .toMatchObject({ literal: "B" });
    await expect(client.listResources({ _meta: meta(syntheticA) })).rejects.toThrow();
    const coordinatorResources = await client.listResources({ _meta: meta(syntheticCoordinator) });
    expect(coordinatorResources.resources.length).toBeGreaterThan(0);
    expect((await call(client, undefined, "terminal_exec")).isError).toBe(true);
    expect((await client.listTools()).tools).toEqual([]);

    const aEnvironment = await call(client, syntheticA, "fixture__env_probe");
    const bEnvironment = await call(client, syntheticB, "fixture__env_probe");
    expect(aEnvironment.structuredContent).toMatchObject({ literal: "A" });
    expect(bEnvironment.structuredContent).toMatchObject({ literal: "B" });

    const aPid = await call(client, syntheticA, "fixture__pid_status");
    const bPid = await call(client, syntheticB, "fixture__pid_status");
    const ap = (aPid.structuredContent as { pid: number }).pid;
    const bp = (bPid.structuredContent as { pid: number }).pid;
    expect(ap).toBeGreaterThan(0);
    expect(bp).toBeGreaterThan(0);
    expect(ap).not.toBe(bp);

    expect((await call(client, syntheticB, "fixture__mutate", { value: "B-only" })).isError).not.toBe(true);
    expect((await call(client, syntheticA, "fixture__readonly_status")).isError).not.toBe(true);

    // Forging a regular argument cannot select a different profile. Tool
    // dispatch uses only request metadata, never model-provided arguments.
    expect((await call(client, syntheticA, "fixture__mutate", {
      web_session_id: sessionKeyFromOpenAiMetadata(meta(syntheticB)),
      value: "impersonate B",
    })).isError).toBe(true);
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("admin-only enrollment takes effect after restart; an active session cannot self-enroll", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-session-enrollment-"));
  const globalPath = join(root, "global.json");
  writeFileSync(globalPath, JSON.stringify({ version: 1, servers: {} }));
  const policyPath = join(root, "policy.json");
  const makeConfig = (bound: boolean) => ({
    version: 1,
    default_policy: "deny",
    profiles: { observer: { version: 1, native_tools: ["herdr_status"], external_tools: [] } },
    session_bindings: bound ? { [sessionKeyFromOpenAiMetadata(meta(syntheticA))]: "observer" } : {},
  });
  writeFileSync(policyPath, JSON.stringify(makeConfig(false)));
  let client: Client | undefined;
  try {
    client = await connect(join(root, "state.json"), policyPath, globalPath);
    const first = await client.listTools({ _meta: meta(syntheticA) });
    expect(first.tools.map(t => t.name)).toEqual(["capability_identity"]);
    const identity = await call(client, syntheticA, "capability_identity");
    expect(identity.structuredContent).toMatchObject({
      session_key: sessionKeyFromOpenAiMetadata(meta(syntheticA)),
      selected_profile: "deny",
    });
    writeFileSync(policyPath, JSON.stringify(makeConfig(true)));
    // GWC does not reload supervisor bindings during an evaluation.
    expect((await client.listTools({ _meta: meta(syntheticA) })).tools.map(t => t.name))
      .toEqual(["capability_identity"]);
    await client.close();
    client = undefined;

    client = await connect(join(root, "state-2.json"), policyPath, globalPath);
    expect((await client.listTools({ _meta: meta(syntheticA) })).tools.map(t => t.name))
      .toEqual(["herdr_status"]);
    expect((await call(client, syntheticA, "capability_identity")).isError).toBe(true);
    expect((await call(client, syntheticA, "terminal_exec")).isError).toBe(true);
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("seven-tool A/B synthetic gateway: same source, separate outputs, prompt injection has no GWC escape route", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-session-raters-"));
  const raters = join(import.meta.dir, "fixtures", "session-rater-stdio.ts");
  const publicNames = [
    "study_identity", "get_case_plan", "list_materials", "read_material",
    "current_drafts", "save_artifact", "seal_submission",
  ].map(name => "rater__" + name).sort();
  const profilePaths: Record<string, string> = {};
  for (const role of ["A", "B"]) {
    const outputDir = join(root, "out", role);
    const registry = join(root, role + ".json");
    writeFileSync(registry, JSON.stringify({
      version: 1, servers: {
        rater: {
          transport: "stdio", command: process.execPath, args: [raters],
          env: { SYNTHETIC_RATER_ROLE: role, SYNTHETIC_RATER_OUTPUT: outputDir },
          tools: { allow: publicNames.map(name => name.slice("rater__".length)) },
        },
      },
    }));
    profilePaths[role] = registry;
  }
  const globalPath = join(root, "global.json");
  writeFileSync(globalPath, JSON.stringify({ version: 1, servers: {} }));
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    version: 1, default_policy: "legacy",
    profiles: {
      A: { version: 1, native_tools: [], external_tools: publicNames, external_mcp_config: profilePaths.A },
      B: { version: 1, native_tools: [], external_tools: publicNames, external_mcp_config: profilePaths.B },
    },
    session_bindings: {
      [sessionKeyFromOpenAiMetadata(meta(syntheticA))]: "A",
      [sessionKeyFromOpenAiMetadata(meta(syntheticB))]: "B",
    },
  }));
  let client: Client | undefined;
  try {
    client = await connect(join(root, "state.json"), policyPath, globalPath);
    const namesA = (await client.listTools({ _meta: meta(syntheticA) })).tools.map(tool => tool.name);
    const namesB = (await client.listTools({ _meta: meta(syntheticB) })).tools.map(tool => tool.name);
    expect(namesA).toEqual(publicNames);
    expect(namesB).toEqual(publicNames);
    const identityA = await call(client, syntheticA, "rater__study_identity");
    const identityB = await call(client, syntheticB, "rater__study_identity");
    expect(identityA.structuredContent).toMatchObject({ role: "A" });
    expect(identityB.structuredContent).toMatchObject({ role: "B" });
    expect((identityA.structuredContent as { pid: number }).pid)
      .not.toBe((identityB.structuredContent as { pid: number }).pid);

    const sourceA = await call(client, syntheticA, "rater__read_material", { name: "AGENTS.md" });
    const sourceB = await call(client, syntheticB, "rater__read_material", { name: "AGENTS.md" });
    expect(sourceA.content).toEqual(sourceB.content);
    expect(JSON.stringify(sourceA.content)).toContain("terminal_exec");
    expect(JSON.stringify(sourceA.content)).toContain("external-mcp.json");
    expect((await call(client, syntheticA, "rater__save_artifact", {
      role: "B", value: "attempt cross-rater write",
    })).isError).toBe(true);
    for (const attempted of ["terminal_exec", "file_read", "file_write", "herdr_pane_run",
      "codexluna_init", "chrome__list_pages", "external_mcp_status", "capability_identity"]) {
      expect((await call(client, syntheticA, attempted)).isError).toBe(true);
    }

    expect((await call(client, syntheticA, "rater__save_artifact", { value: "A-private" })).isError).not.toBe(true);
    expect((await call(client, syntheticB, "rater__save_artifact", { value: "B-private" })).isError).not.toBe(true);
    const aDrafts = await call(client, syntheticA, "rater__current_drafts");
    const bDrafts = await call(client, syntheticB, "rater__current_drafts");
    expect(aDrafts.content).toContainEqual({ type: "text", text: "assessment.txt" });
    expect(bDrafts.content).toContainEqual({ type: "text", text: "assessment.txt" });
    const sealed = await call(client, syntheticA, "rater__seal_submission");
    expect((sealed.content[0] as { text: string }).text).toContain('"role":"A"');
    expect((await call(client, syntheticA, "rater__save_artifact", { value: "overwrite" })).isError).toBe(true);
    expect(readFileSync(join(root, "out", "A", "assessment.txt"), "utf8")).toBe("A-private");
    expect(readFileSync(join(root, "out", "B", "assessment.txt"), "utf8")).toBe("B-private");
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing session metadata fails closed when capability policies are active", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-session-policy-missing-"));
  const globalPath = join(root, "global.json");
  writeFileSync(globalPath, JSON.stringify({ version: 1, servers: {} }));
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    version: 1, default_policy: "deny",
    profiles: { evaluator: { version: 1, native_tools: [], external_tools: [] } },
    session_bindings: { [sessionKeyFromOpenAiMetadata(meta(syntheticA))]: "evaluator" },
  }));
  let client: Client | undefined;
  try {
    client = await connect(join(root, "state.json"), policyPath, globalPath);
    expect((await client.listTools()).tools).toEqual([]);
    expect((await client.listTools({ _meta: meta(syntheticB) })).tools.map(t => t.name)).toEqual(["capability_identity"]);
    expect((await client.listTools({ _meta: meta(syntheticA) })).tools).toEqual([]);
    const enrollment = await call(client, syntheticB, "capability_identity");
    expect(enrollment.structuredContent).toMatchObject({
      session_key: sessionKeyFromOpenAiMetadata(meta(syntheticB)),
      selected_profile: "deny",
      chatgpt_memory_controlled: false,
    });
    expect((await call(client, syntheticA, "capability_identity")).isError).toBe(true);
    expect((await call(client, undefined, "file_read")).isError).toBe(true);
    expect((await call(client, syntheticB, "file_read")).isError).toBe(true);
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
