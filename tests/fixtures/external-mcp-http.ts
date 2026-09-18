import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

function fixtureServer(): McpServer {
  const server = new McpServer({ name: "gwc-external-http-fixture", version: "1.0.0" });
  server.registerTool("search", {
    title: "Fixture HTTP search",
    description: "Returns the query and limit over Streamable HTTP.",
    inputSchema: z.object({
      query: z.string().min(2),
      limit: z.number().int().min(1).max(5).default(2),
    }).strict(),
    outputSchema: z.object({
      query: z.string(),
      limit: z.number().int(),
      transport: z.literal("streamable-http"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => ({
    content: [{ type: "text", text: `http-search:${input.query}` }],
    structuredContent: { query: input.query, limit: input.limit, transport: "streamable-http" as const },
  }));
  server.registerTool("status", {
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: "http-fixture-ok" }] }));
  return server;
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }));
    return;
  }

  const server = fixtureServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, await body(req));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Fixture server error" },
        id: null,
      }));
    }
  } finally {
    res.once("close", () => {
      void transport.close();
      void server.close();
    });
  }
}

export interface ExternalMcpHttpFixture {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startExternalMcpHttpFixture(): Promise<ExternalMcpHttpFixture> {
  const server = createServer((req, res) => {
    void handleMcp(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
