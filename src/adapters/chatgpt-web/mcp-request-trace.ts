import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

export const MCP_TRACE_FILE_ENV = "CODEX_CHATGPT_WEB_MCP_TRACE_FILE";
export const MCP_TRACE_SCHEMA = "gwc-mcp-trace/v1";
export const MCP_TRACE_DISPATCH_META_KEY = "io.openai.gwc/wave1-dispatch-id";

export interface TerminalExecTraceInput {
  command: string;
  cwd: string;
  workspace_path: string;
  permission_mode: string;
  wait_timeout_ms: number;
}

export interface TerminalExecTraceIdentity {
  trace_tag: string | null;
  input_digest: string | null;
}

export interface TerminalExecTraceJob {
  id: string;
  pid?: number;
  status: string;
  exitCode?: number | null;
}

type RequestId = string | number;

type TerminalExecTracePhase =
  | "received"
  | "execution_started"
  | "execution_finished"
  | "response_returned";

const TRACE_TAG_PATTERN = /(?:^|[\s#;])GWC_TRACE_TAG=([A-Za-z0-9._:-]{1,128})(?=$|[\s;&|#])/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mcpTraceDispatchId(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[MCP_TRACE_DISPATCH_META_KEY];
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function processStarttimeTicks(pid: number | undefined): string | null {
  if (process.platform !== "linux" || !pid || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    // Fields after "(comm)" start at proc field 3 (state); starttime is field 22.
    return stat.slice(close + 1).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

function stableJson(value: Record<string, unknown>): string {
  const ordered = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(ordered);
}

export function terminalExecTraceIdentity(input: TerminalExecTraceInput): TerminalExecTraceIdentity {
  const traceTag = TRACE_TAG_PATTERN.exec(input.command)?.[1] ?? null;
  if (!traceTag) {
    return { trace_tag: null, input_digest: null };
  }
  const sanitizedInput = {
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    tool: "terminal_exec",
    trace_tag: traceTag,
    wait_timeout_ms: input.wait_timeout_ms,
    workspace_path: input.workspace_path,
  };
  return {
    trace_tag: traceTag,
    input_digest: createHash("sha256").update(stableJson(sanitizedInput), "utf8").digest("hex"),
  };
}

export class McpRequestTracer {
  readonly filePath: string | null;

  constructor(filePath: string | undefined | null) {
    const trimmed = filePath?.trim();
    this.filePath = trimmed ? trimmed : null;
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): McpRequestTracer {
    return new McpRequestTracer(env[MCP_TRACE_FILE_ENV]);
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  recordTerminalExec(
    phase: TerminalExecTracePhase,
    requestId: RequestId,
    identity: TerminalExecTraceIdentity,
    job?: TerminalExecTraceJob,
    boundaryDispatchId: string | null = null,
  ): void {
    if (!this.filePath) return;
    try {
      const event = {
        schema: MCP_TRACE_SCHEMA,
        wall_clock: new Date().toISOString(),
        monotonic_ns: process.hrtime.bigint().toString(),
        phase,
        gwc_process_pid: process.pid,
        gwc_process_starttime_ticks: processStarttimeTicks(process.pid),
        sdk_request_id: requestId,
        tool: "terminal_exec",
        trace_tag: identity.trace_tag,
        input_digest: identity.input_digest,
        boundary_dispatch_id: boundaryDispatchId,
        local_execution_id: job?.id ?? null,
        local_pid: job?.pid ?? null,
        local_process_starttime_ticks: processStarttimeTicks(job?.pid),
        terminal_status: job?.status ?? null,
        exit_code: job?.exitCode ?? null,
      };
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    } catch {
      // Diagnostics are deliberately fail-open: tracing must never change tool behavior.
    }
  }
}
