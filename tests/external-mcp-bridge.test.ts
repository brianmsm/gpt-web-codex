import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalMcpBridge } from "../src/standalone/external-mcp/bridge";
import { parseExternalMcpConfig } from "../src/standalone/external-mcp/config";
import type { ExternalMcpConfig } from "../src/standalone/external-mcp/types";
import { startExternalMcpHttpFixture } from "./fixtures/external-mcp-http";

const stdioFixture = join(import.meta.dir, "fixtures", "external-mcp-stdio.ts");
const invalidStdioFixture = join(import.meta.dir, "fixtures", "external-mcp-invalid-stdio.ts");
const startupErrorFixture = join(import.meta.dir, "fixtures", "external-mcp-startup-error.ts");
const namesStdioFixture = join(import.meta.dir, "fixtures", "external-mcp-names-stdio.ts");

function config(servers: Record<string, unknown>): ExternalMcpConfig {
  return parseExternalMcpConfig({ version: 1, servers }, "/tmp/gwc-external-mcp-test.json");
}

function stdioServer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [stdioFixture],
    startup_timeout_ms: 5000,
    call_timeout_ms: 1000,
    ...extra,
  };
}

interface OutwardHarness {
  bridge: ExternalMcpBridge;
  server: McpServer;
  client: Client;
  close(): Promise<void>;
}

async function outwardHarness(
  bridge: ExternalMcpBridge,
  nativeNames: ReadonlySet<string> = new Set(),
): Promise<OutwardHarness> {
  const server = new McpServer({ name: "gwc-outer-test", version: "1.0.0" });
  await bridge.registerTools(server, nativeNames);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "gwc-outer-test-client", version: "1.0.0" },
    { jsonSchemaValidator: new AjvJsonSchemaValidator() },
  );
  await client.connect(clientTransport);
  return {
    bridge,
    server,
    client,
    async close() {
      await Promise.allSettled([client.close(), server.close(), bridge.shutdown()]);
    },
  };
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if ("toolResult" in result) return "";
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map(item => item.text)
    .join("\n");
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function unusedLoopbackMcpUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve loopback port");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return url;
}

test("bridge reports no configured servers when no external MCP config is present", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: {
      version: 1,
      path: "/tmp/nonexistent-external-mcp.json",
      loaded: false,
      servers: [],
    },
  });
  try {
    expect(bridge.status()).toEqual({
      config_loaded: false,
      config_path: "/tmp/nonexistent-external-mcp.json",
      servers_configured: 0,
      servers: [],
    });
  } finally {
    await bridge.shutdown();
  }
});

test("stdio bridge dynamically preserves schema, annotations, arguments, results, images and metadata boundary", async () => {
  const bridge = await ExternalMcpBridge.initialize({ config: config({ fixture: stdioServer() }) });
  const harness = await outwardHarness(bridge);
  try {
    const listing = await harness.client.listTools();
    const echo = listing.tools.find(tool => tool.name === "fixture__echo");
    expect(echo).toBeDefined();
    expect(echo?.title).toBe("Fixture echo");
    expect(echo?.description).toContain("Echoes validated");
    expect(echo?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const schema = echo?.inputSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("query");
    expect(schema.properties.query).toMatchObject({ type: "string", minLength: 2 });
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.nested.type).toBe("object");
    expect(schema.properties.nested.properties.tags.type).toBe("array");
    expect(schema.properties.nested.properties.tags.items.type).toBe("string");
    expect(schema.properties.nested.additionalProperties).toBe(false);
    const outputSchema = echo?.outputSchema as any;
    expect(outputSchema.type).toBe("object");
    expect(outputSchema.required).toContain("received");
    expect(outputSchema.additionalProperties).toBe(false);

    expect((echo as any)._meta?.["openai/outputTemplate"]).toBeUndefined();
    expect((echo as any)._meta?.["ui/resourceUri"]).toBeUndefined();
    expect((echo as any)._meta?.private_fixture_key).toBeUndefined();

    const args = { query: "hello", limit: 3, nested: { tags: ["a", "b"] } };
    const echoed = await harness.client.callTool({ name: "fixture__echo", arguments: args });
    expect("toolResult" in echoed).toBe(false);
    if ("toolResult" in echoed) throw new Error("unexpected task result");
    expect(echoed.structuredContent).toEqual({ received: args });
    expect(textContent(echoed)).toContain("echo:hello");

    const mapped = await harness.client.callTool({
      name: "fixture__original_tool",
      arguments: { value: "preserved" },
    });
    expect(textContent(mapped)).toContain("original.tool:preserved");

    const remoteError = await harness.client.callTool({ name: "fixture__error_tool", arguments: {} });
    expect("toolResult" in remoteError).toBe(false);
    if ("toolResult" in remoteError) throw new Error("unexpected task result");
    expect(remoteError.isError).toBe(true);
    expect(textContent(remoteError)).toContain('External MCP "fixture" tool "error_tool" reported an error.');
    expect(textContent(remoteError)).toContain("fixture remote error");

    const metadata = await harness.client.callTool({ name: "fixture__metadata_result", arguments: {} });
    expect("toolResult" in metadata).toBe(false);
    if ("toolResult" in metadata) throw new Error("unexpected task result");
    expect((metadata as any)._meta?.["openai/outputTemplate"]).toBeUndefined();
    expect((metadata.content[0] as any)._meta).toBeUndefined();

    const image = await harness.client.callTool({ name: "fixture__image_result", arguments: {} });
    expect("toolResult" in image).toBe(false);
    if ("toolResult" in image) throw new Error("unexpected task result");
    const imageItem = image.content.find(item => item.type === "image") as any;
    expect(imageItem?.mimeType).toBe("image/png");
    expect(imageItem?.data).toStartWith("iVBOR");
    expect(imageItem?._meta).toBeUndefined();

    expect(listing.tools.some(tool => tool.name === "external_mcp_call")).toBe(false);
    expect(listing.tools.some(tool => tool.name === "external_mcp_status")).toBe(true);
  } finally {
    await harness.close();
  }
});

test("allow/deny policy filters before exposure and offers no generic bypass", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      policy: stdioServer({
        tools: { allow: ["echo", "hidden_tool"], deny: ["hidden_tool"] },
      }),
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const names = (await harness.client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("policy__echo");
    expect(names).not.toContain("policy__hidden_tool");
    expect(names.filter(name => name.startsWith("policy__"))).toEqual(["policy__echo"]);
    const denied = await harness.client.callTool({ name: "policy__hidden_tool", arguments: {} });
    if ("toolResult" in denied) throw new Error("unexpected task result");
    expect(denied.isError).toBe(true);
    expect(textContent(denied)).toContain("not found");
    expect(textContent(denied)).not.toBe("hidden");
    expect(bridge.status().servers[0]?.tools_exposed).toBe(1);
  } finally {
    await harness.close();
  }
});

test("disabled stdio server is never spawned", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-external-disabled-"));
  const marker = join(root, "started.txt");
  try {
    const bridge = await ExternalMcpBridge.initialize({
      config: config({
        disabled: stdioServer({
          enabled: false,
          env: { EXTERNAL_MCP_START_MARKER: marker },
        }),
      }),
    });
    try {
      expect(existsSync(marker)).toBe(false);
      expect(bridge.status().servers[0]).toMatchObject({
        enabled: false,
        lifecycle: "disabled",
        tools_discovered: 0,
        tools_exposed: 0,
      });
    } finally {
      await bridge.shutdown();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdio child receives only safe baseline plus explicitly inherited/literal environment", async () => {
  const oldSecret = process.env.EXTERNAL_MCP_TEST_SECRET;
  const oldAllowed = process.env.EXTERNAL_MCP_TEST_ALLOWED;
  process.env.EXTERNAL_MCP_TEST_SECRET = "secret-must-not-cross";
  process.env.EXTERNAL_MCP_TEST_ALLOWED = "allowed-crossing";
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      envtest: stdioServer({
        inherit_env: ["EXTERNAL_MCP_TEST_ALLOWED"],
        env: { EXTERNAL_MCP_TEST_LITERAL: "literal-crossing" },
        tools: { allow: ["env_probe"] },
      }),
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const result = await harness.client.callTool({ name: "envtest__env_probe", arguments: {} });
    if ("toolResult" in result) throw new Error("unexpected task result");
    expect(result.structuredContent).toEqual({
      secret: null,
      allowed: "allowed-crossing",
      literal: "literal-crossing",
    });
    const statusText = JSON.stringify(bridge.status());
    expect(statusText).not.toContain("secret-must-not-cross");
    expect(statusText).not.toContain("literal-crossing");
  } finally {
    await harness.close();
    if (oldSecret === undefined) delete process.env.EXTERNAL_MCP_TEST_SECRET;
    else process.env.EXTERNAL_MCP_TEST_SECRET = oldSecret;
    if (oldAllowed === undefined) delete process.env.EXTERNAL_MCP_TEST_ALLOWED;
    else process.env.EXTERNAL_MCP_TEST_ALLOWED = oldAllowed;
  }
});

test("startup errors and external_mcp_status redact inherited and literal stdio secrets", async () => {
  const oldInherited = process.env.EXTERNAL_MCP_REVIEW_INHERITED;
  process.env.EXTERNAL_MCP_REVIEW_INHERITED = "review-secret-7x9";
  let bridge: ExternalMcpBridge | undefined;
  let harness: OutwardHarness | undefined;
  try {
    bridge = await ExternalMcpBridge.initialize({
      config: config({
        startup_secret: {
          transport: "stdio",
          command: process.execPath,
          args: [startupErrorFixture],
          inherit_env: ["EXTERNAL_MCP_REVIEW_INHERITED"],
          env: { EXTERNAL_MCP_REVIEW_LITERAL: "xy" },
          startup_timeout_ms: 2000,
        },
      }),
    });
    const serverStatus = bridge.status().servers[0];
    expect(serverStatus?.lifecycle).toBe("unavailable");
    expect(serverStatus?.last_startup_error).toContain("<redacted>");
    expect(JSON.stringify(serverStatus)).not.toContain("review-secret-7x9");
    expect(JSON.stringify(serverStatus)).not.toContain("xy");

    harness = await outwardHarness(bridge);
    const statusResult = await harness.client.callTool({ name: "external_mcp_status", arguments: {} });
    if ("toolResult" in statusResult) throw new Error("unexpected task result");
    const statusText = JSON.stringify(statusResult.structuredContent);
    expect(statusText).not.toContain("review-secret-7x9");
    expect(statusText).not.toContain("xy");
    expect(statusText).toContain("<redacted>");
  } finally {
    if (harness) await harness.close();
    else await bridge?.shutdown();
    if (oldInherited === undefined) delete process.env.EXTERNAL_MCP_REVIEW_INHERITED;
    else process.env.EXTERNAL_MCP_REVIEW_INHERITED = oldInherited;
  }
});

test("runtime errors and external_mcp_status use the stdio secret snapshot captured at startup", async () => {
  const oldInherited = process.env.EXTERNAL_MCP_REVIEW_INHERITED;
  process.env.EXTERNAL_MCP_REVIEW_INHERITED = "runtime-secret-8q2";
  let bridge: ExternalMcpBridge | undefined;
  let harness: OutwardHarness | undefined;
  try {
    bridge = await ExternalMcpBridge.initialize({
      config: config({
        runtime_secret: stdioServer({
          inherit_env: ["EXTERNAL_MCP_REVIEW_INHERITED"],
          env: { EXTERNAL_MCP_REVIEW_LITERAL: "z" },
          tools: { allow: ["readonly_status"] },
        }),
      }),
    });
    harness = await outwardHarness(bridge);

    process.env.EXTERNAL_MCP_REVIEW_INHERITED = "changed-after-spawn";
    const runtime = (bridge as any).runtimes[0];
    runtime.client.callTool = async () => {
      throw new Error("remote leaked runtime-secret-8q2 and z");
    };

    const failed = await harness.client.callTool({ name: "runtime_secret__readonly_status", arguments: {} });
    if ("toolResult" in failed) throw new Error("unexpected task result");
    expect(failed.isError).toBe(true);
    expect(textContent(failed)).not.toContain("runtime-secret-8q2");
    expect(textContent(failed)).not.toContain(" and z");
    expect(textContent(failed)).toContain("<redacted>");

    const runtimeStatus = bridge.status().servers[0];
    expect(runtimeStatus?.last_runtime_error).toContain("<redacted>");
    expect(JSON.stringify(runtimeStatus)).not.toContain("runtime-secret-8q2");

    const statusResult = await harness.client.callTool({ name: "external_mcp_status", arguments: {} });
    if ("toolResult" in statusResult) throw new Error("unexpected task result");
    expect(JSON.stringify(statusResult.structuredContent)).not.toContain("runtime-secret-8q2");
  } finally {
    if (harness) await harness.close();
    else await bridge?.shutdown();
    if (oldInherited === undefined) delete process.env.EXTERNAL_MCP_REVIEW_INHERITED;
    else process.env.EXTERNAL_MCP_REVIEW_INHERITED = oldInherited;
  }
});

test("optional server failure is isolated while a second server remains usable", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      broken: {
        transport: "stdio",
        command: "/definitely/not/a/real/external-mcp",
        required: false,
        startup_timeout_ms: 500,
      },
      healthy: stdioServer({ tools: { allow: ["readonly_status"] } }),
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const statuses = bridge.status().servers;
    expect(statuses.find(item => item.alias === "broken")?.lifecycle).toBe("unavailable");
    expect(statuses.find(item => item.alias === "healthy")?.lifecycle).toBe("connected");
    const result = await harness.client.callTool({ name: "healthy__readonly_status", arguments: {} });
    expect(textContent(result)).toContain("fixture-ok");
  } finally {
    await harness.close();
  }
});

test("required server failure aborts bridge startup", async () => {
  await expect(ExternalMcpBridge.initialize({
    config: config({
      broken: {
        transport: "stdio",
        command: "/definitely/not/a/real/external-mcp",
        required: true,
        startup_timeout_ms: 500,
      },
    }),
  })).rejects.toThrow("Required external MCP startup failed");
});

test("startup timeout is bounded and leaves an optional MCP unavailable", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      hanging: stdioServer({
        args: [stdioFixture, "--hang-before-connect"],
        startup_timeout_ms: 150,
      }),
    }),
  });
  try {
    expect(bridge.status().servers[0]?.lifecycle).toBe("unavailable");
    expect(bridge.status().servers[0]?.last_startup_error?.toLowerCase()).toContain("timed out");
  } finally {
    await bridge.shutdown();
  }
});

test("invalid remote tool definitions fail discovery instead of being exposed", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      invalid: {
        transport: "stdio",
        command: process.execPath,
        args: [invalidStdioFixture],
        startup_timeout_ms: 2000,
      },
    }),
  });
  try {
    expect(bridge.status().servers[0]?.lifecycle).toBe("unavailable");
    expect(bridge.status().servers[0]?.tools_exposed).toBe(0);
    expect(bridge.status().servers[0]?.last_startup_error).not.toBeNull();
  } finally {
    await bridge.shutdown();
  }
});

test("optional Streamable HTTP connection failure is contained", async () => {
  const url = await unusedLoopbackMcpUrl();
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      unreachable: {
        transport: "streamable-http",
        url,
        startup_timeout_ms: 500,
      },
    }),
  });
  try {
    expect(bridge.status().servers[0]?.lifecycle).toBe("unavailable");
    expect(bridge.status().servers[0]?.tools_exposed).toBe(0);
    expect(JSON.stringify(bridge.status())).not.toContain(url);
  } finally {
    await bridge.shutdown();
  }
});

test("call timeout is contained and reported as an external MCP error", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      timeout: stdioServer({
        call_timeout_ms: 100,
        tools: { allow: ["slow"] },
      }),
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const result = await harness.client.callTool({ name: "timeout__slow", arguments: { ms: 500 } });
    if ("toolResult" in result) throw new Error("unexpected task result");
    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain('External MCP "timeout" tool "slow" failed');
    expect(textContent(result).toLowerCase()).toContain("timeout");
  } finally {
    await harness.close();
  }
});

test("crash of one stdio MCP does not contaminate an independent MCP", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      alpha: stdioServer({ call_timeout_ms: 500 }),
      beta: stdioServer({ tools: { allow: ["readonly_status"] } }),
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const crashed = await harness.client.callTool({ name: "alpha__crash_process", arguments: {} });
    if ("toolResult" in crashed) throw new Error("unexpected task result");
    expect(crashed.isError).toBe(true);
    await waitFor(() => bridge.status().servers.find(item => item.alias === "alpha")?.lifecycle === "crashed");

    const healthy = await harness.client.callTool({ name: "beta__readonly_status", arguments: {} });
    expect(textContent(healthy)).toContain("fixture-ok");
    expect(bridge.status().servers.find(item => item.alias === "beta")?.lifecycle).toBe("connected");
  } finally {
    await harness.close();
  }
});

test("shutdown closes the stdio process owned by GWC", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({ owned: stdioServer({ tools: { allow: ["pid_status"] } }) }),
  });
  const pid = bridge.status().servers[0]?.pid;
  expect(pid).toBeNumber();
  if (!pid) throw new Error("fixture pid was not reported");
  expect(processExists(pid)).toBe(true);
  await bridge.shutdown();
  await waitFor(() => !processExists(pid), 5000);
  expect(processExists(pid)).toBe(false);
});

test("normalized remote tool collisions reject the whole optional server", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      collision: stdioServer({ args: [stdioFixture, "--collision"] }),
    }),
  });
  try {
    expect(bridge.status().servers[0]?.lifecycle).toBe("unavailable");
    expect(bridge.status().servers[0]?.last_startup_error).toContain("collide after normalization");
    expect(bridge.status().servers[0]?.tools_exposed).toBe(0);
  } finally {
    await bridge.shutdown();
  }
});

test("native name collision rejects an optional external server instead of silently renaming it", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({ fixture: stdioServer({ tools: { allow: ["echo"] } }) }),
  });
  const server = new McpServer({ name: "native-collision-test", version: "1.0.0" });
  try {
    await bridge.registerTools(server, new Set(["fixture__echo"]));
    expect(bridge.status().servers[0]?.lifecycle).toBe("unavailable");
    expect(bridge.status().servers[0]?.last_startup_error).toContain("collides with a native GWC tool");
  } finally {
    await Promise.allSettled([server.close(), bridge.shutdown()]);
  }
});

test("native name collision aborts registration for a required external server", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      required_fixture: stdioServer({
        alias: "fixture",
        required: true,
        tools: { allow: ["echo"] },
      }),
    }),
  });
  const server = new McpServer({ name: "required-native-collision-test", version: "1.0.0" });
  try {
    await expect(bridge.registerTools(server, new Set(["fixture__echo"]))).rejects.toThrow(
      "Required external MCP",
    );
    expect(bridge.status().servers[0]?.lifecycle).toBe("unavailable");
  } finally {
    await Promise.allSettled([server.close(), bridge.shutdown()]);
  }
});

test("rejected optional server does not reserve staged public names for later servers", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      first: {
        alias: "x",
        transport: "stdio",
        command: process.execPath,
        args: [namesStdioFixture, "p__s"],
        startup_timeout_ms: 5000,
      },
      rejected: {
        alias: "x__p",
        transport: "stdio",
        command: process.execPath,
        args: [namesStdioFixture, "q__r", "s"],
        startup_timeout_ms: 5000,
      },
      later: {
        alias: "x__p__q",
        transport: "stdio",
        command: process.execPath,
        args: [namesStdioFixture, "r"],
        startup_timeout_ms: 5000,
      },
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const statuses = bridge.status().servers;
    expect(statuses.find(item => item.alias === "x")?.lifecycle).toBe("connected");
    expect(statuses.find(item => item.alias === "x__p")?.lifecycle).toBe("unavailable");
    expect(statuses.find(item => item.alias === "x__p__q")?.lifecycle).toBe("connected");

    const names = (await harness.client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("x__p__s");
    expect(names).toContain("x__p__q__r");
    expect(names.filter(name => name === "x__p__q__r")).toHaveLength(1);

    const later = await harness.client.callTool({ name: "x__p__q__r", arguments: {} });
    expect(textContent(later)).toBe("called:r");
  } finally {
    await harness.close();
  }
});

test("two configured MCPs expose independent namespaces simultaneously", async () => {
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      first: stdioServer({ tools: { allow: ["readonly_status"] } }),
      second: stdioServer({ tools: { allow: ["original.tool"] } }),
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const names = (await harness.client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("first__readonly_status");
    expect(names).toContain("second__original_tool");
    expect(textContent(await harness.client.callTool({
      name: "first__readonly_status",
      arguments: {},
    }))).toContain("fixture-ok");
    expect(textContent(await harness.client.callTool({
      name: "second__original_tool",
      arguments: { value: "two" },
    }))).toContain("original.tool:two");
  } finally {
    await harness.close();
  }
});

test("Streamable HTTP bridge performs initialize, discovery and call without owning the HTTP server", async () => {
  const http = await startExternalMcpHttpFixture();
  const bridge = await ExternalMcpBridge.initialize({
    config: config({
      research: {
        transport: "streamable-http",
        url: http.url,
        startup_timeout_ms: 5000,
        call_timeout_ms: 1000,
      },
    }),
  });
  const harness = await outwardHarness(bridge);
  try {
    const listing = await harness.client.listTools();
    const search = listing.tools.find(tool => tool.name === "research__search");
    expect(search).toBeDefined();
    expect((search?.inputSchema as any).properties.query).toMatchObject({ type: "string", minLength: 2 });
    expect((search?.inputSchema as any).additionalProperties).toBe(false);

    const result = await harness.client.callTool({
      name: "research__search",
      arguments: { query: "papers", limit: 4 },
    });
    if ("toolResult" in result) throw new Error("unexpected task result");
    expect(result.structuredContent).toEqual({
      query: "papers",
      limit: 4,
      transport: "streamable-http",
    });

    expect(bridge.status().servers[0]).toMatchObject({
      transport: "streamable-http",
      lifecycle: "connected",
      pid: null,
    });

    await bridge.shutdown();
    expect(http.server.listening).toBe(true);
    expect((await fetch(http.url)).status).toBe(405);
  } finally {
    await Promise.allSettled([harness.client.close(), harness.server.close(), bridge.shutdown()]);
    await http.close();
  }
});
