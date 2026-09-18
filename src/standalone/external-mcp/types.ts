import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ExternalMcpTransportKind = "stdio" | "streamable-http";
export type ExternalMcpLifecycleStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "unavailable"
  | "crashed"
  | "closed";

export interface ExternalMcpToolPolicy {
  allow?: string[];
  deny?: string[];
}

interface ExternalMcpServerCommon {
  key: string;
  alias: string;
  enabled: boolean;
  required: boolean;
  tools: ExternalMcpToolPolicy;
  startupTimeoutMs: number;
  callTimeoutMs: number;
}

export interface ExternalMcpStdioServerConfig extends ExternalMcpServerCommon {
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  inheritEnv: string[];
}

export interface ExternalMcpHttpServerConfig extends ExternalMcpServerCommon {
  transport: "streamable-http";
  url: string;
}

export type ExternalMcpServerConfig =
  | ExternalMcpStdioServerConfig
  | ExternalMcpHttpServerConfig;

export interface ExternalMcpConfig {
  version: 1;
  path: string;
  loaded: boolean;
  servers: ExternalMcpServerConfig[];
}

export interface ExternalMcpPublicTool {
  publicName: string;
  serverAlias: string;
  originalName: string;
  title?: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  annotations?: ToolAnnotations;
}

export type ExternalMcpClientTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport;

export interface ExternalMcpServerRuntime {
  config: ExternalMcpServerConfig;
  lifecycle: ExternalMcpLifecycleStatus;
  client?: Client;
  transport?: ExternalMcpClientTransport;
  discoveredTools: Tool[];
  exposedTools: ExternalMcpPublicTool[];
  redactionValues: string[];
  lastStartupError: string | null;
  lastRuntimeError: string | null;
  closing: boolean;
}

export interface ExternalMcpServerStatus {
  alias: string;
  enabled: boolean;
  required: boolean;
  transport: ExternalMcpTransportKind;
  lifecycle: ExternalMcpLifecycleStatus;
  tools_discovered: number;
  tools_exposed: number;
  last_startup_error: string | null;
  last_runtime_error: string | null;
  pid: number | null;
}

export interface ExternalMcpStatus {
  config_loaded: boolean;
  config_path: string;
  servers_configured: number;
  servers: ExternalMcpServerStatus[];
}