import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execFileSync } from "node:child_process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

async function connectClient(statePath: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", statePath],
    cwd: process.cwd(),
    stderr: "pipe",
  }));
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args }) as ToolCallResult;
  if (response.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(response.structuredContent ?? response.content)}`);
  }
  return asRecord(response.structuredContent, `${name} structuredContent`);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

const session = process.env.GWC_HERDR_SESSION?.trim() || "default";
const root = mkdtempSync(join(tmpdir(), "gwc-herdr-smoke-"));
const statePath = join(root, "mcp-state.json");
const sourceRepo = join(root, "source");
const worktreePath = join(root, "worker");
const branch = `gwc-herdr-smoke-${process.pid}`;
mkdirSync(sourceRepo);
execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "gwc-herdr-smoke@localhost"], { cwd: sourceRepo });
execFileSync("git", ["config", "user.name", "GWC Herdr Smoke"], { cwd: sourceRepo });
writeFileSync(join(sourceRepo, "README.txt"), "Disposable GPT Web Codex / Herdr smoke repository.\n", "utf8");
execFileSync("git", ["add", "README.txt"], { cwd: sourceRepo });
execFileSync("git", ["commit", "-m", "smoke baseline"], { cwd: sourceRepo, stdio: "ignore" });

let first: Client | undefined;
let second: Client | undefined;
try {
  first = await connectClient(statePath, "gwc-herdr-smoke-before-restart");
  const health = await callTool(first, "herdr_status", { session });
  if (health.health !== "healthy") throw new Error(`Herdr session ${session} is not healthy: ${JSON.stringify(health)}`);

  const integration = await callTool(first, "herdr_workspace_open", {
    session,
    cwd: sourceRepo,
    label: `gwc-herdr-smoke-source-${process.pid}`,
  });
  const integrationWorkspace = asRecord(integration.workspace, "integration workspace");
  const integrationWorkspaceId = stringField(integrationWorkspace, "workspace_id");

  const opened = await callTool(first, "herdr_worktree_create", {
    session,
    source_cwd: sourceRepo,
    branch,
    base: "main",
    path: worktreePath,
    label: `gwc-herdr-smoke-${process.pid}`,
  });
  const workspace = asRecord(opened.workspace, "workspace");
  const tab = asRecord(opened.tab, "tab");
  const pane = asRecord(opened.root_pane, "root_pane");
  const worktree = asRecord(opened.worktree, "worktree");
  if (stringField(worktree, "path") !== worktreePath || worktree.branch !== branch) {
    throw new Error(`Unexpected Herdr worktree identity: ${JSON.stringify(worktree)}`);
  }
  const workspaceId = stringField(workspace, "workspace_id");
  const tabId = stringField(tab, "tab_id");
  const paneId = stringField(pane, "pane_id");
  const terminalId = stringField(pane, "terminal_id");

  const workerCommand = "printf 'GWC_HERDR_READY\\n'; while IFS= read -r line; do printf 'GWC_HERDR_ECHO:%s\\n' \"$line\"; [ \"$line\" = '__gwc_exit__' ] && break; done";
  await callTool(first, "herdr_pane_run", { session, pane_id: paneId, command: workerCommand });
  await callTool(first, "herdr_pane_wait", {
    session,
    pane_id: paneId,
    source: "recent",
    match_type: "substring",
    match: "GWC_HERDR_READY",
    timeout_ms: 5_000,
  });
  await callTool(first, "herdr_pane_send", {
    session,
    pane_id: paneId,
    text: "hello-before-restart",
    keys: ["Enter"],
  });
  await callTool(first, "herdr_pane_wait", {
    session,
    pane_id: paneId,
    source: "recent",
    match_type: "substring",
    match: "GWC_HERDR_ECHO:hello-before-restart",
    timeout_ms: 5_000,
  });
  const beforeRestart = await callTool(first, "herdr_pane_status", { session, pane_id: paneId });

  await first.close();
  first = undefined;

  second = await connectClient(statePath, "gwc-herdr-smoke-after-restart");
  const resumed = await callTool(second, "herdr_pane_read", {
    session,
    pane_id: paneId,
    source: "recent",
    lines: 200,
    strip_ansi: true,
  });
  const read = asRecord(resumed.read, "pane read");
  const text = stringField(read, "text");
  if (!text.includes("GWC_HERDR_READY") || !text.includes("GWC_HERDR_ECHO:hello-before-restart")) {
    throw new Error(`Fresh MCP process did not recover the expected pane output: ${JSON.stringify(read)}`);
  }

  await callTool(second, "herdr_pane_send", {
    session,
    pane_id: paneId,
    text: "hello-after-restart",
    keys: ["Enter"],
  });
  await callTool(second, "herdr_pane_wait", {
    session,
    pane_id: paneId,
    source: "recent",
    match_type: "substring",
    match: "GWC_HERDR_ECHO:hello-after-restart",
    timeout_ms: 5_000,
  });
  const afterRestart = await callTool(second, "herdr_pane_status", { session, pane_id: paneId });

  await callTool(second, "herdr_pane_send", {
    session,
    pane_id: paneId,
    text: "__gwc_exit__",
    keys: ["Enter"],
  });
  await callTool(second, "herdr_pane_wait", {
    session,
    pane_id: paneId,
    source: "recent",
    match_type: "substring",
    match: "GWC_HERDR_ECHO:__gwc_exit__",
    timeout_ms: 5_000,
  });

  const receipt = {
    ok: true,
    session,
    source_repo: sourceRepo,
    worktree_path: worktreePath,
    branch,
    integration_workspace_id: integrationWorkspaceId,
    worker_workspace_id: workspaceId,
    workspace_label: typeof workspace.label === "string" ? workspace.label : null,
    tab_id: tabId,
    pane_id: paneId,
    terminal_id: terminalId,
    protocol: asRecord(health.selected, "selected session").protocol ?? null,
    before_restart_health: beforeRestart.health ?? null,
    after_restart_health: afterRestart.health ?? null,
    same_pane_after_mcp_restart: true,
    workspace_left_open_in_herdr: true,
    note: "The worker loop was ended cleanly, but the Herdr workspace and shell pane are intentionally left open for visual inspection. No Herdr close/remove/kill operation is issued by this smoke test.",
  };
  writeFileSync(join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await first?.close().catch(() => undefined);
  await second?.close().catch(() => undefined);
}
