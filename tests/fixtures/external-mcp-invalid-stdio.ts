import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "gwc-external-invalid-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "invalid_schema",
    description: "Deliberately violates the MCP tool schema for bridge validation tests.",
    inputSchema: { type: "string" },
  }],
} as any));

await server.connect(new StdioServerTransport());
