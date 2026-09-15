import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { HerdrClient, HerdrClientError, type HerdrAccessScope } from "./herdr-client";

const noAuth = [{ type: "noauth" as const }];
const sessionName = z.string().min(1).max(200);
const herdrId = z.string().min(2).max(256);
const localPath = z.string().min(1).max(16_384);
const label = z.string().min(1).max(200);
const permissionMode = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const readSource = z.enum(["visible", "recent", "recent_unwrapped", "detection"]);
const specialKey = z.enum([
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "Ctrl-C", "Ctrl-D", "Ctrl-Z", "Ctrl-L",
]);
const health = z.enum(["healthy", "failed", "unknown", "not_found"]);
const errorDetails = z.object({ code: z.string(), message: z.string() });
const operationOutput = {
  health: health.optional(),
  error: errorDetails.optional(),
};
const accessScopeInput = {
  workspace_path: localPath,
  permission_mode: permissionMode.default("workspace-write"),
};
const sessionOutput = z.object({
  name: z.string(),
  default: z.boolean(),
  running: z.boolean(),
  session_dir: z.string(),
  socket_path: z.string(),
  health: health.optional(),
  version: z.string().nullable().optional(),
  protocol: z.number().int().nullable().optional(),
  error: z.string().nullable().optional(),
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
};

function toolResult(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{
      type: "text",
      text: isError
        ? "Herdr operation failed. Read structuredContent for health and error details."
        : "Herdr operation completed. Read structuredContent for explicit session/workspace/tab/pane identities.",
    }],
    structuredContent: value,
    ...(isError ? { isError: true as const } : {}),
  };
}

async function guarded(operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    const known = error instanceof HerdrClientError
      ? error
      : new HerdrClientError(
        error instanceof Error ? error.message : String(error),
        "unknown",
        "unknown_error",
        { cause: error },
      );
    return toolResult({
      health: known.health,
      error: { code: known.code, message: known.message },
    }, true);
  }
}

function scope(input: { workspace_path: string; permission_mode: HerdrAccessScope["permissionMode"] }): HerdrAccessScope {
  return { workspacePath: input.workspace_path, permissionMode: input.permission_mode };
}

export function registerHerdrTools(server: McpServer, herdr: HerdrClient): void {
  server.registerTool("herdr_status", {
    title: "Inspect Herdr sessions",
    description: "Discover Herdr sessions through its machine-readable external interface and probe protocol health. Provide session to inspect one explicitly; no UI focus or HERDR_ENV context is used.",
    inputSchema: { session: sessionName.optional() },
    outputSchema: {
      installed: z.boolean(), health, error: errorDetails.nullable(), sessions: z.array(sessionOutput),
      selected_session: z.string().nullable(), selected: sessionOutput.nullable().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async ({ session }) => toolResult(await herdr.status(session)));

  server.registerTool("herdr_workspace_open", {
    title: "Open or create a Herdr workspace",
    description: "Select the Herdr session and disclosed workspace scope explicitly. Reuse the unique workspace whose canonical checkout/pane cwd matches cwd, or create one when the permission mode allows mutation. Reused multi-pane tabs return all candidate panes and never invent a root pane.",
    inputSchema: {
      session: sessionName,
      cwd: localPath,
      label: label.optional(),
      ...accessScopeInput,
    },
    outputSchema: {
      ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), created: z.boolean().optional(),
      cwd: z.string().optional(), workspace: z.unknown().optional(), tab: z.unknown().nullable().optional(),
      root_pane: z.unknown().nullable().optional(), panes: z.array(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.openWorkspace(input.session, input.cwd, input.label, scope(input))));

  server.registerTool("herdr_worktree_create", {
    title: "Create a Herdr worktree workspace",
    description: "Create a Git worktree through Herdr from an explicit source checkout, branch, and optional base/path. Scoped modes require an explicit worktree path inside workspace_path; Herdr opens it as its own workspace and returns real IDs.",
    inputSchema: {
      session: sessionName,
      source_cwd: localPath,
      branch: z.string().min(1).max(1_024),
      base: z.string().min(1).max(1_024).optional(),
      path: localPath.optional(),
      label: label.optional(),
      ...accessScopeInput,
    },
    outputSchema: {
      ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(),
      workspace: z.unknown().optional(), tab: z.unknown().optional(), root_pane: z.unknown().optional(), worktree: z.unknown().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.createWorktree(input.session, {
    sourceCwd: input.source_cwd,
    branch: input.branch,
    base: input.base,
    path: input.path,
    label: input.label,
  }, scope(input))));

  server.registerTool("herdr_tab_create", {
    title: "Create a Herdr tab",
    description: "Create a tab inside an explicit Herdr workspace after verifying that workspace belongs to the disclosed scope. Disabled in read-only mode. The new tab is not selected through implicit UI focus and its real root pane ID is returned.",
    inputSchema: {
      session: sessionName,
      workspace_id: herdrId,
      cwd: localPath.optional(),
      label: label.optional(),
      ...accessScopeInput,
    },
    outputSchema: {
      ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), tab: z.unknown().optional(), root_pane: z.unknown().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.createTab(input.session, {
    workspaceId: input.workspace_id,
    cwd: input.cwd,
    label: input.label,
  }, scope(input))));

  server.registerTool("herdr_pane_split", {
    title: "Create a Herdr pane",
    description: "Split an explicit target pane after verifying it belongs to the disclosed workspace scope. Disabled in read-only mode. Returns the new pane and terminal IDs without depending on UI focus.",
    inputSchema: {
      session: sessionName,
      target_pane_id: herdrId,
      direction: z.enum(["right", "down"]),
      cwd: localPath.optional(),
      ratio: z.number().min(0.05).max(0.95).optional(),
      ...accessScopeInput,
    },
    outputSchema: { ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), pane: z.unknown().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.splitPane(input.session, {
    targetPaneId: input.target_pane_id,
    direction: input.direction,
    cwd: input.cwd,
    ratio: input.ratio,
  }, scope(input))));

  server.registerTool("herdr_pane_run", {
    title: "Run a command in a Herdr pane",
    description: "Send an arbitrary shell command plus Enter to an explicit scoped Herdr pane PTY. Disabled in read-only mode. The process remains owned by Herdr and can persist independently of this GWC process.",
    inputSchema: {
      session: sessionName,
      pane_id: herdrId,
      command: z.string().min(1).max(1_000_000),
      ...accessScopeInput,
    },
    outputSchema: {
      ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), pane_id: z.string().optional(), accepted: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.runPane(input.session, input.pane_id, input.command, scope(input))));

  server.registerTool("herdr_pane_read", {
    title: "Read Herdr pane output",
    description: "Read bounded terminal output from an explicit Herdr pane after verifying it belongs to workspace_path. This is observational and never treats an empty/timeout read as evidence that the process is dead.",
    inputSchema: {
      session: sessionName,
      pane_id: herdrId,
      source: readSource.default("recent"),
      lines: z.number().int().min(1).max(20_000).optional(),
      strip_ansi: z.boolean().default(true),
      ...accessScopeInput,
    },
    outputSchema: { ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), read: z.unknown().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.readPane(input.session, {
    paneId: input.pane_id,
    source: input.source,
    lines: input.lines,
    stripAnsi: input.strip_ansi,
  }, scope(input))));

  server.registerTool("herdr_pane_send", {
    title: "Send input to a Herdr pane",
    description: "Send UTF-8 text and/or a bounded set of special keys to an explicit scoped Herdr pane PTY. Disabled in read-only mode. Input may execute commands, interrupt processes, or interact with external systems.",
    inputSchema: {
      session: sessionName,
      pane_id: herdrId,
      text: z.string().max(1_000_000).default(""),
      keys: z.array(specialKey).max(64).default([]),
      ...accessScopeInput,
    },
    outputSchema: {
      ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), pane_id: z.string().optional(), accepted: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.sendPane(input.session, input.pane_id, input.text, input.keys, scope(input))));

  server.registerTool("herdr_pane_wait", {
    title: "Wait for Herdr pane output",
    description: "Use Herdr's own wait-for-output mechanism for an explicit scoped pane instead of aggressive GWC polling. A timeout is observational and never triggers cleanup or process termination.",
    inputSchema: {
      session: sessionName,
      pane_id: herdrId,
      source: readSource.default("recent"),
      match_type: z.enum(["substring", "regex"]).default("substring"),
      match: z.string().min(1).max(100_000),
      lines: z.number().int().min(1).max(20_000).optional(),
      timeout_ms: z.number().int().min(0).max(300_000).default(30_000),
      ...accessScopeInput,
    },
    outputSchema: {
      ...operationOutput, session: z.string().optional(), socket_path: z.string().optional(), pane_id: z.string().optional(),
      revision: z.number().int().optional(), matched_line: z.string().nullable().optional(), read: z.unknown().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => guarded(async () => await herdr.waitPane(input.session, {
    paneId: input.pane_id,
    source: input.source,
    matchType: input.match_type,
    match: input.match,
    lines: input.lines,
    timeoutMs: input.timeout_ms,
  }, scope(input))));

  server.registerTool("herdr_pane_status", {
    title: "Inspect Herdr pane status",
    description: "Inspect an explicit scoped pane plus its shell/foreground process information when available. Reports healthy, failed, unknown, or not_found without destructive recovery; missing process evidence does not imply a dead pane.",
    inputSchema: {
      session: sessionName,
      pane_id: herdrId,
      ...accessScopeInput,
    },
    outputSchema: {
      session: z.string(), socket_path: z.string().nullable(), pane_id: z.string(), health, pane: z.unknown().nullable(),
      process_info: z.unknown().nullable(), process_error: errorDetails.nullable(), agent_state: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => toolResult(await herdr.paneStatus(input.session, input.pane_id, scope(input))));
}
