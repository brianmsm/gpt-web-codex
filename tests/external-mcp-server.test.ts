import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures", "external-mcp-stdio.ts");
const cli = join(import.meta.dir, "..", "src", "cli.ts");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`external MCP child ${pid} did not exit`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("real GWC MCP server publishes native and external tools in one startup catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-external-server-"));
  const configPath = join(root, "external-mcp.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    servers: {
      fixture: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        tools: { allow: ["readonly_status", "pid_status"] },
        startup_timeout_ms: 5000,
        call_timeout_ms: 1000,
      },
    },
  }), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--state-path", statePath],
    env: {
      ...getDefaultEnvironment(),
      CODEX_CHATGPT_WEB_EXTERNAL_MCP_CONFIG: configPath,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {
    // Keep the subprocess pipe drained without mixing server diagnostics into test output.
  });

  const client = new Client(
    { name: "gwc-external-server-test", version: "1.0.0" },
    { jsonSchemaValidator: new AjvJsonSchemaValidator() },
  );
  let externalPid: number | undefined;
  try {
    await client.connect(transport, { timeout: 5000, maxTotalTimeout: 5000 });
    const listing = await client.listTools();
    const names = new Set(listing.tools.map(tool => tool.name));

    for (const nativeName of [
      "codexluna_init",
      "file_read",
      "terminal_status",
      "herdr_status",
      "external_mcp_status",
    ]) {
      expect(names.has(nativeName)).toBe(true);
    }
    expect(names.has("fixture__readonly_status")).toBe(true);
    expect(names.has("fixture__pid_status")).toBe(true);

    const external = await client.callTool({
      name: "fixture__readonly_status",
      arguments: {},
    });
    if ("toolResult" in external) throw new Error("unexpected task result");
    expect(external.isError, JSON.stringify(external)).not.toBe(true);
    expect(external.content).toContainEqual({ type: "text", text: "fixture-ok" });

    const pidResult = await client.callTool({ name: "fixture__pid_status", arguments: {} });
    if ("toolResult" in pidResult) throw new Error("unexpected task result");
    externalPid = (pidResult.structuredContent as { pid?: number } | undefined)?.pid;
    expect(externalPid).toBeNumber();
    expect(processExists(externalPid!)).toBe(true);

    const status = await client.callTool({ name: "external_mcp_status", arguments: {} });
    if ("toolResult" in status) throw new Error("unexpected task result");
    expect(status.structuredContent).toMatchObject({
      config_loaded: true,
      servers_configured: 1,
      servers: [{
        alias: "fixture",
        lifecycle: "connected",
        tools_discovered: 12,
        tools_exposed: 2,
      }],
    });
  } finally {
    await client.close().catch(() => undefined);
    if (externalPid !== undefined) await waitForProcessExit(externalPid);
    rmSync(root, { recursive: true, force: true });
  }
});
