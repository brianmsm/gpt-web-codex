import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { HerdrClient, HerdrClientError, type HerdrAccessScope } from "./herdr-client";
import { HERDR_PUBLIC_SPECIAL_KEYS } from "./herdr-keys";
import { LunaStateStore } from "./state-store";

const noAuth = [{ type: "noauth" as const }];
const sessionName = z.string().min(1).max(200);
const herdrId = z.string().min(2).max(256);
const localPath = z.string().min(1).max(16_384);
const label = z.string().min(1).max(200);
const permissionMode = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const webSessionId = z.string().min(8).max(256);
const readSource = z.enum(["visible", "recent", "recent_unwrapped", "detection"]);
const specialKey = z.enum(HERDR_PUBLIC_SPECIAL_KEYS).describe(
  "Herdr 0.8.2 special key. Prefer canonical lowercase values; legacy GWC aliases are normalized explicitly before transport.",
);
const health = z.enum(["healthy", "failed", "unknown", "not_found"]);
const errorDetails = z.object({ code: z.string(), message: z.string() });
const operationOutput = {
  web_session_id: webSessionId.optional(),
  health: health.optional(),
  error: errorDetails.optional(),
};
const accessScopeInput = {
  web_session_id: webSessionId.optional(),
  workspace_path: localPath.describe("Absolute disclosed local scope. Relative Herdr path arguments resolve against this path."),
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

type ResolveWebSessionId = (
  explicit: string | undefined,
  meta: Record<string, unknown> | undefined,
  allowCreate: boolean,
) => string;

function recordId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" && id ? id : undefined;
}

function ownershipError(kind: "workspace" | "pane"): HerdrClientError {
  return new HerdrClientError(
    `Herdr ${kind} is not owned by the current web session`,
    "failed",
    "cross_session_ownership",
  );
}

function requireWorkspaceOwner(store: LunaStateStore, webSession: string, herdrSession: string, workspaceId: string): void {
  if (store.herdrWorkspaceOwner(herdrSession, workspaceId) !== webSession) throw ownershipError("workspace");
}

function requirePaneOwner(store: LunaStateStore, webSession: string, herdrSession: string, paneId: string): void {
  if (store.herdrPaneOwner(herdrSession, paneId) !== webSession) throw ownershipError("pane");
}

function claimPane(store: LunaStateStore, webSession: string, herdrSession: string, paneId: string): void {
  const owner = store.herdrPaneOwner(herdrSession, paneId);
  if (owner && owner !== webSession) throw ownershipError("pane");
  store.bindHerdrPane(webSession, herdrSession, paneId);
}

function bindWorkspaceResult(
  store: LunaStateStore, webSession: string, herdrSession: string, value: Record<string, unknown>,
): void {
  const workspaceId = recordId(value.workspace, "workspace_id");
  if (!workspaceId) throw new HerdrClientError("Herdr response omitted workspace_id", "failed", "invalid_workspace_identity");
  const paneIds = new Set<string>();
  const rootPaneId = recordId(value.root_pane, "pane_id");
  if (rootPaneId) paneIds.add(rootPaneId);
  if (Array.isArray(value.panes)) {
    for (const pane of value.panes) {
      const paneId = recordId(pane, "pane_id");
      if (paneId) paneIds.add(paneId);
    }
  }

  const workspaceOwner = store.herdrWorkspaceOwner(herdrSession, workspaceId);
  if (workspaceOwner && workspaceOwner !== webSession) throw ownershipError("workspace");
  for (const paneId of paneIds) {
    const paneOwner = store.herdrPaneOwner(herdrSession, paneId);
    if (paneOwner && paneOwner !== webSession) throw ownershipError("pane");
  }

  store.bindHerdrWorkspace(webSession, herdrSession, workspaceId);
  for (const paneId of paneIds) store.bindHerdrPane(webSession, herdrSession, paneId);
}

export function registerHerdrTools(
  server: McpServer,
  herdr: HerdrClient,
  store: LunaStateStore,
  resolveWebSessionId: ResolveWebSessionId,
): void {
  server.registerTool("herdr_status", {
    title: "Inspect Herdr sessions",
    description: "Discover only daemon-level Herdr session health and transport metadata. This does not expose, adopt, or authorize any workspace or pane binding and is not a cross-web-session reacquisition path. Provide session to inspect one daemon session explicitly; no UI focus or HERDR_ENV context is used.",
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
    description: "Select the Herdr daemon session and disclosed workspace scope explicitly. A matching existing workspace may be adopted only when it is unowned or already bound to the current web session; a workspace bound to another web session is rejected even when cwd matches. Same-session ownership is persisted across GWC restart. Reused multi-pane tabs return all candidate panes and never invent a root pane.",
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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, true);
    const opened = await herdr.openWorkspace(input.session, input.cwd, input.label, scope(input));
    bindWorkspaceResult(store, webSession, input.session, opened);
    return { ...opened, web_session_id: webSession };
  }));

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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, true);
    const created = await herdr.createWorktree(input.session, {
      sourceCwd: input.source_cwd, branch: input.branch, base: input.base, path: input.path, label: input.label,
    }, scope(input));
    bindWorkspaceResult(store, webSession, input.session, created);
    return { ...created, web_session_id: webSession };
  }));

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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requireWorkspaceOwner(store, webSession, input.session, input.workspace_id);
    const created = await herdr.createTab(input.session, { workspaceId: input.workspace_id, cwd: input.cwd, label: input.label }, scope(input));
    const paneId = recordId(created.root_pane, "pane_id");
    if (paneId) claimPane(store, webSession, input.session, paneId);
    return { ...created, web_session_id: webSession };
  }));

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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requirePaneOwner(store, webSession, input.session, input.target_pane_id);
    const created = await herdr.splitPane(input.session, { targetPaneId: input.target_pane_id, direction: input.direction, cwd: input.cwd, ratio: input.ratio }, scope(input));
    const paneId = recordId(created.pane, "pane_id");
    if (paneId) claimPane(store, webSession, input.session, paneId);
    return { ...created, web_session_id: webSession };
  }));

  server.registerTool("herdr_pane_run", {
    title: "Run a command in a Herdr pane",
    description: "Send an arbitrary shell command plus Enter to an explicit scoped Herdr pane PTY. Disabled in read-only mode. Herdr panes contain persistent shells: a healthy pane means the shell is alive, not that the last command is still running. If acknowledgement or result delivery is uncertain, never resend the command automatically; reacquire the same pane with herdr_pane_read, herdr_pane_status, or herdr_pane_wait. For a finite non-interactive command whose completion must be observed, choose a fresh unique nonce before each herdr_pane_run and construct the concrete completion marker only at runtime, so the exact wait string does not appear verbatim in the submitted command that the terminal may echo. Example for one invocation only: nonce=7f3c2d; if <command>; then rc=0; else rc=$?; fi; printf '\\n__HERDR_CMD_DONE_%s__:%d\\n' \"$nonce\" \"$rc\". Then call herdr_pane_wait with match=\"__HERDR_CMD_DONE_7f3c2d__:\" and read the final output. Generate a different nonce for every later invocation in the same pane; never reuse a completion marker, wait on a shared prefix, or embed the concrete wait string verbatim in the command, because persistent scrollback or echoed command input may already satisfy the match. The literal %d is a printf placeholder and is not part of the emitted sentinel. Do not infer command liveness solely from pane health. The process remains owned by Herdr and can persist independently of this GWC process.",
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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requirePaneOwner(store, webSession, input.session, input.pane_id);
    return { ...(await herdr.runPane(input.session, input.pane_id, input.command, scope(input))), web_session_id: webSession };
  }));

  server.registerTool("herdr_pane_read", {
    title: "Read Herdr pane output",
    description: "Read bounded terminal output from an explicit Herdr pane only after verifying both workspace_path scope and current-web-session ownership. Ownership survives GWC restart and cannot be bypassed by danger-full-access. This is observational and never treats an empty/timeout read as evidence that the process is dead.",
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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requirePaneOwner(store, webSession, input.session, input.pane_id);
    return { ...(await herdr.readPane(input.session, { paneId: input.pane_id, source: input.source, lines: input.lines, stripAnsi: input.strip_ansi }, scope(input))), web_session_id: webSession };
  }));

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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requirePaneOwner(store, webSession, input.session, input.pane_id);
    return { ...(await herdr.sendPane(input.session, input.pane_id, input.text, input.keys, scope(input))), web_session_id: webSession };
  }));

  server.registerTool("herdr_pane_wait", {
    title: "Wait for Herdr pane output",
    description: "Use Herdr's own wait-for-output mechanism for an explicit scoped pane instead of aggressive GWC polling. This waits for output matching a condition; it does not track the lifecycle of a shell command. The selected pane snapshot is searched immediately and can include both persistent scrollback and echoed shell input. For each finite command, choose a fresh unique nonce before herdr_pane_run, have the command construct and emit the completion marker at runtime, and wait specifically for that invocation's concrete marker plus colon (for example match=\"__HERDR_CMD_DONE_7f3c2d__:\"). The exact match string must not already exist in scrollback and must not appear verbatim in the submitted command. Never reuse a completion marker, wait on a shared completion prefix, or wait for the literal printf placeholder %d. Do not keep waiting for a success-specific output string after the command has already returned to the shell prompt, and do not infer command liveness solely from pane health. A timeout is observational and never triggers cleanup or process termination.",
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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requirePaneOwner(store, webSession, input.session, input.pane_id);
    return { ...(await herdr.waitPane(input.session, { paneId: input.pane_id, source: input.source, matchType: input.match_type, match: input.match, lines: input.lines, timeoutMs: input.timeout_ms }, scope(input))), web_session_id: webSession };
  }));

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
  }, async (input, extra) => guarded(async () => {
    const webSession = resolveWebSessionId(input.web_session_id, extra._meta, false);
    requirePaneOwner(store, webSession, input.session, input.pane_id);
    return { ...(await herdr.paneStatus(input.session, input.pane_id, scope(input))), web_session_id: webSession };
  }));
}
