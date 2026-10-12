import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ExternalMcpBridge } from "../external-mcp/bridge";
import {
  bindSessionCapability,
  type RestrictedCapabilityProfile,
  type SessionCapabilityBinding,
  type SessionCapabilityConfig,
} from "./config";

const DENIED = "Capability policy denied tool invocation";
const NO_AUTH = [{ type: "noauth" as const }];

function rejected(): CallToolResult {
  return { content: [{ type: "text", text: DENIED }], isError: true };
}

type RequestExtra = { _meta?: Record<string, unknown> };
type Handler = (request: any, extra: RequestExtra) => unknown | Promise<unknown>;

/**
 * This boundary is opt-in and installed only when a supervisor provides a
 * capability config. It intercepts all SDK tool dispatch, not just catalog
 * visibility or individual native handlers.
 *
 * NOTE: the local stdio connection must be trusted to supply openai/session.
 * Metadata is not cryptographic authentication for arbitrary MCP clients.
 */
export class SessionCapabilityBoundary {
  private readonly bridges = new Map<string, Promise<ExternalMcpBridge>>();
  private closed = false;

  constructor(
    readonly config: SessionCapabilityConfig,
    private readonly nativeToolNames: ReadonlySet<string>,
  ) {
    for (const profile of config.profiles.values()) {
      for (const name of profile.nativeTools) {
        if (!nativeToolNames.has(name)) throw new Error("Unknown native tool in profile " + profile.name + ": " + name);
      }
      for (const name of profile.externalTools) {
        if (nativeToolNames.has(name)) throw new Error("External MCP permission shadows a native tool: " + name);
      }
    }
  }

  private binding(meta: Record<string, unknown> | undefined): SessionCapabilityBinding | null {
    try {
      return bindSessionCapability(this.config, meta);
    } catch {
      // Missing/invalid ChatGPT session identity is always denied in opt-in mode.
      return null;
    }
  }

  private async bridge(binding: SessionCapabilityBinding): Promise<ExternalMcpBridge> {
    if (this.closed) throw new Error("Capability boundary is closed");
    const profile = binding.profile;
    if (!profile?.externalConfigPath || !profile.externalConfigDigest) {
      throw new Error("Profile does not provide a dedicated MCP registry");
    }
    const existing = this.bridges.get(binding.sessionKey);
    if (existing) return existing;
    if (this.bridges.size >= this.config.maxExternalSessions) {
      throw new Error("Maximum isolated external MCP sessions reached (fail closed)");
    }
    const initialized = (async () => {
      const actualDigest = createHash("sha256").update(readFileSync(profile.externalConfigPath!)).digest("hex");
      if (actualDigest !== profile.externalConfigDigest) throw new Error("Dedicated MCP config changed after policy activation");
      const result = await ExternalMcpBridge.initialize({ configPath: profile.externalConfigPath });
      try {
        const available = new Set(result.publicTools().map(tool => tool.publicName));
        for (const name of profile.externalTools) {
          if (!available.has(name)) throw new Error("Expected session MCP tool is unavailable: " + name);
          if (this.nativeToolNames.has(name)) throw new Error("Session MCP tool shadows a native tool: " + name);
        }
        return result;
      } catch (error) {
        await result.shutdown();
        throw error;
      }
    })();
    this.bridges.set(binding.sessionKey, initialized);
    // Failed discovery/connection can never silently inherit the global MCP.
    void initialized.catch(() => {
      if (this.bridges.get(binding.sessionKey) === initialized) this.bridges.delete(binding.sessionKey);
    });
    return initialized;
  }

  private externalCatalog(
    bridge: ExternalMcpBridge,
    profile: RestrictedCapabilityProfile,
    alreadyRegistered: ReadonlySet<string>,
  ): Tool[] {
    const result: Tool[] = [];
    for (const tool of bridge.publicTools()) {
      if (!profile.externalTools.has(tool.publicName)) continue;
      if (alreadyRegistered.has(tool.publicName)) {
        throw new Error("Profile MCP tool collides with the existing catalog: " + tool.publicName);
      }
      result.push({
        name: tool.publicName,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        _meta: { securitySchemes: NO_AUTH },
      });
    }
    return result;
  }

  async list(base: ListToolsResult, meta: Record<string, unknown> | undefined): Promise<ListToolsResult> {
    const binding = this.binding(meta);
    if (!binding) return { tools: [] };
    if (binding.kind === "denied") return {
      tools: base.tools.filter(tool => tool.name === "capability_identity"),
    };
    if (binding.kind === "legacy") return base;
    const profile = binding.profile!;
    const existingNames = new Set(base.tools.map(tool => tool.name));
    const nativeTools = base.tools.filter(tool =>
      this.nativeToolNames.has(tool.name) && profile.nativeTools.has(tool.name));
    if (nativeTools.length !== profile.nativeTools.size) {
      throw new Error("Restricted profile references a native tool that was not registered");
    }
    const externalTools = profile.externalTools.size
      ? this.externalCatalog(await this.bridge(binding), profile, existingNames)
      : [];
    if (externalTools.length !== profile.externalTools.size) {
      throw new Error("Restricted profile external tool catalog incomplete (fail closed)");
    }
    return { tools: [...nativeTools, ...externalTools].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async call(
    name: string,
    args: Record<string, unknown> | undefined,
    meta: Record<string, unknown> | undefined,
    next: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    const binding = this.binding(meta);
    if (!binding) return rejected();
    if (binding.kind === "denied") return name === "capability_identity" ? next() : rejected();
    if (binding.kind === "legacy") return next();
    const profile = binding.profile!;
    if (this.nativeToolNames.has(name)) {
      return profile.nativeTools.has(name) ? next() : rejected();
    }
    if (!profile.externalTools.has(name)) return rejected();
    try {
      const bridge = await this.bridge(binding);
      if (!bridge.publicTools().some(tool => tool.publicName === name)) return rejected();
      return await bridge.callPublicTool(name, args ?? {});
    } catch {
      return rejected();
    }
  }

  assertNonToolRequest(meta: Record<string, unknown> | undefined): void {
    const binding = this.binding(meta);
    if (!binding || binding.kind !== "legacy") {
      throw new Error("Capability policy denied non-tool MCP request");
    }
  }

  /**
   * Interpose on public SDK request-handler registration before native,
   * Herdr and external tools are registered. The SDK still validates tool
   * schemas and results. No SDK private fields are used.
   */
  install(server: McpServer): void {
    const raw = server.server;
    const original = raw.setRequestHandler.bind(raw) as unknown as (schema: any, handler: Handler) => void;
    raw.setRequestHandler = ((schema: any, handler: Handler) => {
      if (schema === ListToolsRequestSchema) {
        return original(schema, async (request: any, extra: RequestExtra) =>
          this.list(await handler(request, extra) as ListToolsResult, extra._meta));
      }
      if (schema === CallToolRequestSchema) {
        return original(schema, async (request: any, extra: RequestExtra) => {
          const params = request.params as { name: string; arguments?: Record<string, unknown> };
          return this.call(params.name, params.arguments, extra._meta, () => handler(request, extra));
        });
      }
      // Resources, prompts, completions and any newly registered MCP method
      // must not become a non-tool escape route for a restricted session.
      const method: unknown = schema?.shape?.method?.value;
      if (typeof method === "string" && method !== "initialize" && method !== "ping") {
        return original(schema, (request: any, extra: RequestExtra) => {
          this.assertNonToolRequest(extra._meta);
          return handler(request, extra);
        });
      }
      return original(schema, handler);
    }) as typeof raw.setRequestHandler;
  }

  inspection(sessionKey: string): Record<string, unknown> {
    const name = this.config.bindings.get(sessionKey);
    const profile = name && name !== "legacy" ? this.config.profiles.get(name) : undefined;
    return {
      policy_config_sha256: this.config.digest,
      session_key: sessionKey,
      selected_profile: name ?? this.config.defaultPolicy,
      profile_version: profile?.version ?? null,
      configured_native_tools: profile ? [...profile.nativeTools].sort() : null,
      configured_external_tools: profile ? [...profile.externalTools].sort() : null,
      effective_tools_verified_by_real_client: false,
      chatgpt_other_plugins_controlled: false,
      chatgpt_memory_controlled: false,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    const results = await Promise.allSettled(bridges);
    await Promise.all(results.map(result =>
      result.status === "fulfilled" ? result.value.shutdown() : Promise.resolve()));
  }
}
