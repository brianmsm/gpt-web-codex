/**
 * Strict Node.js MCP client for the Windows stdio policy integration test.
 *
 * The MCP TypeScript SDK's StdioClientTransport targets Node.js. The server
 * remains the same Bun-based GPT Web Codex runtime used in release builds.
 * All identities, policies and third-party servers in this fixture are synthetic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const [bunExe, serverCli, externalFixture] = process.argv.slice(2);
if (![bunExe, serverCli, externalFixture].every(value => typeof value === "string" && value.length)) {
  throw new Error("Missing synthetic Windows MCP test runner argument");
}
const A = "synthetic-web-conversation-A-2026";
const B = "synthetic-web-conversation-B-2026";
const coordinator = "synthetic-web-coordinator-2026";
const meta = identity => ({ "openai/session": identity });
const sessionKey = identity =>
  "chatgpt:" + createHash("sha256").update(identity.trim(), "utf8").digest("hex");
const sorted = names => [...names].sort();
const writeSyntheticJson = (path, obj) => writeFileSync(path, JSON.stringify(obj), { mode: 0o600 });

function profileConfig(root, role) {
  const path = join(root, "profile-" + role + ".json");
  writeSyntheticJson(path, {
    version: 1,
    servers: {
      fixture: {
        transport: "stdio",
        command: bunExe,
        args: [externalFixture],
        tools: { allow: ["env_probe", "pid_status", "readonly_status", "mutate"] },
        env: { EXTERNAL_MCP_TEST_LITERAL: role },
      },
    },
  });
  return path;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "gwc-node-policy-stdio-"));
  let client;
  try {
    const policyPath = join(root, "capabilities.json");
    const globalPath = join(root, "global.json");
    const profileA = profileConfig(root, "A");
    const profileB = profileConfig(root, "B");
    writeSyntheticJson(globalPath, {
      version: 1,
      servers: {
        chrome: {
          transport: "stdio",
          command: bunExe,
          args: [externalFixture],
          tools: { allow: ["readonly_status"] },
        },
      },
    });
    writeSyntheticJson(policyPath, {
      version: 1,
      default_policy: "legacy",
      max_external_sessions: 2,
      profiles: {
        evaluatorA: {
          version: 1, native_tools: [],
          external_tools: ["fixture__env_probe", "fixture__pid_status", "fixture__readonly_status"],
          external_mcp_config: profileA,
        },
        evaluatorB: {
          version: 1, native_tools: [],
          external_tools: ["fixture__env_probe", "fixture__pid_status", "fixture__mutate"],
          external_mcp_config: profileB,
        },
      },
      session_bindings: {
        [sessionKey(A)]: "evaluatorA",
        [sessionKey(B)]: "evaluatorB",
      },
    });

    const transport = new StdioClientTransport({
      command: bunExe,
      args: [serverCli, "mcp", "--state-path", join(root, "state.json")],
      env: {
        ...getDefaultEnvironment(),
        CODEX_CHATGPT_WEB_SESSION_CAPABILITIES_CONFIG: policyPath,
        CODEX_CHATGPT_WEB_EXTERNAL_MCP_CONFIG: globalPath,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    client = new Client(
      { name: "gwc-windows-node-stdio-policy", version: "1.0.0" },
      { jsonSchemaValidator: new AjvJsonSchemaValidator() },
    );
    await client.connect(transport, { timeout: 6_000, maxTotalTimeout: 6_000 });
    const list = identity => client.listTools({ _meta: meta(identity) },
      { timeout: 5_000, maxTotalTimeout: 5_000 });
    const call = (identity, name, args = {}) =>
      client.callTool({
        name, arguments: args, ...(identity ? { _meta: meta(identity) } : {}),
      });

    const aTools = await list(A);
    const bTools = await list(B);
    const coordinatorTools = await list(coordinator);
    assert.deepEqual(sorted(aTools.tools.map(x => x.name)), [
      "fixture__env_probe", "fixture__pid_status", "fixture__readonly_status",
    ]);
    assert.deepEqual(sorted(bTools.tools.map(x => x.name)), [
      "fixture__env_probe", "fixture__mutate", "fixture__pid_status",
    ]);
    for (const required of ["terminal_exec", "file_read", "chrome__readonly_status"]) {
      assert.ok(coordinatorTools.tools.some(tool => tool.name === required));
    }
    assert.ok(!coordinatorTools.tools.some(tool => tool.name === "fixture__pid_status"));

    for (const denied of [
      "terminal_exec", "file_read", "herdr_status", "codexluna_start",
      "external_mcp_status", "chrome__readonly_status", "fixture__mutate",
    ]) {
      assert.equal((await call(A, denied)).isError, true, denied + " must fail closed for A");
    }
    assert.equal((await call(B, "fixture__readonly_status")).isError, true);
    assert.equal((await call(A, "fixture__env_probe")).structuredContent.literal, "A");
    assert.equal((await call(B, "fixture__env_probe")).structuredContent.literal, "B");

    const deniedResources = async () => {
      let rejected = false;
      try {
        await client.listResources({ _meta: meta(A) }, { timeout: 5_000, maxTotalTimeout: 5_000 });
      } catch (error) {
        assert.ok(error instanceof Error &&
          error.message.includes("Capability policy denied non-tool MCP request"),
        "resources/list must return an explicit security denial, not a timeout");
        rejected = true;
      }
      assert.equal(rejected, true, "restricted resources/list cannot succeed");
    };

    await deniedResources();
    const coordinatorResources = await client.listResources(
      { _meta: meta(coordinator) }, { timeout: 5_000, maxTotalTimeout: 5_000 });
    assert.ok(coordinatorResources.resources.length > 0);
    assert.equal((await call(undefined, "terminal_exec")).isError, true);
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await call(A, "fixture__env_probe")).structuredContent.literal, "A");
    assert.equal((await call(B, "fixture__env_probe")).structuredContent.literal, "B");

    const ap = (await call(A, "fixture__pid_status")).structuredContent.pid;
    const bp = (await call(B, "fixture__pid_status")).structuredContent.pid;
    assert.ok(Number.isSafeInteger(ap) && ap > 0);
    assert.ok(Number.isSafeInteger(bp) && bp > 0);
    assert.notEqual(ap, bp);

    assert.notEqual((await call(B, "fixture__mutate", { value: "B-only" })).isError, true);
    assert.notEqual((await call(A, "fixture__readonly_status")).isError, true);
    assert.equal((await call(A, "fixture__mutate", {
      web_session_id: sessionKey(B), value: "impersonate B",
    })).isError, true);

    // Require repeated negative/positive resource replies on the SAME stdio
    // connection. An SDK timeout is never accepted as an authorization result.
    for (let round = 0; round < 8; round++) {
      await deniedResources();
      const list = await client.listResources(
        { _meta: meta(coordinator) }, { timeout: 5_000, maxTotalTimeout: 5_000 });
      assert.ok(list.resources.length > 0);
    }
    console.log("GWC_NODE_WINDOWS_STDIO_POLICY_FULL_PARITY_PASS");
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  // This script processes synthetic policy data only. Do not echo raw request
  // objects, third-party outputs, user file contents or environment secrets.
  console.error("GWC_NODE_WINDOWS_STDIO_POLICY_FAILED " +
    (error instanceof Error ? error.name + ": " + error.message.slice(0, 180) : "UnknownError"));
  process.exitCode = 1;
}
