/**
 * Node.js-side MCP stdio terminal security fixture for Windows hosts.
 *
 * Runs exactly the same Bun-based GWC MCP server as the release. Uses Node for
 * the SDK stdio client, which is the runtime supported by the TypeScript SDK.
 * No real sessions, secrets or external MCP credentials are used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const [bunExe, serverCli, mode] = process.argv.slice(2);
if (!bunExe || !serverCli || !["ownership", "exec"].includes(mode)) {
  throw new Error("Invalid synthetic terminal fixture arguments");
}
const meta = value => ({ "openai/session": value });
const canonicalId = value =>
  "chatgpt:" + createHash("sha256").update(value.trim(), "utf8").digest("hex");

async function main() {
  const root = mkdtempSync(join(tmpdir(), "gwc-node-terminal-mcp-"));
  const transport = new StdioClientTransport({
    command: bunExe,
    args: [serverCli, "mcp", "--state-path", join(root, "state.json")],
    env: {
      ...getDefaultEnvironment(),
      CODEX_CHATGPT_WEB_EXTERNAL_MCP_CONFIG: join(root, "no-external-mcp.json"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "gwc-node-terminal-" + mode, version: "1.0.0" });
  const owner = "terminal-owner-a";
  const foreign = "terminal-owner-b";
  const invoke = (identity, name, args = {}) =>
    client.callTool({
      name, arguments: args, ...(identity ? { _meta: meta(identity) } : {}),
    });
  try {
    await client.connect(transport, { timeout: 6_000, maxTotalTimeout: 6_000 });
    if (mode === "ownership") {
      const started = await invoke(owner, "terminal_start", {
        command: process.platform === "win32"
          ? '$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput()); $line = $reader.ReadLine(); Write-Output "INPUT:$line"'
          : "read line; printf 'INPUT:%s\\n' \"$line\"",
        cwd: ".", workspace_path: root, permission_mode: "workspace-write",
      });
      assert.notEqual(started.isError, true);
      const job = started.structuredContent;
      assert.equal(job.web_session_id, canonicalId(owner));
      assert.equal(job.status, "running");

      for (const [name, args] of [
        ["terminal_status", { job_id: job.job_id }],
        ["terminal_write_stdin", { job_id: job.job_id, input: "intrusion\n", close: true }],
        ["terminal_cancel", { job_id: job.job_id }],
      ]) {
        const denied = await invoke(foreign, name, args);
        assert.equal(denied.isError, true, name + " must deny foreign session");
        assert.ok(JSON.stringify(denied.content).includes("current web session"));
      }
      const ownerStatus = await invoke(owner, "terminal_status", { job_id: job.job_id });
      assert.notEqual(ownerStatus.isError, true);
      assert.equal(ownerStatus.structuredContent.status, "running");
      assert.equal(ownerStatus.structuredContent.web_session_id, canonicalId(owner));

      const write = await invoke(owner, "terminal_write_stdin", {
        job_id: job.job_id, input: "owner\n", close: true,
      });
      assert.notEqual(write.isError, true);
      const deadline = Date.now() + 18_000;
      let final = ownerStatus.structuredContent;
      let polls = 0;
      while (final.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 125));
        const status = await invoke(owner, "terminal_status", { job_id: job.job_id });
        assert.notEqual(status.isError, true);
        final = status.structuredContent;
        polls += 1;
      }
      assert.equal(final.status, "completed", "owner terminal must complete; polls=" + polls);
      assert.equal(final.exit_code, 0);
      assert.ok(final.stdout.includes("INPUT:owner"));

      const spoof = await client.callTool({
        name: "terminal_status",
        arguments: { web_session_id: canonicalId(owner), job_id: job.job_id },
        _meta: meta(foreign),
      });
      assert.equal(spoof.isError, true);
      assert.ok(JSON.stringify(spoof.content).includes("authoritative ChatGPT openai/session metadata"));
      console.log("GWC_NODE_TERMINAL_OWNERSHIP_PASS");
    } else {
      const started = await invoke(undefined, "terminal_exec", {
        command: process.platform === "win32"
          ? "Write-Output 'MCP_TERMINAL_OK'"
          : "printf 'MCP_TERMINAL_OK\\n'",
        cwd: ".", workspace_path: root, permission_mode: "workspace-write",
        wait_timeout_ms: 5_000,
      });
      assert.notEqual(started.isError, true);
      let state = started.structuredContent;
      const deadline = Date.now() + 18_000;
      let polls = 0;
      while (state.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 125));
        const next = await client.callTool({
          name: "terminal_status",
          arguments: { web_session_id: state.web_session_id, job_id: state.job_id },
        });
        assert.notEqual(next.isError, true);
        state = next.structuredContent;
        polls += 1;
      }
      assert.equal(state.status, "completed", "one-shot terminal must finish; polls=" + polls);
      assert.equal(state.exit_code, 0);
      assert.ok(state.stdout.includes("MCP_TERMINAL_OK"));
      console.log("GWC_NODE_TERMINAL_EXEC_PASS");
    }
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const category = error instanceof Error ? error.name : "UnknownError";
  const reason = error instanceof Error ? error.message.slice(0, 250) : "";
  console.error("GWC_NODE_TERMINAL_" + mode + "_FAILED " + category + " " + reason);
  process.exitCode = 1;
}
