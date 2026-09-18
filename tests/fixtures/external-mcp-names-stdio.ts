import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const toolNames = process.argv.slice(2);
if (toolNames.length === 0) throw new Error("at least one tool name is required");

const server = new McpServer({ name: "gwc-external-names-fixture", version: "1.0.0" });
for (const name of toolNames) {
  server.registerTool(name, {
    inputSchema: z.object({}).strict(),
  }, async () => ({
    content: [{ type: "text", text: `called:${name}` }],
  }));
}

await server.connect(new StdioServerTransport());
