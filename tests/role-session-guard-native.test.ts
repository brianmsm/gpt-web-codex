import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { RoleSessionGuard } from "../src/standalone/session-capabilities/role-session-guard";
import { SessionCapabilityBoundary } from "../src/standalone/session-capabilities/boundary";
import { parseSessionCapabilityConfig, sessionKeyFromOpenAiMetadata } from "../src/standalone/session-capabilities/config";

test("native cross-platform role guards deny cross-conversation reads and writes before and after enrollment", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-role-guard-native-"));
  const sessionA = "native-session-A";
  const sessionB = "native-session-B";
  type Endpoint = { client: Client; server: McpServer; guard: RoleSessionGuard; binding: string };
  const endpoints: Endpoint[] = [];
  const writes: Record<string, string[]> = { A: [], B: [] };
  try {
    for (const role of ["A", "B"] as const) {
      const folder = join(root, role);
      mkdirSync(folder);
      const key = join(folder, "hmac.key");
      const binding = join(folder, "binding.txt");
      writeFileSync(key, randomBytes(32), { mode: 0o600 });
      writeFileSync(binding, "", { mode: 0o600 });
      const guard = new RoleSessionGuard({ role, privateKeyPath: key, bindingFilePath: binding });
      const server = new McpServer({ name: "native-" + role, version: "1.0.0" });
      guard.install(server);
      server.registerTool("study_identity", { inputSchema: z.object({}).strict() },
        async () => ({ content: [{ type: "text", text: "authorized-" + role }] }));
      server.registerTool("save_artifact", { inputSchema: z.object({ value: z.string() }).strict() },
        async ({ value }) => {
          writes[role]!.push(value);
          return { content: [{ type: "text", text: "saved-for-" + role }] };
        });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "native-role-guard", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      endpoints.push({ client, server, guard, binding });
    }

    const invoke = (role: "A" | "B", identity: string, name: string, args: Record<string, unknown> = {}) =>
      endpoints[role === "A" ? 0 : 1]!.client.callTool({
        name, arguments: args, _meta: { "openai/session": identity },
      });

    for (const role of ["A", "B"] as const) {
      const identity = role === "A" ? sessionA : sessionB;
      const denied = await invoke(role, identity, "study_identity");
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        authorization: "denied", reason: "enrollment_required",
      });
      expect((await invoke(role, identity, "save_artifact", { value: "no-enrollment" })).isError).toBe(true);
      const endpoint = endpoints[role === "A" ? 0 : 1]!;
      const fingerprint = endpoint.guard.fingerprint({ "openai/session": identity });
      expect(fingerprint).toBe((denied.structuredContent as { session_fingerprint: string }).session_fingerprint);
      writeFileSync(endpoint.binding, fingerprint + "\n");
    }

    for (const role of ["A", "B"] as const) {
      const own = role === "A" ? sessionA : sessionB;
      const foreign = role === "A" ? sessionB : sessionA;
      expect((await invoke(role, own, "study_identity")).isError).not.toBe(true);
      expect((await invoke(role, foreign, "study_identity")).structuredContent).toMatchObject({
        authorization: "denied", reason: "forbidden",
      });
      expect((await invoke(role, foreign, "save_artifact", { value: "cross-role-write" })).isError).toBe(true);
      expect((await invoke(role, own, "save_artifact", { value: "correct-" + role })).isError).not.toBe(true);
    }
    expect(writes).toEqual({ A: ["correct-A"], B: ["correct-B"] });

    writeFileSync(endpoints[0]!.binding, "invalid-binding\n");
    const corrupted = await invoke("A", sessionA, "save_artifact", { value: "bad" });
    expect(corrupted.structuredContent).toMatchObject({
      authorization: "denied", reason: "invalid_binding",
    });
    expect(writes.A).toEqual(["correct-A"]);
    // Different role's identity and authorization remain unaffected.
    expect((await invoke("B", sessionB, "study_identity")).isError).not.toBe(true);
    expect(readFileSync(endpoints[1]!.binding, "utf8")).toStartWith("rater-session:B:");
  } finally {
    for (const { client, server } of endpoints) {
      await client.close();
      await server.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared catalog denies restricted resources over a native MCP transport", async () => {
  const identity = "native-restricted-session";
  const meta = { "openai/session": identity };
  const policy = parseSessionCapabilityConfig({
    version: 1,
    default_policy: "legacy",
    catalog_mode: "shared",
    profiles: { sealed: { version: 1, native_tools: [], external_tools: [] } },
    session_bindings: { [sessionKeyFromOpenAiMetadata(meta)]: "sealed" },
  }, "/tmp/native-session-resource-policy.json");
  const server = new McpServer({ name: "shared-resource-boundary-test", version: "1.0.0" });
  new SessionCapabilityBoundary(policy, new Set<string>()).install(server);
  const resource = "test://native-policy/private";
  server.registerResource("test-resource", resource, { mimeType: "text/plain" }, async () => ({
    contents: [{ uri: resource, mimeType: "text/plain", text: "synthetic resource" }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shared-resource-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // The server must explicitly deny, not merely time out a client request.
    await expect(client.listResources({ _meta: meta }, { timeout: 3000, maxTotalTimeout: 3000 }))
      .rejects.toThrow("Capability policy denied non-tool MCP request");
    const coordinator = await client.listResources({ _meta: { "openai/session": "native-coordinator" } });
    expect(coordinator.resources.map(item => item.uri)).toEqual([resource]);
  } finally {
    await client.close();
    await server.close();
  }
});
