import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { normalizeHerdrSpecialKey } from "./herdr-keys";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_PROTOCOL = 20;

export type HerdrHealth = "healthy" | "failed" | "unknown" | "not_found";

export interface HerdrSessionInfo {
  name: string;
  default: boolean;
  running: boolean;
  sessionDir: string;
  socketPath: string;
}

export interface HerdrWireRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface HerdrWireSuccess {
  id: string;
  result: Record<string, unknown>;
}

interface HerdrWireFailure {
  id: string;
  error: { code: string; message: string };
}

type DiscoverSessions = () => Promise<HerdrSessionInfo[]>;
type SendRequest = (socketPath: string, request: HerdrWireRequest, timeoutMs: number) => Promise<unknown>;

export interface HerdrClientOptions {
  executable?: string;
  discoverSessions?: DiscoverSessions;
  sendRequest?: SendRequest;
}

export class HerdrClientError extends Error {
  constructor(
    message: string,
    readonly health: HerdrHealth,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HerdrClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalOrResolved(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

function apiErrorHealth(code: string): HerdrHealth {
  if (code.includes("not_found")) return "not_found";
  if (code === "timeout") return "unknown";
  return "failed";
}

export async function requestHerdrSocket(
  socketPath: string,
  request: HerdrWireRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = new Socket();
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    };
    const finishValue = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolvePromise(value);
    };
    const parseLine = (line: string) => {
      try {
        finishValue(JSON.parse(line));
      } catch (cause) {
        finishError(new HerdrClientError(
          `Herdr returned malformed JSON on ${socketPath}`,
          "failed",
          "malformed_response",
          { cause },
        ));
      }
    };
    const timer = setTimeout(() => finishError(new HerdrClientError(
      `Timed out waiting for Herdr socket ${socketPath}`,
      "unknown",
      "socket_timeout",
    )), timeoutMs);
    timer.unref?.();

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", chunk => {
      buffer += String(chunk);
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finishError(new HerdrClientError("Herdr response exceeded the size limit", "failed", "response_too_large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) parseLine(buffer.slice(0, newline));
    });
    socket.once("end", () => {
      if (!settled && buffer.trim()) parseLine(buffer.trim());
      else if (!settled) finishError(new HerdrClientError("Herdr socket closed without a response", "unknown", "empty_response"));
    });
    socket.once("error", cause => finishError(new HerdrClientError(
      `Unable to reach Herdr socket ${socketPath}: ${cause.message}`,
      "unknown",
      "socket_unavailable",
      { cause },
    )));
    socket.connect(socketPath);
  });
}

async function discoverWithCli(executable: string): Promise<HerdrSessionInfo[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(executable, ["session", "list", "--json"], {
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 1_000_000,
    });
    stdout = result.stdout;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === "ENOENT") {
      throw new HerdrClientError(`Herdr executable not found: ${executable}`, "not_found", "herdr_not_installed", { cause });
    }
    throw new HerdrClientError(
      `Unable to discover Herdr sessions${error.stderr?.trim() ? `: ${error.stderr.trim()}` : ""}`,
      "failed",
      "session_discovery_failed",
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new HerdrClientError("Herdr session discovery returned malformed JSON", "failed", "malformed_session_list", { cause });
  }
  const sessions = isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : null;
  if (!sessions) throw new HerdrClientError("Herdr session discovery omitted sessions", "failed", "malformed_session_list");

  return sessions.map((entry, index) => {
    if (!isRecord(entry)
      || typeof entry.name !== "string"
      || typeof entry.default !== "boolean"
      || typeof entry.running !== "boolean"
      || typeof entry.session_dir !== "string"
      || typeof entry.socket_path !== "string") {
      throw new HerdrClientError(`Malformed Herdr session at index ${index}`, "failed", "malformed_session_list");
    }
    return {
      name: entry.name,
      default: entry.default,
      running: entry.running,
      sessionDir: entry.session_dir,
      socketPath: entry.socket_path,
    };
  });
}

export type HerdrPermissionMode = "read-only" | "workspace-write" | "danger-full-access";

export interface HerdrAccessScope {
  workspacePath: string;
  permissionMode: HerdrPermissionMode;
}

interface SnapshotState {
  version?: unknown;
  protocol?: unknown;
  workspaces: unknown[];
  tabs: unknown[];
  panes: unknown[];
}

export class HerdrClient {
  private readonly discover: DiscoverSessions;
  private readonly send: SendRequest;
  readonly executable: string;

  constructor(options: HerdrClientOptions = {}) {
    this.executable = options.executable ?? "herdr";
    this.discover = options.discoverSessions ?? (() => discoverWithCli(this.executable));
    this.send = options.sendRequest ?? requestHerdrSocket;
  }

  async sessions(): Promise<HerdrSessionInfo[]> {
    return await this.discover();
  }

  async status(sessionName?: string) {
    let sessions: HerdrSessionInfo[];
    try {
      sessions = await this.sessions();
    } catch (error) {
      const known = error instanceof HerdrClientError ? error : new HerdrClientError(String(error), "unknown", "unknown_error");
      return {
        installed: known.code !== "herdr_not_installed",
        health: known.health,
        error: { code: known.code, message: known.message },
        sessions: [],
        selected_session: null,
      };
    }

    const selected = sessionName ? sessions.filter(session => session.name === sessionName) : sessions;
    if (sessionName && selected.length === 0) {
      return {
        installed: true,
        health: "not_found" as const,
        error: { code: "session_not_found", message: `Herdr session not found: ${sessionName}` },
        sessions: sessions.map(session => this.publicSession(session)),
        selected_session: sessionName,
      };
    }

    const probed = await Promise.all(selected.map(async session => {
      if (!session.running) return { ...this.publicSession(session), health: "failed" as const, version: null, protocol: null, error: "session is not running" };
      try {
        const pong = await this.pingSession(session);
        return {
          ...this.publicSession(session),
          health: pong.protocol === SUPPORTED_PROTOCOL ? "healthy" as const : "failed" as const,
          version: pong.version,
          protocol: pong.protocol,
          error: pong.protocol === SUPPORTED_PROTOCOL
            ? null
            : `Unsupported Herdr protocol ${pong.protocol}; expected ${SUPPORTED_PROTOCOL}`,
        };
      } catch (error) {
        const known = this.normalizeError(error);
        return { ...this.publicSession(session), health: known.health, version: null, protocol: null, error: known.message };
      }
    }));

    const health: HerdrHealth = probed.some(item => item.health === "healthy")
      ? "healthy"
      : probed.some(item => item.health === "unknown") ? "unknown" : probed.length ? "failed" : "not_found";
    return {
      installed: true,
      health,
      error: null,
      sessions: sessionName ? sessions.map(session => this.publicSession(session)) : probed,
      selected_session: sessionName ?? null,
      ...(sessionName ? { selected: probed[0] ?? null } : {}),
    };
  }

  async openWorkspace(sessionName: string, cwd: string, label: string | undefined, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    const path = this.requireExistingPathWithinScope(cwd, scope, "workspace cwd");
    const state = await this.snapshot(session);
    const workspaceById = new Map<string, Record<string, unknown>>();
    for (const value of state.workspaces) {
      if (isRecord(value) && typeof value.workspace_id === "string") workspaceById.set(value.workspace_id, value);
    }

    const matchingIds = new Set<string>();
    for (const workspace of workspaceById.values()) {
      const worktree = isRecord(workspace.worktree) ? workspace.worktree : null;
      const checkout = worktree ? optionalString(worktree.checkout_path) : undefined;
      if (checkout && canonicalOrResolved(checkout) === path) matchingIds.add(workspace.workspace_id as string);
    }
    for (const pane of state.panes) {
      if (!isRecord(pane) || typeof pane.workspace_id !== "string") continue;
      const workspace = workspaceById.get(pane.workspace_id);
      if (workspace && isRecord(workspace.worktree)) continue;
      const paneCwd = optionalString(pane.cwd);
      if (paneCwd && canonicalOrResolved(paneCwd) === path) matchingIds.add(pane.workspace_id);
    }
    if (matchingIds.size > 1) {
      throw new HerdrClientError(`Multiple Herdr workspaces match cwd ${path}`, "failed", "ambiguous_workspace");
    }
    if (matchingIds.size === 1) {
      const workspaceId = [...matchingIds][0]!;
      this.assertWorkspaceInScope(state, workspaceId, scope);
      const workspace = workspaceById.get(workspaceId);
      const tab = state.tabs.find(value => isRecord(value) && value.workspace_id === workspaceId && value.tab_id === workspace?.active_tab_id) as Record<string, unknown> | undefined;
      const panes = tab
        ? state.panes.filter(value => isRecord(value) && value.workspace_id === workspaceId && value.tab_id === tab.tab_id) as Record<string, unknown>[]
        : [];
      return {
        session: session.name,
        socket_path: session.socketPath,
        created: false,
        cwd: path,
        workspace,
        tab: tab ?? null,
        root_pane: null,
        panes,
      };
    }

    this.assertMutable(scope, "Herdr workspace creation");
    const created = this.expectResult(await this.requestResult(session, "workspace.create", {
      cwd: path,
      ...(label ? { label } : {}),
      focus: false,
    }), "workspace_created");
    return {
      session: session.name,
      socket_path: session.socketPath,
      created: true,
      cwd: path,
      workspace: created.workspace,
      tab: created.tab,
      root_pane: created.root_pane,
      panes: created.root_pane ? [created.root_pane] : [],
    };
  }

  async createWorktree(sessionName: string, input: {
    sourceCwd: string; branch: string; base?: string; path?: string; label?: string;
  }, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    this.assertMutable(scope, "Herdr worktree creation");
    const sourceCwd = this.requireExistingPathWithinScope(input.sourceCwd, scope, "worktree source cwd");
    if (scope.permissionMode !== "danger-full-access" && !input.path) {
      throw new HerdrClientError(
        "Herdr worktree creation requires an explicit path in workspace-scoped modes",
        "failed",
        "worktree_path_required",
      );
    }
    const targetPath = input.path ? this.requireProspectivePathWithinScope(input.path, scope, "worktree path") : undefined;
    const result = this.expectResult(await this.requestResult(session, "worktree.create", {
      cwd: sourceCwd,
      branch: input.branch,
      ...(input.base ? { base: input.base } : {}),
      ...(targetPath ? { path: targetPath } : {}),
      ...(input.label ? { label: input.label } : {}),
      focus: false,
    }, 30_000), "worktree_created");
    return { session: session.name, socket_path: session.socketPath, workspace: result.workspace, tab: result.tab, root_pane: result.root_pane, worktree: result.worktree };
  }

  async createTab(sessionName: string, input: { workspaceId: string; cwd?: string; label?: string }, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    this.assertMutable(scope, "Herdr tab creation");
    if (scope.permissionMode !== "danger-full-access") {
      const state = await this.snapshot(session);
      this.assertWorkspaceInScope(state, input.workspaceId, scope);
    }
    const cwd = input.cwd ? this.requireExistingPathWithinScope(input.cwd, scope, "tab cwd") : undefined;
    const result = this.expectResult(await this.requestResult(session, "tab.create", {
      workspace_id: input.workspaceId,
      ...(cwd ? { cwd } : {}),
      ...(input.label ? { label: input.label } : {}),
      focus: false,
    }), "tab_created");
    return { session: session.name, socket_path: session.socketPath, tab: result.tab, root_pane: result.root_pane };
  }

  async splitPane(sessionName: string, input: {
    targetPaneId: string; direction: "right" | "down"; cwd?: string; ratio?: number;
  }, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    this.assertMutable(scope, "Herdr pane creation");
    if (scope.permissionMode !== "danger-full-access") {
      const state = await this.snapshot(session);
      this.assertPaneInScope(state, input.targetPaneId, scope);
    }
    const cwd = input.cwd ? this.requireExistingPathWithinScope(input.cwd, scope, "pane cwd") : undefined;
    const result = this.expectResult(await this.requestResult(session, "pane.split", {
      target_pane_id: input.targetPaneId,
      direction: input.direction,
      ...(cwd ? { cwd } : {}),
      ...(input.ratio !== undefined ? { ratio: input.ratio } : {}),
      focus: false,
    }), "pane_info");
    return { session: session.name, socket_path: session.socketPath, pane: result.pane };
  }

  async runPane(sessionName: string, paneId: string, command: string, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    this.assertMutable(scope, "Herdr pane command execution");
    if (scope.permissionMode !== "danger-full-access") {
      const state = await this.snapshot(session);
      this.assertPaneInScope(state, paneId, scope);
    }
    this.expectResult(await this.requestResult(session, "pane.send_input", {
      pane_id: paneId,
      text: command,
      keys: ["enter"],
    }), "ok");
    return { session: session.name, socket_path: session.socketPath, pane_id: paneId, accepted: true };
  }

  async sendPane(sessionName: string, paneId: string, text: string, keys: string[], scope: HerdrAccessScope) {
    const wireKeys = keys.map(key => {
      const wireKey = normalizeHerdrSpecialKey(key);
      if (!wireKey) {
        throw new HerdrClientError(`Unsupported Herdr special key: ${key}`, "failed", "invalid_key");
      }
      return wireKey;
    });
    const session = await this.requireOperationalSession(sessionName, scope);
    this.assertMutable(scope, "Herdr pane input");
    if (scope.permissionMode !== "danger-full-access") {
      const state = await this.snapshot(session);
      this.assertPaneInScope(state, paneId, scope);
    }
    this.expectResult(await this.requestResult(session, "pane.send_input", { pane_id: paneId, text, keys: wireKeys }), "ok");
    return { session: session.name, socket_path: session.socketPath, pane_id: paneId, accepted: true };
  }

  async readPane(sessionName: string, input: {
    paneId: string; source: "visible" | "recent" | "recent_unwrapped" | "detection"; lines?: number; stripAnsi?: boolean;
  }, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    if (scope.permissionMode !== "danger-full-access") {
      const state = await this.snapshot(session);
      this.assertPaneInScope(state, input.paneId, scope);
    }
    const result = this.expectResult(await this.requestResult(session, "pane.read", {
      pane_id: input.paneId,
      source: input.source,
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      format: "text",
      strip_ansi: input.stripAnsi ?? true,
    }), "pane_read");
    return { session: session.name, socket_path: session.socketPath, read: result.read };
  }

  async waitPane(sessionName: string, input: {
    paneId: string; source: "visible" | "recent" | "recent_unwrapped" | "detection";
    matchType: "substring" | "regex"; match: string; lines?: number; timeoutMs?: number;
  }, scope: HerdrAccessScope) {
    const session = await this.requireOperationalSession(sessionName, scope);
    if (scope.permissionMode !== "danger-full-access") {
      const state = await this.snapshot(session);
      this.assertPaneInScope(state, input.paneId, scope);
    }
    const timeoutMs = input.timeoutMs ?? 30_000;
    const result = this.expectResult(await this.requestResult(session, "pane.wait_for_output", {
      pane_id: input.paneId,
      source: input.source,
      match: { type: input.matchType, value: input.match },
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      strip_ansi: true,
      timeout_ms: timeoutMs,
    }, timeoutMs + 1_000), "output_matched");
    return { session: session.name, socket_path: session.socketPath, pane_id: result.pane_id, revision: result.revision, matched_line: result.matched_line ?? null, read: result.read };
  }

  async paneStatus(sessionName: string, paneId: string, scope: HerdrAccessScope) {
    let session: HerdrSessionInfo;
    try {
      session = await this.requireOperationalSession(sessionName, scope);
      if (scope.permissionMode !== "danger-full-access") {
        const state = await this.snapshot(session);
        this.assertPaneInScope(state, paneId, scope);
      }
      const paneResult = this.expectResult(await this.requestResult(session, "pane.get", { pane_id: paneId }), "pane_info");
      let processInfo: unknown = null;
      let processError: { code: string; message: string } | null = null;
      try {
        const processResult = this.expectResult(await this.requestResult(session, "pane.process_info", { pane_id: paneId }), "pane_process_info");
        processInfo = processResult.process_info;
      } catch (error) {
        const known = this.normalizeError(error);
        processError = { code: known.code, message: known.message };
      }
      const pane = isRecord(paneResult.pane) ? paneResult.pane : {};
      return {
        session: session.name,
        socket_path: session.socketPath,
        pane_id: paneId,
        health: "healthy" as const,
        pane,
        process_info: processInfo,
        process_error: processError,
        agent_state: typeof pane.agent_status === "string" ? pane.agent_status : "unknown",
      };
    } catch (error) {
      const known = this.normalizeError(error);
      return {
        session: sessionName,
        socket_path: null,
        pane_id: paneId,
        health: known.health,
        pane: null,
        process_info: null,
        process_error: { code: known.code, message: known.message },
        agent_state: "unknown",
      };
    }
  }

  private async requireOperationalSession(name: string, scope: HerdrAccessScope): Promise<HerdrSessionInfo> {
    this.scopeBase(scope);
    return await this.requireCompatibleSession(name);
  }

  private async requireCompatibleSession(name: string): Promise<HerdrSessionInfo> {
    const sessions = await this.sessions();
    const session = sessions.find(value => value.name === name);
    if (!session) throw new HerdrClientError(`Herdr session not found: ${name}`, "not_found", "session_not_found");
    if (!session.running) throw new HerdrClientError(`Herdr session is not running: ${name}`, "failed", "session_not_running");
    await this.probeProtocol(session);
    return session;
  }

  private async pingSession(session: HerdrSessionInfo): Promise<{ version: string; protocol: number }> {
    const result = await this.requestResult(session, "ping", {}, DEFAULT_TIMEOUT_MS);
    if (result.type !== "pong" || typeof result.version !== "string" || typeof result.protocol !== "number") {
      throw new HerdrClientError("Unexpected Herdr ping response", "failed", "malformed_response");
    }
    return { version: result.version, protocol: result.protocol };
  }

  private async probeProtocol(session: HerdrSessionInfo): Promise<{ version: string; protocol: number }> {
    const pong = await this.pingSession(session);
    if (pong.protocol !== SUPPORTED_PROTOCOL) {
      throw new HerdrClientError(
        `Unsupported Herdr protocol ${pong.protocol}; expected ${SUPPORTED_PROTOCOL}`,
        "failed",
        "unsupported_protocol",
      );
    }
    return pong;
  }

  private async snapshot(session: HerdrSessionInfo): Promise<SnapshotState> {
    const result = this.expectResult(await this.requestResult(session, "session.snapshot", {}), "session_snapshot");
    const state = isRecord(result.snapshot) ? result.snapshot : null;
    if (!state || !Array.isArray(state.workspaces) || !Array.isArray(state.panes) || !Array.isArray(state.tabs)) {
      throw new HerdrClientError("Malformed Herdr session snapshot", "failed", "malformed_response");
    }
    if (typeof state.protocol === "number" && state.protocol !== SUPPORTED_PROTOCOL) {
      throw new HerdrClientError(
        `Unsupported Herdr snapshot protocol ${state.protocol}; expected ${SUPPORTED_PROTOCOL}`,
        "failed",
        "unsupported_protocol",
      );
    }
    return state as unknown as SnapshotState;
  }

  private assertMutable(scope: HerdrAccessScope, operation: string): void {
    if (scope.permissionMode === "read-only") {
      throw new HerdrClientError(`${operation} is disabled in read-only mode`, "failed", "read_only");
    }
  }

  private scopeBase(scope: HerdrAccessScope): string {
    if (!isAbsolute(scope.workspacePath)) {
      throw new HerdrClientError(
        `Disclosed Herdr workspace path must be absolute: ${scope.workspacePath}`,
        "failed",
        "workspace_scope_not_absolute",
      );
    }
    return resolve(scope.workspacePath);
  }

  private resolveFromScope(path: string, scope: HerdrAccessScope): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.scopeBase(scope), path);
  }

  private scopeRoot(scope: HerdrAccessScope): string {
    const resolved = this.scopeBase(scope);
    if (scope.permissionMode === "danger-full-access") return canonicalOrResolved(resolved);
    try {
      return realpathSync.native(resolved);
    } catch (cause) {
      throw new HerdrClientError(`Disclosed Herdr workspace path does not exist: ${resolved}`, "failed", "workspace_scope_not_found", { cause });
    }
  }

  private requireExistingPathWithinScope(path: string, scope: HerdrAccessScope, label: string): string {
    const resolved = this.resolveFromScope(path, scope);
    if (scope.permissionMode === "danger-full-access") return canonicalOrResolved(resolved);
    let canonical: string;
    try {
      canonical = realpathSync.native(resolved);
    } catch (cause) {
      throw new HerdrClientError(`${label} does not exist: ${resolved}`, "not_found", "path_not_found", { cause });
    }
    if (!within(canonical, this.scopeRoot(scope))) {
      throw new HerdrClientError(`${label} is outside the disclosed workspace: ${canonical}`, "failed", "scope_violation");
    }
    return canonical;
  }

  private requireProspectivePathWithinScope(path: string, scope: HerdrAccessScope, label: string): string {
    const target = this.resolveFromScope(path, scope);
    if (scope.permissionMode === "danger-full-access") return target;
    const root = this.scopeRoot(scope);
    let ancestor = target;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    let canonicalAncestor: string;
    try {
      canonicalAncestor = realpathSync.native(ancestor);
    } catch (cause) {
      throw new HerdrClientError(`Unable to resolve ${label}: ${target}`, "failed", "path_resolution_failed", { cause });
    }
    if (!within(canonicalAncestor, root)) {
      throw new HerdrClientError(`${label} resolves outside the disclosed workspace: ${target}`, "failed", "scope_violation");
    }
    return target;
  }

  private assertWorkspaceInScope(state: SnapshotState, workspaceId: string, scope: HerdrAccessScope): void {
    if (scope.permissionMode === "danger-full-access") return;
    const workspace = state.workspaces.find(value => isRecord(value) && value.workspace_id === workspaceId);
    if (!isRecord(workspace)) throw new HerdrClientError(`Herdr workspace not found: ${workspaceId}`, "not_found", "workspace_not_found");
    const worktree = isRecord(workspace.worktree) ? workspace.worktree : null;
    const checkout = worktree ? optionalString(worktree.checkout_path) : undefined;
    if (checkout) {
      this.requireExistingPathWithinScope(checkout, scope, "Herdr workspace checkout");
      return;
    }
    const paneCwds = state.panes
      .filter(value => isRecord(value) && value.workspace_id === workspaceId)
      .map(value => optionalString((value as Record<string, unknown>).cwd))
      .filter((value): value is string => Boolean(value));
    if (paneCwds.length === 0) {
      throw new HerdrClientError(`Cannot establish a scoped path for Herdr workspace ${workspaceId}`, "failed", "workspace_scope_unknown");
    }
    for (const cwd of paneCwds) this.requireExistingPathWithinScope(cwd, scope, "Herdr workspace pane cwd");
  }

  private assertPaneInScope(state: SnapshotState, paneId: string, scope: HerdrAccessScope): void {
    if (scope.permissionMode === "danger-full-access") return;
    const pane = state.panes.find(value => isRecord(value) && value.pane_id === paneId);
    if (!isRecord(pane)) throw new HerdrClientError(`Herdr pane not found: ${paneId}`, "not_found", "pane_not_found");
    const workspaceId = optionalString(pane.workspace_id);
    if (!workspaceId) throw new HerdrClientError(`Malformed Herdr pane identity: ${paneId}`, "failed", "malformed_response");
    const workspace = state.workspaces.find(value => isRecord(value) && value.workspace_id === workspaceId);
    if (!isRecord(workspace)) throw new HerdrClientError(`Herdr workspace not found for pane ${paneId}`, "not_found", "workspace_not_found");
    const worktree = isRecord(workspace.worktree) ? workspace.worktree : null;
    const checkout = worktree ? optionalString(worktree.checkout_path) : undefined;
    if (checkout) {
      this.requireExistingPathWithinScope(checkout, scope, "Herdr pane checkout");
      return;
    }
    const cwd = optionalString(pane.cwd);
    if (!cwd) throw new HerdrClientError(`Cannot establish a scoped cwd for Herdr pane ${paneId}`, "failed", "pane_scope_unknown");
    this.requireExistingPathWithinScope(cwd, scope, "Herdr pane cwd");
  }

  private async requestResult(
    session: HerdrSessionInfo,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const request: HerdrWireRequest = { id: `gwc:${randomUUID()}`, method, params };
    let response: unknown;
    try {
      response = await this.send(session.socketPath, request, timeoutMs);
    } catch (error) {
      throw this.normalizeError(error);
    }
    if (!isRecord(response) || response.id !== request.id) {
      throw new HerdrClientError("Herdr returned a malformed or mismatched response", "failed", "malformed_response");
    }
    if (isRecord(response.error)) {
      const code = optionalString(response.error.code) ?? "herdr_error";
      const message = optionalString(response.error.message) ?? "Herdr request failed";
      throw new HerdrClientError(message, apiErrorHealth(code), code);
    }
    if (!isRecord(response.result)) {
      throw new HerdrClientError("Herdr response omitted result", "failed", "malformed_response");
    }
    return response.result;
  }

  private expectResult(result: Record<string, unknown>, type: string): Record<string, unknown> {
    if (result.type !== type) {
      throw new HerdrClientError(`Unexpected Herdr result type: ${String(result.type)} (expected ${type})`, "failed", "malformed_response");
    }
    return result;
  }

  private normalizeError(error: unknown): HerdrClientError {
    if (error instanceof HerdrClientError) return error;
    return new HerdrClientError(error instanceof Error ? error.message : String(error), "unknown", "unknown_error", { cause: error });
  }

  private publicSession(session: HerdrSessionInfo) {
    return {
      name: session.name,
      default: session.default,
      running: session.running,
      session_dir: session.sessionDir,
      socket_path: session.socketPath,
    };
  }
}
