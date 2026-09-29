import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_TRACE_DISPATCH_META_KEY,
  MCP_TRACE_FILE_ENV,
  MCP_TRACE_SCHEMA,
  McpRequestTracer,
  mcpTraceDispatchId,
  terminalExecTraceIdentity,
} from "../src/adapters/chatgpt-web/mcp-request-trace";

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  delete env[MCP_TRACE_FILE_ENV];
  return { ...env, ...extra };
}

async function connectClient(root: string, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", join(root, "state.json")],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-request-trace-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function taggedCommand(tag: string, output: string): string {
  if (process.platform === "win32") {
    return `Write-Output ${JSON.stringify(output)} # GWC_TRACE_TAG=${tag}`;
  }
  return `printf '%s\\n' ${JSON.stringify(output)} # GWC_TRACE_TAG=${tag}`;
}

test("MCP request tracing is disabled by default and sanitizes tagged input identity", () => {
  const disabled = McpRequestTracer.fromEnvironment({});
  expect(disabled.enabled).toBe(false);
  expect(disabled.filePath).toBeNull();

  const base = {
    command: "printf 'RAW_SECRET_FIXTURE' # GWC_TRACE_TAG=stable-tag",
    cwd: ".",
    workspace_path: "/tmp/example",
    permission_mode: "workspace-write",
    wait_timeout_ms: 5_000,
  };
  const first = terminalExecTraceIdentity(base);
  const second = terminalExecTraceIdentity({ ...base });
  expect(first).toEqual(second);
  expect(first.trace_tag).toBe("stable-tag");
  expect(first.input_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toContain("RAW_SECRET_FIXTURE");

  const untagged = terminalExecTraceIdentity({ ...base, command: "printf 'RAW_SECRET_FIXTURE'" });
  expect(untagged).toEqual({ trace_tag: null, input_digest: null });

  const dispatchId = "11111111-2222-4333-8444-555555555555";
  expect(mcpTraceDispatchId({ [MCP_TRACE_DISPATCH_META_KEY]: dispatchId })).toBe(dispatchId);
  expect(mcpTraceDispatchId({ [MCP_TRACE_DISPATCH_META_KEY]: "not-a-uuid" })).toBeNull();
  expect(mcpTraceDispatchId(null)).toBeNull();
});

test("enabled MCP request tracing preserves SDK request ids and distinct local executions without changing tools/list", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-mcp-trace-"));
  const tracePath = join(root, "gwc-requests.ndjson");
  let tracedClient: Client | undefined;
  let plainClient: Client | undefined;
  try {
    ({ client: tracedClient } = await connectClient(root, childEnv({ [MCP_TRACE_FILE_ENV]: tracePath })));
    const tracedTools = await tracedClient.listTools();

    const tag = "wave1-test-stable";
    const command = taggedCommand(tag, "RAW_SECRET_FIXTURE");
    const boundaryDispatchIds = [
      "11111111-2222-4333-8444-555555555555",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ];
    for (let index = 0; index < 2; index += 1) {
      const response = await tracedClient.callTool({
        name: "terminal_exec",
        arguments: {
          command,
          cwd: ".",
          workspace_path: root,
          permission_mode: "workspace-write",
          wait_timeout_ms: 5_000,
        },
        _meta: { [MCP_TRACE_DISPATCH_META_KEY]: boundaryDispatchIds[index] },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ status: "completed", exit_code: 0 });
    }

    expect(existsSync(tracePath)).toBe(true);
    const traceText = readFileSync(tracePath, "utf8");
    expect(traceText).not.toContain("RAW_SECRET_FIXTURE");
    expect(traceText).not.toContain("printf");
    const events = traceText.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.every(event => event.schema === MCP_TRACE_SCHEMA)).toBe(true);
    expect(events.every(event => event.tool === "terminal_exec")).toBe(true);
    expect(events.every(event => event.trace_tag === tag)).toBe(true);

    const received = events.filter(event => event.phase === "received");
    expect(received).toHaveLength(2);
    expect(received[0]?.sdk_request_id).not.toEqual(received[1]?.sdk_request_id);
    expect(received[0]?.input_digest).toEqual(received[1]?.input_digest);
    expect(received.map(event => event.boundary_dispatch_id)).toEqual(boundaryDispatchIds);

    const requestIds = received.map(event => event.sdk_request_id);
    const executionIds: unknown[] = [];
    for (const requestId of requestIds) {
      const requestEvents = events.filter(event => event.sdk_request_id === requestId);
      expect(requestEvents.map(event => event.phase)).toEqual([
        "received",
        "execution_started",
        "execution_finished",
        "response_returned",
      ]);
      expect(new Set(requestEvents.map(event => event.boundary_dispatch_id))).toEqual(
        new Set([boundaryDispatchIds[requestIds.indexOf(requestId)]]),
      );
      const started = requestEvents.find(event => event.phase === "execution_started");
      expect(started?.local_execution_id).toBeTruthy();
      expect(started?.local_pid).toBeTruthy();
      if (process.platform === "linux") {
        expect(started?.gwc_process_starttime_ticks).toBeTruthy();
        expect(started?.local_process_starttime_ticks).toBeTruthy();
      }
      executionIds.push(started?.local_execution_id);
    }
    expect(executionIds[0]).not.toEqual(executionIds[1]);

    await tracedClient.close();
    tracedClient = undefined;

    ({ client: plainClient } = await connectClient(root, childEnv()));
    const plainTools = await plainClient.listTools();
    expect(tracedTools.tools).toEqual(plainTools.tools);
  } finally {
    await tracedClient?.close();
    await plainClient?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle tracing serializes identity fields without payload content", () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-mcp-lifecycle-trace-"));
  const tracePath = join(root, "lifecycle.ndjson");
  try {
    const tracer = new McpRequestTracer(tracePath);
    tracer.recordLifecycle({
      event_type: "request_received",
      request_id: "rpc-123",
      tool: "terminal_exec",
      boundary_dispatch_id: "11111111-2222-4333-8444-555555555555",
      mcp_session_id: "session-123",
      jsonrpc_id: "jsonrpc-123",
      identity: { local_execution_id: "exec-123", sanitized_digest: "abc" },
    });
    const event = JSON.parse(readFileSync(tracePath, "utf8").trim()) as Record<string, unknown>;
    expect(event.schema).toBe(MCP_TRACE_SCHEMA);
    expect(event.event_type).toBe("request_received");
    expect(event.sdk_request_id).toBe("rpc-123");
    expect(event.boundary_dispatch_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(event.local_execution_id).toBe("exec-123");
    expect(JSON.stringify(event)).not.toContain("secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace output failure is fail-open for terminal_exec", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-mcp-trace-failure-"));
  let client: Client | undefined;
  try {
    // A directory cannot be opened as an append-only NDJSON file.
    ({ client } = await connectClient(root, childEnv({ [MCP_TRACE_FILE_ENV]: root })));
    const response = await client.callTool({
      name: "terminal_exec",
      arguments: {
        command: taggedCommand("wave1-trace-failure", "TRACE_FAILURE_EXECUTED"),
        cwd: ".",
        workspace_path: root,
        permission_mode: "workspace-write",
        wait_timeout_ms: 5_000,
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ status: "completed", exit_code: 0 });
    expect((response.structuredContent as { stdout: string }).stdout).toContain("TRACE_FAILURE_EXECUTED");
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
