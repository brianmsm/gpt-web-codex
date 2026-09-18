import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandUserPath, getConfigDir } from "../../config";
import { assertUniqueExternalAliases, normalizeExternalMcpAlias } from "./naming";
import type {
  ExternalMcpConfig,
  ExternalMcpHttpServerConfig,
  ExternalMcpServerConfig,
  ExternalMcpStdioServerConfig,
  ExternalMcpToolPolicy,
} from "./types";

export const EXTERNAL_MCP_CONFIG_ENV = "CODEX_CHATGPT_WEB_EXTERNAL_MCP_CONFIG";
export const EXTERNAL_MCP_CONFIG_FILE = "external-mcp.json";
export const DEFAULT_EXTERNAL_MCP_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_EXTERNAL_MCP_CALL_TIMEOUT_MS = 60_000;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${context} contains unsupported field(s): ${unknown.join(", ")}`);
  }
}

function booleanField(value: unknown, fallback: boolean, context: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function timeoutField(value: unknown, fallback: number, context: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 86_400_000) {
    throw new Error(`${context} must be an integer between 100 and 86400000 milliseconds`);
  }
  return value as number;
}

function stringArray(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${context} must be an array of non-empty strings`);
  }
  const result = value.map(item => (item as string).trim());
  if (new Set(result).size !== result.length) throw new Error(`${context} must not contain duplicates`);
  return result;
}

function processArguments(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${context} must be an array of strings`);
  }
  return [...value] as string[];
}

function stringMap(value: unknown, context: string): Record<string, string> {
  if (value === undefined) return {};
  const raw = object(value, context);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!ENV_NAME.test(key)) throw new Error(`${context} contains invalid environment variable name: ${key}`);
    if (typeof item !== "string") throw new Error(`${context}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function toolPolicy(value: unknown, context: string): ExternalMcpToolPolicy {
  if (value === undefined) return {};
  const raw = object(value, context);
  assertKnownKeys(raw, ["allow", "deny"], context);
  const allow = raw.allow === undefined ? undefined : stringArray(raw.allow, `${context}.allow`);
  const deny = raw.deny === undefined ? undefined : stringArray(raw.deny, `${context}.deny`);
  return { ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) };
}

function resolvedCwd(value: unknown, configPath: string, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a non-empty string`);
  const expanded = expandUserPath(value.trim());
  return resolve(isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded));
}

function serverAlias(value: unknown, key: string, context: string): string {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${context}.alias must be a non-empty string`);
  }
  const alias = typeof value === "string" ? value.trim() : key;
  normalizeExternalMcpAlias(alias);
  return alias;
}

function commonServerFields(raw: Record<string, unknown>, key: string, path: string) {
  const context = `External MCP server ${JSON.stringify(key)} in ${path}`;
  return {
    key,
    alias: serverAlias(raw.alias, key, context),
    enabled: booleanField(raw.enabled, true, `${context}.enabled`),
    required: booleanField(raw.required, false, `${context}.required`),
    tools: toolPolicy(raw.tools, `${context}.tools`),
    startupTimeoutMs: timeoutField(
      raw.startup_timeout_ms,
      DEFAULT_EXTERNAL_MCP_STARTUP_TIMEOUT_MS,
      `${context}.startup_timeout_ms`,
    ),
    callTimeoutMs: timeoutField(
      raw.call_timeout_ms,
      DEFAULT_EXTERNAL_MCP_CALL_TIMEOUT_MS,
      `${context}.call_timeout_ms`,
    ),
  };
}

function parseStdioServer(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): ExternalMcpStdioServerConfig {
  const context = `External MCP server ${JSON.stringify(key)} in ${path}`;
  assertKnownKeys(raw, [
    "alias", "enabled", "required", "transport", "tools", "startup_timeout_ms", "call_timeout_ms",
    "command", "args", "cwd", "env", "inherit_env",
  ], context);
  if (typeof raw.command !== "string" || !raw.command.trim()) {
    throw new Error(`${context}.command must be a non-empty string`);
  }
  const inheritEnv = stringArray(raw.inherit_env, `${context}.inherit_env`);
  for (const name of inheritEnv) {
    if (!ENV_NAME.test(name)) throw new Error(`${context}.inherit_env contains invalid name: ${name}`);
  }
  return {
    ...commonServerFields(raw, key, path),
    transport: "stdio",
    command: raw.command.trim(),
    args: processArguments(raw.args, `${context}.args`),
    cwd: resolvedCwd(raw.cwd, path, `${context}.cwd`),
    env: stringMap(raw.env, `${context}.env`),
    inheritEnv,
  };
}

function parseHttpServer(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): ExternalMcpHttpServerConfig {
  const context = `External MCP server ${JSON.stringify(key)} in ${path}`;
  assertKnownKeys(raw, [
    "alias", "enabled", "required", "transport", "tools", "startup_timeout_ms", "call_timeout_ms", "url",
  ], context);
  if (typeof raw.url !== "string" || !raw.url.trim()) {
    throw new Error(`${context}.url must be a non-empty string`);
  }
  let url: URL;
  try {
    url = new URL(raw.url.trim());
  } catch {
    throw new Error(`${context}.url must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${context}.url must use http: or https:`);
  }
  if (url.username || url.password) {
    throw new Error(`${context}.url must not embed credentials`);
  }
  return {
    ...commonServerFields(raw, key, path),
    transport: "streamable-http",
    url: url.toString(),
  };
}

export function defaultExternalMcpConfigPath(): string {
  const override = process.env[EXTERNAL_MCP_CONFIG_ENV]?.trim();
  if (override) return resolve(expandUserPath(override));
  return join(getConfigDir(), EXTERNAL_MCP_CONFIG_FILE);
}

export function parseExternalMcpConfig(value: unknown, path: string): ExternalMcpConfig {
  const raw = object(value, `External MCP configuration ${path}`);
  assertKnownKeys(raw, ["version", "servers"], `External MCP configuration ${path}`);
  if (raw.version !== 1) throw new Error(`External MCP configuration ${path} must have version 1`);
  const rawServers = object(raw.servers, `External MCP configuration servers in ${path}`);
  const servers: ExternalMcpServerConfig[] = [];
  for (const [key, value] of Object.entries(rawServers)) {
    if (!key.trim()) throw new Error(`External MCP configuration ${path} contains an empty server key`);
    const server = object(value, `External MCP server ${JSON.stringify(key)} in ${path}`);
    if (server.transport === "stdio") {
      servers.push(parseStdioServer(server, key, path));
    } else if (server.transport === "streamable-http") {
      servers.push(parseHttpServer(server, key, path));
    } else {
      throw new Error(
        `External MCP server ${JSON.stringify(key)} in ${path} has unsupported transport; expected "stdio" or "streamable-http"`,
      );
    }
  }
  assertUniqueExternalAliases(servers.map(server => server.alias));
  return { version: 1, path, loaded: true, servers };
}

export function loadExternalMcpConfig(path = defaultExternalMcpConfigPath()): ExternalMcpConfig {
  const resolvedPath = resolve(expandUserPath(path));
  if (!existsSync(resolvedPath)) {
    return { version: 1, path: resolvedPath, loaded: false, servers: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid external MCP JSON in ${resolvedPath}: ${message}`);
  }
  return parseExternalMcpConfig(parsed, resolvedPath);
}
