import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const marker = process.env.EXTERNAL_MCP_START_MARKER;
if (marker) writeFileSync(marker, "started\n", "utf8");

const server = new McpServer({ name: "gwc-external-stdio-fixture", version: "1.0.0" });

server.registerTool("echo", {
  title: "Fixture echo",
  description: "Echoes validated structured arguments for external MCP bridge tests.",
  inputSchema: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(10).optional(),
    nested: z.object({
      tags: z.array(z.string().min(1)).min(1),
    }).strict().optional(),
  }).strict(),
  outputSchema: z.object({ received: z.unknown() }).strict(),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    "openai/outputTemplate": "ui://attacker/fixture.html",
    "ui/resourceUri": "ui://attacker/fixture.html",
    private_fixture_key: "must-not-cross-definition-boundary",
  },
}, async input => ({
  content: [{ type: "text", text: `echo:${input.query}` }],
  structuredContent: { received: input },
}));

server.registerTool("readonly_status", {
  description: "Returns a stable fixture status.",
  inputSchema: z.object({}).strict(),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => ({ content: [{ type: "text", text: "fixture-ok" }] }));

server.registerTool("mutate", {
  description: "A mutation-shaped fixture tool.",
  inputSchema: z.object({ value: z.string() }).strict(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async input => ({ content: [{ type: "text", text: `mutated:${input.value}` }] }));

server.registerTool("hidden_tool", {
  description: "This tool exists so allow/deny policy can hide it.",
  inputSchema: z.object({}).strict(),
}, async () => ({ content: [{ type: "text", text: "hidden" }] }));

server.registerTool("error_tool", {
  inputSchema: z.object({}).strict(),
}, async () => ({
  content: [{ type: "text", text: "fixture remote error" }],
  isError: true,
}));

server.registerTool("slow", {
  inputSchema: z.object({ ms: z.number().int().min(1).max(10_000) }).strict(),
}, async ({ ms }) => {
  await new Promise(resolve => setTimeout(resolve, ms));
  return { content: [{ type: "text", text: "slow-complete" }] };
});

server.registerTool("env_probe", {
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({
    secret: z.string().nullable(),
    allowed: z.string().nullable(),
    literal: z.string().nullable(),
  }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => ({
  content: [{ type: "text", text: "environment inspected" }],
  structuredContent: {
    secret: process.env.EXTERNAL_MCP_TEST_SECRET ?? null,
    allowed: process.env.EXTERNAL_MCP_TEST_ALLOWED ?? null,
    literal: process.env.EXTERNAL_MCP_TEST_LITERAL ?? null,
  },
}));

server.registerTool("metadata_result", {
  inputSchema: z.object({}).strict(),
}, async () => ({
  content: [{
    type: "text",
    text: "metadata boundary",
    _meta: { "openai/outputTemplate": "ui://attacker/result.html", nested_secret: "drop-me" },
  }],
  _meta: { "openai/outputTemplate": "ui://attacker/top.html", private_result_key: "drop-me" },
}));

server.registerTool("image_result", {
  inputSchema: z.object({}).strict(),
}, async () => ({
  content: [{
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    _meta: { private_image_key: "drop-me" },
  }],
}));

server.registerTool("original.tool", {
  inputSchema: z.object({ value: z.string() }).strict(),
}, async ({ value }) => ({
  content: [{ type: "text", text: `original.tool:${value}` }],
}));

server.registerTool("pid_status", {
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ pid: z.number().int().positive() }).strict(),
}, async () => ({
  content: [{ type: "text", text: String(process.pid) }],
  structuredContent: { pid: process.pid },
}));

server.registerTool("crash_process", {
  inputSchema: z.object({}).strict(),
}, async () => {
  process.exit(17);
});

if (process.argv.includes("--collision")) {
  server.registerTool("dupe.tool", {
    inputSchema: z.object({}).strict(),
  }, async () => ({ content: [{ type: "text", text: "dot" }] }));
  server.registerTool("dupe tool", {
    inputSchema: z.object({}).strict(),
  }, async () => ({ content: [{ type: "text", text: "space" }] }));
}

if (process.argv.includes("--hang-before-connect")) {
  await new Promise<never>(() => {
    setInterval(() => undefined, 1_000);
  });
}

await server.connect(new StdioServerTransport());
