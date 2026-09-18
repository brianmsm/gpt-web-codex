import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { VERSION } from "../../version";
import type {
  ExternalMcpClientTransport,
  ExternalMcpServerConfig,
  ExternalMcpStdioServerConfig,
} from "./types";

export interface ExternalMcpConnectionEvents {
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export interface ConnectedExternalMcpClient {
  client: Client;
  transport: ExternalMcpClientTransport;
  tools: Tool[];
}

function operationFailure(operation: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = /timed?\s*out|timeout/i.test(message);
  return new Error(`External MCP ${operation} ${timedOut ? "timed out" : "failed"}: ${message}`);
}

function remainingTimeout(startedAt: number, timeoutMs: number, operation: string): number {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining < 1) throw new Error(`${operation} timed out after ${timeoutMs} ms`);
  return remaining;
}

export function stdioEnvironment(config: ExternalMcpStdioServerConfig): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const name of config.inheritEnv) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...config.env };
}

export function externalMcpRedactionValues(config: ExternalMcpServerConfig): string[] {
  if (config.transport !== "stdio") return [];
  const values = [
    ...Object.values(config.env),
    ...config.inheritEnv.map(name => process.env[name]).filter((value): value is string => value !== undefined),
  ];
  return [...new Set(values.filter(value => value.length > 0))].sort((left, right) => right.length - left.length);
}

export function sanitizeExternalMcpError(
  error: unknown,
  config?: ExternalMcpServerConfig,
  redactionValues?: readonly string[],
): string {
  let message = error instanceof Error ? error.message : String(error);
  if (config?.transport === "streamable-http") {
    message = message.replaceAll(config.url, "<external-mcp-url>");
  }
  const secrets = redactionValues ?? (config ? externalMcpRedactionValues(config) : []);
  for (const value of secrets) {
    message = message.replaceAll(value, "<redacted>");
  }
  message = message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(/\b(authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
  if (message.length > 2_000) message = `${message.slice(0, 2_000)}…`;
  return message;
}

function constructTransport(config: ExternalMcpServerConfig): ExternalMcpClientTransport {
  if (config.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: stdioEnvironment(config),
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {
      // Drain child stderr so a noisy external MCP cannot block. We intentionally do not
      // mirror arbitrary third-party stderr into GWC logs because it may contain secrets.
    });
    return transport;
  }
  return new StreamableHTTPClientTransport(new URL(config.url));
}

async function listAllTools(client: Client, startedAt: number, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const remaining = remainingTimeout(startedAt, timeoutMs, "External MCP tools/list");
    const page = await client.listTools(
      cursor ? { cursor } : undefined,
      { timeout: remaining, maxTotalTimeout: remaining },
    );
    for (const tool of page.tools) {
      if (names.has(tool.name)) throw new Error(`External MCP returned duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      tools.push(tool);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function connectExternalMcpClient(
  config: ExternalMcpServerConfig,
  events: ExternalMcpConnectionEvents = {},
): Promise<ConnectedExternalMcpClient> {
  const transport = constructTransport(config);
  const client = new Client(
    { name: `gpt-web-codex-external-${config.alias}`, version: VERSION },
    { jsonSchemaValidator: new AjvJsonSchemaValidator() },
  );
  let closing = false;
  client.onclose = () => {
    if (!closing) events.onClose?.();
  };
  client.onerror = error => events.onError?.(error);

  const startedAt = Date.now();
  try {
    try {
      const connectTimeout = remainingTimeout(startedAt, config.startupTimeoutMs, "External MCP initialize");
      await client.connect(transport, { timeout: connectTimeout, maxTotalTimeout: connectTimeout });
    } catch (error) {
      throw operationFailure("initialize", error);
    }

    let tools: Tool[];
    try {
      tools = await listAllTools(client, startedAt, config.startupTimeoutMs);
    } catch (error) {
      throw operationFailure("tools/list", error);
    }
    return { client, transport, tools };
  } catch (error) {
    closing = true;
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Preserve the original startup error.
      }
    }
    throw error;
  }
}
