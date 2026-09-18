import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadExternalMcpConfig,
  parseExternalMcpConfig,
} from "../src/standalone/external-mcp/config";
import { stdioEnvironment } from "../src/standalone/external-mcp/client";
import {
  EXTERNAL_MCP_PUBLIC_TOOL_NAME_MAX,
  externalMcpPublicToolName,
  normalizeExternalMcpAlias,
  normalizeExternalToolName,
} from "../src/standalone/external-mcp/naming";
import { externalMcpToolAllowed } from "../src/standalone/external-mcp/policy";
import type { ExternalMcpStdioServerConfig } from "../src/standalone/external-mcp/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempPath(name = "external-mcp.json"): string {
  const root = mkdtempSync(join(tmpdir(), "gwc-external-config-"));
  roots.push(root);
  return join(root, name);
}

test("external MCP config treats a missing file as no configured servers", () => {
  const path = tempPath();
  expect(existsSync(path)).toBe(false);
  expect(loadExternalMcpConfig(path)).toEqual({
    version: 1,
    path,
    loaded: false,
    servers: [],
  });
});

test("external MCP config rejects malformed JSON", () => {
  const path = tempPath();
  writeFileSync(path, "{ definitely-not-json", "utf8");
  expect(() => loadExternalMcpConfig(path)).toThrow("Invalid external MCP JSON");
});

test("external MCP config parses strict stdio and HTTP servers with explicit defaults", () => {
  const path = tempPath();
  writeFileSync(path, JSON.stringify({
    version: 1,
    servers: {
      local: {
        transport: "stdio",
        command: "fixture-command",
        args: ["--one"],
        inherit_env: ["PATH"],
        env: { FIXTURE_LITERAL: "yes" },
        tools: { allow: ["echo", "status"], deny: ["status"] },
      },
      remote: {
        alias: "research.api",
        enabled: false,
        required: true,
        transport: "streamable-http",
        url: "http://127.0.0.1:8765/mcp",
        startup_timeout_ms: 5000,
        call_timeout_ms: 7000,
      },
    },
  }), "utf8");

  const config = loadExternalMcpConfig(path);
  expect(config.loaded).toBe(true);
  expect(config.servers).toHaveLength(2);
  expect(config.servers[0]).toMatchObject({
    alias: "local",
    enabled: true,
    required: false,
    transport: "stdio",
    command: "fixture-command",
    args: ["--one"],
    inheritEnv: ["PATH"],
    env: { FIXTURE_LITERAL: "yes" },
    startupTimeoutMs: 15_000,
    callTimeoutMs: 60_000,
    tools: { allow: ["echo", "status"], deny: ["status"] },
  });
  expect(config.servers[1]).toMatchObject({
    alias: "research.api",
    enabled: false,
    required: true,
    transport: "streamable-http",
    startupTimeoutMs: 5000,
    callTimeoutMs: 7000,
  });
});

test("external MCP config rejects unknown fields, unsupported transports, URL credentials, and normalized alias collisions", () => {
  const path = "/tmp/external-mcp-test.json";
  expect(() => parseExternalMcpConfig({
    version: 1,
    unexpected: true,
    servers: {},
  }, path)).toThrow("unsupported field");

  expect(() => parseExternalMcpConfig({
    version: 1,
    servers: { bad: { transport: "sse", url: "http://127.0.0.1/mcp" } },
  }, path)).toThrow("unsupported transport");

  expect(() => parseExternalMcpConfig({
    version: 1,
    servers: { bad: { transport: "streamable-http", url: "http://user:pass@127.0.0.1/mcp" } },
  }, path)).toThrow("must not embed credentials");

  expect(() => parseExternalMcpConfig({
    version: 1,
    servers: {
      first: { alias: "a.b", transport: "stdio", command: "x" },
      second: { alias: "a_b", transport: "stdio", command: "y" },
    },
  }, path)).toThrow("collide after normalization");
});

test("allow/deny policy is exact, allow empty exposes nothing, and deny wins", () => {
  expect(externalMcpToolAllowed("echo", {})).toBe(true);
  expect(externalMcpToolAllowed("echo", { allow: [] })).toBe(false);
  expect(externalMcpToolAllowed("echo", { allow: ["echo"] })).toBe(true);
  expect(externalMcpToolAllowed("echo", { deny: ["echo"] })).toBe(false);
  expect(externalMcpToolAllowed("echo", { allow: ["echo"], deny: ["echo"] })).toBe(false);
});

test("public external MCP naming is deterministic and rejects unsafe or overlong names", () => {
  expect(normalizeExternalMcpAlias("research.api")).toBe("research_api");
  expect(normalizeExternalToolName("open.document")).toBe("open_document");
  expect(externalMcpPublicToolName("research.api", "open.document")).toBe("research_api__open_document");
  expect(() => normalizeExternalMcpAlias("bad alias")).toThrow("invalid");
  expect(() => normalizeExternalToolName("bad\u0000tool")).toThrow("safely");
  expect(() => externalMcpPublicToolName("a", "x".repeat(EXTERNAL_MCP_PUBLIC_TOOL_NAME_MAX))).toThrow("too long");
});

test("stdio environment does not inherit arbitrary process secrets unless explicitly requested", () => {
  const oldSecret = process.env.EXTERNAL_MCP_TEST_SECRET;
  const oldAllowed = process.env.EXTERNAL_MCP_TEST_ALLOWED;
  process.env.EXTERNAL_MCP_TEST_SECRET = "do-not-inherit";
  process.env.EXTERNAL_MCP_TEST_ALLOWED = "inherit-me";
  try {
    const base: ExternalMcpStdioServerConfig = {
      key: "fixture",
      alias: "fixture",
      enabled: true,
      required: false,
      transport: "stdio",
      command: "fixture",
      args: [],
      env: { EXTERNAL_MCP_TEST_LITERAL: "literal-value" },
      inheritEnv: ["EXTERNAL_MCP_TEST_ALLOWED"],
      tools: {},
      startupTimeoutMs: 1000,
      callTimeoutMs: 1000,
    };
    const env = stdioEnvironment(base);
    expect(env.EXTERNAL_MCP_TEST_SECRET).toBeUndefined();
    expect(env.EXTERNAL_MCP_TEST_ALLOWED).toBe("inherit-me");
    expect(env.EXTERNAL_MCP_TEST_LITERAL).toBe("literal-value");

    const explicit = stdioEnvironment({ ...base, inheritEnv: ["EXTERNAL_MCP_TEST_SECRET"] });
    expect(explicit.EXTERNAL_MCP_TEST_SECRET).toBe("do-not-inherit");
  } finally {
    if (oldSecret === undefined) delete process.env.EXTERNAL_MCP_TEST_SECRET;
    else process.env.EXTERNAL_MCP_TEST_SECRET = oldSecret;
    if (oldAllowed === undefined) delete process.env.EXTERNAL_MCP_TEST_ALLOWED;
    else process.env.EXTERNAL_MCP_TEST_ALLOWED = oldAllowed;
  }
});
