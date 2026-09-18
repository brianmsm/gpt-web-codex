import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  connectExternalMcpClient,
  externalMcpRedactionValues,
  sanitizeExternalMcpError,
} from "./client";
import { loadExternalMcpConfig } from "./config";
import { externalMcpPublicToolName } from "./naming";
import { externalMcpToolAllowed } from "./policy";
import type {
  ExternalMcpConfig,
  ExternalMcpPublicTool,
  ExternalMcpServerRuntime,
  ExternalMcpServerStatus,
  ExternalMcpStatus,
} from "./types";

const noAuth = [{ type: "noauth" as const }];

export interface ExternalMcpBridgeOptions {
  configPath?: string;
  config?: ExternalMcpConfig;
}

function rawObjectSchema(schema: Tool["inputSchema"] | Tool["outputSchema"]): z.ZodObject {
  if (!schema || schema.type !== "object") {
    throw new Error("External MCP tool schema must have type=\"object\"");
  }
  // SDK 1.30's McpServer only accepts Zod schemas. Zod 4 metadata is merged by
  // toJSONSchema(), so this permissive transport schema advertises the original
  // MCP JSON Schema without attempting a lossy JSON-Schema -> Zod conversion.
  return z.object({}).passthrough().meta(schema);
}

function stripProtocolMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProtocolMeta);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "_meta") continue;
    result[key] = stripProtocolMeta(item);
  }
  return result;
}

function safeExternalResult(result: CallToolResult, alias: string, toolName: string): CallToolResult {
  const content = stripProtocolMeta(result.content) as CallToolResult["content"];
  return {
    content: result.isError === true
      ? [{
        type: "text",
        text: `External MCP ${JSON.stringify(alias)} tool ${JSON.stringify(toolName)} reported an error.`,
      }, ...content]
      : content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

function toolError(alias: string, toolName: string, error: unknown, runtime: ExternalMcpServerRuntime): CallToolResult {
  const detail = sanitizeExternalMcpError(error, runtime.config, runtime.redactionValues);
  runtime.lastRuntimeError = detail;
  const timedOut = /timed?\s*out|timeout/i.test(detail);
  return {
    content: [{
      type: "text",
      text: `External MCP ${JSON.stringify(alias)} tool ${JSON.stringify(toolName)} failed (${timedOut ? "timeout" : "failure"}): ${detail}`,
    }],
    isError: true,
  };
}

function publicTool(runtime: ExternalMcpServerRuntime, tool: Tool): ExternalMcpPublicTool {
  if (tool.execution?.taskSupport === "required") {
    throw new Error(
      `External MCP tool ${JSON.stringify(tool.name)} requires task-augmented execution, which this bridge does not support`,
    );
  }
  rawObjectSchema(tool.inputSchema);
  if (tool.outputSchema) rawObjectSchema(tool.outputSchema);
  return {
    publicName: externalMcpPublicToolName(runtime.config.alias, tool.name),
    serverAlias: runtime.config.alias,
    originalName: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}

function calculateExposedTools(runtime: ExternalMcpServerRuntime): ExternalMcpPublicTool[] {
  const exposed: ExternalMcpPublicTool[] = [];
  const names = new Map<string, string>();
  for (const tool of runtime.discoveredTools) {
    if (!externalMcpToolAllowed(tool.name, runtime.config.tools)) continue;
    const mapped = publicTool(runtime, tool);
    const previous = names.get(mapped.publicName);
    if (previous !== undefined) {
      throw new Error(
        `External MCP tools collide after normalization: ${JSON.stringify(previous)} and ${JSON.stringify(tool.name)} -> ${mapped.publicName}`,
      );
    }
    names.set(mapped.publicName, tool.name);
    exposed.push(mapped);
  }
  return exposed;
}

function pidFor(runtime: ExternalMcpServerRuntime): number | null {
  if (runtime.config.transport !== "stdio") return null;
  const transport = runtime.transport;
  if (!transport || !("pid" in transport)) return null;
  return typeof transport.pid === "number" ? transport.pid : null;
}

export class ExternalMcpBridge {
  readonly config: ExternalMcpConfig;
  private readonly runtimes: ExternalMcpServerRuntime[];
  private closed = false;

  private constructor(config: ExternalMcpConfig) {
    this.config = config;
    this.runtimes = config.servers.map(server => ({
      config: server,
      lifecycle: server.enabled ? "connecting" : "disabled",
      discoveredTools: [],
      exposedTools: [],
      redactionValues: externalMcpRedactionValues(server),
      lastStartupError: null,
      lastRuntimeError: null,
      closing: false,
    }));
  }

  static async initialize(options: ExternalMcpBridgeOptions = {}): Promise<ExternalMcpBridge> {
    const config = options.config ?? loadExternalMcpConfig(options.configPath);
    const bridge = new ExternalMcpBridge(config);
    await bridge.start();
    return bridge;
  }

  private async startRuntime(runtime: ExternalMcpServerRuntime): Promise<void> {
    if (!runtime.config.enabled) return;
    runtime.lifecycle = "connecting";
    try {
      const connection = await connectExternalMcpClient(runtime.config, {
        onClose: () => {
          if (runtime.closing || this.closed || runtime.lifecycle === "connecting") return;
          runtime.lifecycle = "crashed";
          runtime.lastRuntimeError = "connection closed unexpectedly";
          console.error(`external MCP ${JSON.stringify(runtime.config.alias)} connection closed unexpectedly`);
        },
        onError: error => {
          if (runtime.closing || this.closed || runtime.lifecycle === "connecting") return;
          runtime.lastRuntimeError = sanitizeExternalMcpError(error, runtime.config, runtime.redactionValues);
          console.error(
            `external MCP ${JSON.stringify(runtime.config.alias)} transport error: ${runtime.lastRuntimeError}`,
          );
        },
      });
      runtime.client = connection.client;
      runtime.transport = connection.transport;
      runtime.discoveredTools = connection.tools;
      runtime.exposedTools = calculateExposedTools(runtime);
      runtime.lifecycle = "connected";
      console.error(
        `external MCP ${JSON.stringify(runtime.config.alias)} connected: discovered ${runtime.discoveredTools.length} tools, exposed ${runtime.exposedTools.length}`,
      );
    } catch (error) {
      runtime.closing = true;
      try {
        await runtime.client?.close();
      } catch {
        // Preserve the original startup failure.
      }
      runtime.lastStartupError = sanitizeExternalMcpError(error, runtime.config, runtime.redactionValues);
      runtime.lifecycle = "unavailable";
      console.error(
        `external MCP ${JSON.stringify(runtime.config.alias)} startup failed: ${runtime.lastStartupError}`,
      );
      throw error;
    }
  }

  private async start(): Promise<void> {
    const enabled = this.runtimes.filter(runtime => runtime.config.enabled);
    const settled = await Promise.allSettled(enabled.map(runtime => this.startRuntime(runtime)));
    const requiredFailures: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const runtime = enabled[index]!;
      if (runtime.config.required) {
        requiredFailures.push(
          `${runtime.config.alias}: ${runtime.lastStartupError ?? sanitizeExternalMcpError(result.reason, runtime.config, runtime.redactionValues)}`,
        );
      }
    });
    if (requiredFailures.length > 0) {
      await this.shutdown();
      throw new Error(`Required external MCP startup failed: ${requiredFailures.join("; ")}`);
    }
  }

  private statusFor(runtime: ExternalMcpServerRuntime): ExternalMcpServerStatus {
    return {
      alias: runtime.config.alias,
      enabled: runtime.config.enabled,
      required: runtime.config.required,
      transport: runtime.config.transport,
      lifecycle: runtime.lifecycle,
      tools_discovered: runtime.discoveredTools.length,
      tools_exposed: runtime.exposedTools.length,
      last_startup_error: runtime.lastStartupError,
      last_runtime_error: runtime.lastRuntimeError,
      pid: pidFor(runtime),
    };
  }

  status(): ExternalMcpStatus {
    return {
      config_loaded: this.config.loaded,
      config_path: this.config.path,
      servers_configured: this.runtimes.length,
      servers: this.runtimes.map(runtime => this.statusFor(runtime)),
    };
  }

  async registerTools(server: McpServer, nativeToolNames: ReadonlySet<string>): Promise<void> {
    const globallySeen = new Map<string, { alias: string; original: string }>();
    for (const runtime of this.runtimes) {
      if (runtime.lifecycle !== "connected") continue;
      let collision: string | null = null;
      const stagedNames = new Map<string, { alias: string; original: string }>();
      for (const tool of runtime.exposedTools) {
        if (nativeToolNames.has(tool.publicName) || tool.publicName === "external_mcp_status") {
          collision = `public tool name collides with a native GWC tool: ${tool.publicName}`;
          break;
        }
        const previous = globallySeen.get(tool.publicName);
        if (previous) {
          collision =
            `public tool name collision: ${tool.publicName} maps to both `
            + `${previous.alias}/${previous.original} and ${runtime.config.alias}/${tool.originalName}`;
          break;
        }
        stagedNames.set(tool.publicName, { alias: runtime.config.alias, original: tool.originalName });
      }
      if (collision) {
        runtime.lastStartupError = collision;
        runtime.lifecycle = "unavailable";
        runtime.exposedTools = [];
        runtime.closing = true;
        try {
          await runtime.client?.close();
        } catch {
          // Collision remains the primary startup error.
        }
        if (runtime.config.required) {
          throw new Error(`Required external MCP ${JSON.stringify(runtime.config.alias)} rejected: ${collision}`);
        }
        console.error(`external MCP ${JSON.stringify(runtime.config.alias)} rejected: ${collision}`);
        continue;
      }
      for (const [publicName, mapping] of stagedNames) globallySeen.set(publicName, mapping);
    }

    server.registerTool("external_mcp_status", {
      title: "Inspect external MCP bridge status",
      description:
        "Read the sanitized startup and lifecycle status of explicitly configured external MCP servers. "
        + "This never returns external environment values, credentials, tokens, headers, or full sensitive configuration.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        config_loaded: z.boolean(),
        config_path: z.string(),
        servers_configured: z.number().int().nonnegative(),
        servers: z.array(z.object({
          alias: z.string(),
          enabled: z.boolean(),
          required: z.boolean(),
          transport: z.enum(["stdio", "streamable-http"]),
          lifecycle: z.enum(["disabled", "connecting", "connected", "unavailable", "crashed", "closed"]),
          tools_discovered: z.number().int().nonnegative(),
          tools_exposed: z.number().int().nonnegative(),
          last_startup_error: z.string().nullable(),
          last_runtime_error: z.string().nullable(),
          pid: z.number().int().positive().nullable(),
        }).strict()),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: noAuth },
    }, async () => ({
      content: [{ type: "text", text: "External MCP bridge status is available in structuredContent." }],
      structuredContent: { ...this.status() },
    }));

    for (const runtime of this.runtimes) {
      if (runtime.lifecycle !== "connected") continue;
      for (const tool of runtime.exposedTools) {
        server.registerTool(tool.publicName, {
          title: tool.title,
          description: tool.description,
          inputSchema: rawObjectSchema(tool.inputSchema),
          ...(tool.outputSchema ? { outputSchema: rawObjectSchema(tool.outputSchema) } : {}),
          annotations: tool.annotations,
          // Never forward arbitrary remote _meta. GWC only attaches its own no-auth declaration.
          _meta: { securitySchemes: noAuth },
        }, async args => {
          if (runtime.lifecycle !== "connected" || !runtime.client) {
            return toolError(runtime.config.alias, tool.originalName, "server is not connected", runtime);
          }
          try {
            const result = await runtime.client.callTool(
              { name: tool.originalName, arguments: args as Record<string, unknown> },
              undefined,
              { timeout: runtime.config.callTimeoutMs, maxTotalTimeout: runtime.config.callTimeoutMs },
            );
            if ("toolResult" in result) {
              return toolError(
                runtime.config.alias,
                tool.originalName,
                "task-augmented results are not supported by this bridge",
                runtime,
              );
            }
            return safeExternalResult(result, runtime.config.alias, tool.originalName);
          } catch (error) {
            return toolError(runtime.config.alias, tool.originalName, error, runtime);
          }
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.runtimes.map(async runtime => {
      if (!runtime.client) {
        if (runtime.lifecycle !== "disabled" && runtime.lifecycle !== "unavailable") runtime.lifecycle = "closed";
        return;
      }
      runtime.closing = true;
      try {
        await runtime.client.close();
      } catch (error) {
        runtime.lastRuntimeError = sanitizeExternalMcpError(error, runtime.config, runtime.redactionValues);
      } finally {
        runtime.lifecycle = "closed";
      }
    }));
  }
}
