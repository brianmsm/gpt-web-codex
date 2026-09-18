import { createInterface } from "node:readline";

const inherited = process.env.EXTERNAL_MCP_REVIEW_INHERITED ?? "missing-inherited";
const literal = process.env.EXTERNAL_MCP_REVIEW_LITERAL ?? "missing-literal";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line) as { id?: string | number; method?: string };
  if (request.method !== "initialize" || request.id === undefined) continue;
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: -32000,
      message: `startup rejected inherited=${inherited} literal=${literal}`,
    },
  })}\n`);
  break;
}
