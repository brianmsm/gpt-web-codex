import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseExternalMcpConfig } from "../external-mcp/config";

export const SESSION_CAPABILITIES_CONFIG_ENV = "CODEX_CHATGPT_WEB_SESSION_CAPABILITIES_CONFIG";
const SESSION_KEY = /^chatgpt:[0-9a-f]{64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function verifyPrivateCapabilityFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Capability configuration must be a regular file, not a symlink");
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("Capability configuration must not be group/world writable");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Capability configuration must be owned by the GWC user");
    }
  }
}


export interface RestrictedCapabilityProfile {
  readonly name: string;
  readonly version: number;
  readonly nativeTools: ReadonlySet<string>;
  readonly externalTools: ReadonlySet<string>;
  readonly externalConfigPath?: string;
  readonly externalConfigDigest?: string;
}

export interface SessionCapabilityBinding {
  readonly kind: "legacy" | "denied" | "restricted";
  readonly sessionKey: string;
  readonly profile?: RestrictedCapabilityProfile;
}

export interface SessionCapabilityConfig {
  readonly path: string;
  readonly digest: string;
  readonly defaultPolicy: "legacy" | "deny";
  /** shared advertises one stable catalog; calls remain scoped by session. */
  readonly catalogMode: "per_session" | "shared";
  readonly profiles: ReadonlyMap<string, RestrictedCapabilityProfile>;
  readonly bindings: ReadonlyMap<string, string>;
  readonly maxExternalSessions: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(label + " has unsupported fields: " + unknown.join(", "));
}

function exactNames(value: unknown, label: string): ReadonlySet<string> {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item || item.trim() !== item)) {
    throw new Error(label + " must be an explicit array of exact non-empty tool names");
  }
  if (value.some(item => item === "*" || item.includes("*"))) {
    throw new Error(label + " does not support wildcard permissions");
  }
  if (new Set(value).size !== value.length) throw new Error(label + " contains duplicate permissions");
  return new Set(value);
}

export function sessionKeyFromOpenAiMetadata(meta: Record<string, unknown> | undefined): string {
  const source = meta?.["openai/session"];
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("session_capability_identity_missing: authoritative openai/session required");
  }
  return "chatgpt:" + createHash("sha256").update(source.trim(), "utf8").digest("hex");
}

export function parseSessionCapabilityConfig(value: unknown, path: string): SessionCapabilityConfig {
  const raw = object(value, "Session capability config");
  keys(raw, ["version", "default_policy", "catalog_mode", "profiles", "session_bindings", "max_external_sessions"], "Session capability config");
  if (raw.version !== 1) throw new Error("Session capability config version must be 1");
  if (raw.default_policy !== "legacy" && raw.default_policy !== "deny") {
    throw new Error("default_policy must be legacy or deny");
  }
  const catalogMode = raw.catalog_mode ?? "per_session";
  if (catalogMode !== "per_session" && catalogMode !== "shared") {
    throw new Error("catalog_mode must be per_session or shared");
  }
  const maxExternalSessions = raw.max_external_sessions ?? 8;
  if (!Number.isSafeInteger(maxExternalSessions) || (maxExternalSessions as number) < 1 || (maxExternalSessions as number) > 32) {
    throw new Error("max_external_sessions must be an integer 1..32");
  }
  const profilesRaw = object(raw.profiles, "profiles");
  const profiles = new Map<string, RestrictedCapabilityProfile>();
  for (const [name, value] of Object.entries(profilesRaw)) {
    if (!NAME.test(name) || name === "legacy") throw new Error("Invalid or reserved profile name: " + name);
    const item = object(value, "profile " + name);
    keys(item, ["version", "native_tools", "external_tools", "external_mcp_config"], "profile " + name);
    if (!Number.isSafeInteger(item.version) || (item.version as number) < 1) {
      throw new Error("profile " + name + " requires a positive version");
    }
    const nativeTools = exactNames(item.native_tools, "profile " + name + ".native_tools");
    const externalTools = exactNames(item.external_tools, "profile " + name + ".external_tools");
    let externalConfigPath: string | undefined;
    let externalConfigDigest: string | undefined;
    if (item.external_mcp_config !== undefined) {
      if (catalogMode === "shared") {
        throw new Error("shared catalog mode cannot launch session-private external MCP servers; configure global MCP tools or use separate connectors");
      }
      if (typeof item.external_mcp_config !== "string" || !isAbsolute(item.external_mcp_config)) {
        throw new Error("profile " + name + ".external_mcp_config must be an absolute path");
      }
      externalConfigPath = resolve(item.external_mcp_config);
      if (!existsSync(externalConfigPath)) throw new Error("Configured external MCP file does not exist for profile " + name);
      verifyPrivateCapabilityFile(externalConfigPath);
      const externalBytes = readFileSync(externalConfigPath);
      const externalConfig = parseExternalMcpConfig(JSON.parse(externalBytes.toString("utf8")) as unknown, externalConfigPath);
      if (externalConfig.servers.some(server => server.enabled && server.transport !== "stdio")) {
        throw new Error("Restricted profile " + name + " requires session-private stdio MCP processes; shared HTTP is unsupported");
      }
      externalConfigDigest = createHash("sha256").update(externalBytes).digest("hex");
    } else if (externalTools.size && catalogMode !== "shared") {
      throw new Error("profile " + name + " allows external tools without a dedicated external MCP config");
    }
    if (externalConfigPath && !externalTools.size) {
      throw new Error("profile " + name + " has an external MCP config but no explicitly allowed tools");
    }
    for (const tool of externalTools) {
      if (!tool.includes("__")) throw new Error("External tool permission must use alias__tool: " + tool);
      if (nativeTools.has(tool)) throw new Error("Duplicate native/external tool permission: " + tool);
    }
    profiles.set(name, {
      name, version: item.version as number, nativeTools, externalTools,
      ...(externalConfigPath ? { externalConfigPath, externalConfigDigest } : {}),
    });
  }
  const bindingsRaw = object(raw.session_bindings, "session_bindings");
  const bindings = new Map<string, string>();
  for (const [key, value] of Object.entries(bindingsRaw)) {
    if (!SESSION_KEY.test(key)) throw new Error("session_bindings keys must be authoritative chatgpt:<sha256> identifiers");
    if (typeof value !== "string" || (value !== "legacy" && !profiles.has(value))) {
      throw new Error("session_bindings references unknown profile for " + key);
    }
    bindings.set(key, value);
  }
  const normalized = JSON.stringify({
    version: 1,
    default_policy: raw.default_policy,
    catalog_mode: catalogMode,
    profiles: [...profiles].map(([name, profile]) => ({
      name, version: profile.version,
      native_tools: [...profile.nativeTools].sort(),
      external_tools: [...profile.externalTools].sort(),
      external_config_digest: profile.externalConfigDigest ?? null,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    session_bindings: [...bindings].sort(([a], [b]) => a.localeCompare(b)),
    max_external_sessions: maxExternalSessions,
  });
  return {
    path,
    digest: createHash("sha256").update(normalized).digest("hex"),
    defaultPolicy: raw.default_policy,
    catalogMode: catalogMode,
    maxExternalSessions: maxExternalSessions as number,
    profiles,
    bindings,
  };
}

export function loadSessionCapabilityConfig(path = process.env[SESSION_CAPABILITIES_CONFIG_ENV]): SessionCapabilityConfig | undefined {
  // An absent environment variable is the unmodified, legacy GWC behavior.
  if (path === undefined || !path.trim()) return undefined;
  const absolute = resolve(path);
  // Explicit opt-in must never silently fall back to unrestricted mode.
  verifyPrivateCapabilityFile(absolute);
  const json = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  return parseSessionCapabilityConfig(json, absolute);
}

export function bindSessionCapability(
  config: SessionCapabilityConfig,
  meta: Record<string, unknown> | undefined,
): SessionCapabilityBinding {
  const sessionKey = sessionKeyFromOpenAiMetadata(meta);
  const name = config.bindings.get(sessionKey);
  if (name === "legacy" || (!name && config.defaultPolicy === "legacy")) {
    return { kind: "legacy", sessionKey };
  }
  if (!name) return { kind: "denied", sessionKey };
  const profile = config.profiles.get(name);
  if (!profile) throw new Error("Session capability profile missing (fail closed)");
  return { kind: "restricted", sessionKey, profile };
}
