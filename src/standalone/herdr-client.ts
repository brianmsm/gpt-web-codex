import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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

function normalizePath(path: string): string {
  return resolve(path);
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
        const result = await this.requestResult(session, "ping", {}, DEFAULT_TIMEOUT_MS);
        if (result.type !== "pong" || typeof result.version !== "string" || typeof result.protocol !== "number") {
          throw new HerdrClientError("Unexpected Herdr ping response", "failed", "malformed_response");
        }
        return {
          ...this.publicSession(session),
          health: result.protocol === 20 ? "healthy" as const : "failed" as const,
          version: result.version,
          protocol: result.protocol,
          error: result.protocol === 20 ? null : `unsupported protocol ${result.protocol}; expected 20`,
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

  async openWorkspace(sessionName: string, cwd: string, label?: string) {
    const session = await this.requireSession(sessionName);
    const path = normalizePath(cwd);
    const snapshot = this.expectResult(await this.requestResult(session, "session.snapshot", {}), "session_snapshot");
    const state = isRecord(snapshot.snapshot) ? snapshot.snapshot : null;
    if (!state || !Array.isArray(state.workspaces) || !Array.isArray(state.panes) || !Array.isArray(state.tabs)) {
      throw new HerdrClientError("Malformed Herdr session snapshot", "failed", "malformed_response");
    }
    const matchingIds = new Set<string>();
    for (const workspace of state.workspaces) {
      if (!isRecord(workspace) || typeof workspace.workspace_id !== "string") continue;
      const worktree = isRecord(workspace.worktree) ? workspace.worktree : null;
      if (worktree && optionalString(worktree.checkout_path) && normalizePath(worktree.checkout_path as string) === path) {
        matchingIds.add(workspace.workspace_id);
      }
    }
    for (const pane of state.panes) {
      if (!isRecord(pane) || typeof pane.workspace_id !== "string") continue;
      const paneCwd = optionalString(pane.cwd);
      if (paneCwd && normalizePath(paneCwd) === path) matchingIds.add(pane.workspace_id);
    }
    if (matchingIds.size > 1) {
      throw new HerdrClientError(`Multiple Herdr workspaces match cwd ${path}`, "failed", "ambiguous_workspace");
    }
    if (matchingIds.size === 1) {
      const workspaceId = [...matchingIds][0]!;
      const workspace = state.workspaces.find(value => isRecord(value) && value.workspace_id === workspaceId) as Record<string, unknown> | undefined;
      const tab = state.tabs.find(value => isRecord(value) && value.workspace_id === workspaceId && value.tab_id === workspace?.active_tab_id) as Record<string, unknown> | undefined;
      const pane = state.panes.find(value => isRecord(value) && value.workspace_id === workspaceId && value.tab_id === tab?.tab_id) as Record<string, unknown> | undefined;
      return { session: session.name, socket_path: session.socketPath, created: false, cwd: path, workspace, tab: tab ?? null, root_pane: pane ?? null };
    }

    const created = this.expectResult(await this.requestResult(session, "workspace.create", {
      cwd: path,
      ...(label ? { label } : {}),
      focus: false,
    }), "workspace_created");
    return { session: session.name, socket_path: session.socketPath, created: true, cwd: path, workspace: created.workspace, tab: created.tab, root_pane: created.root_pane };
  }

  async createWorktree(sessionName: string, input: {
    sourceCwd: string; branch: string; base?: string; path?: string; label?: string;
  }) {
    const session = await this.requireSession(sessionName);
    const result = this.expectResult(await this.requestResult(session, "worktree.create", {
      cwd: normalizePath(input.sourceCwd),
      branch: input.branch,
      ...(input.base ? { base: input.base } : {}),
      ...(input.path ? { path: normalizePath(input.path) } : {}),
      ...(input.label ? { label: input.label } : {}),
      focus: false,
    }, 30_000), "worktree_created");
    return { session: session.name, socket_path: session.socketPath, workspace: result.workspace, tab: result.tab, root_pane: result.root_pane, worktree: result.worktree };
  }

  async createTab(sessionName: string, input: { workspaceId: string; cwd?: string; label?: string }) {
    const session = await this.requireSession(sessionName);
    const result = this.expectResult(await this.requestResult(session, "tab.create", {
      workspace_id: input.workspaceId,
      ...(input.cwd ? { cwd: normalizePath(input.cwd) } : {}),
      ...(input.label ? { label: input.label } : {}),
      focus: false,
    }), "tab_created");
    return { session: session.name, socket_path: session.socketPath, tab: result.tab, root_pane: result.root_pane };
  }

  async splitPane(sessionName: string, input: {
    targetPaneId: string; direction: "right" | "down"; cwd?: string; ratio?: number;
  }) {
    const session = await this.requireSession(sessionName);
    const result = this.expectResult(await this.requestResult(session, "pane.split", {
      target_pane_id: input.targetPaneId,
      direction: input.direction,
      ...(input.cwd ? { cwd: normalizePath(input.cwd) } : {}),
      ...(input.ratio !== undefined ? { ratio: input.ratio } : {}),
      focus: false,
    }), "pane_info");
    return { session: session.name, socket_path: session.socketPath, pane: result.pane };
  }

  async runPane(sessionName: string, paneId: string, command: string) {
    const session = await this.requireSession(sessionName);
    this.expectResult(await this.requestResult(session, "pane.send_input", {
      pane_id: paneId,
      text: command,
      keys: ["Enter"],
    }), "ok");
    return { session: session.name, socket_path: session.socketPath, pane_id: paneId, accepted: true };
  }

  async sendPane(sessionName: string, paneId: string, text: string, keys: string[]) {
    const session = await this.requireSession(sessionName);
    this.expectResult(await this.requestResult(session, "pane.send_input", { pane_id: paneId, text, keys }), "ok");
    return { session: session.name, socket_path: session.socketPath, pane_id: paneId, accepted: true };
  }

  async readPane(sessionName: string, input: {
    paneId: string; source: "visible" | "recent" | "recent_unwrapped" | "detection"; lines?: number; stripAnsi?: boolean;
  }) {
    const session = await this.requireSession(sessionName);
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
  }) {
    const session = await this.requireSession(sessionName);
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

  async paneStatus(sessionName: string, paneId: string) {
    let session: HerdrSessionInfo;
    try {
      session = await this.requireSession(sessionName);
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

  private async requireSession(name: string): Promise<HerdrSessionInfo> {
    const sessions = await this.sessions();
    const session = sessions.find(value => value.name === name);
    if (!session) throw new HerdrClientError(`Herdr session not found: ${name}`, "not_found", "session_not_found");
    if (!session.running) throw new HerdrClientError(`Herdr session is not running: ${name}`, "failed", "session_not_running");
    return session;
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
