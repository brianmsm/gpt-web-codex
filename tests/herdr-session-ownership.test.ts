import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationSessionId } from "../src/adapters/chatgpt-web/mcp-server";
import type { HerdrClient } from "../src/standalone/herdr-client";
import { registerHerdrTools } from "../src/standalone/herdr-tools";
import { LunaStateStore } from "../src/standalone/state-store";

const HERDR_SESSION = "default";
const WORKSPACE_ID = "w-owned";
const TAB_ID = "w-owned:t1";
const PANE_ID = "w-owned:p1";

function fakeHerdr(root: string): HerdrClient {
  return {
    async openWorkspace() {
      return {
        session: HERDR_SESSION,
        socket_path: "/tmp/herdr.sock",
        created: false,
        cwd: root,
        workspace: { workspace_id: WORKSPACE_ID, active_tab_id: TAB_ID },
        tab: { tab_id: TAB_ID, workspace_id: WORKSPACE_ID },
        root_pane: null,
        panes: [{ pane_id: PANE_ID, workspace_id: WORKSPACE_ID, tab_id: TAB_ID, cwd: root }],
      };
    },
    async readPane() {
      return {
        session: HERDR_SESSION,
        socket_path: "/tmp/herdr.sock",
        read: { pane_id: PANE_ID, text: "owned output", revision: 1 },
      };
    },
    async paneStatus() {
      return {
        session: HERDR_SESSION,
        socket_path: "/tmp/herdr.sock",
        pane_id: PANE_ID,
        health: "healthy" as const,
        pane: { pane_id: PANE_ID, workspace_id: WORKSPACE_ID, cwd: root },
        process_info: null,
        process_error: null,
        agent_state: "unknown",
      };
    },
  } as unknown as HerdrClient;
}

async function ownershipHarness(root: string, statePath: string) {
  const server = new McpServer({ name: "herdr-session-ownership-test", version: "1.0.0" });
  registerHerdrTools(server, fakeHerdr(root), new LunaStateStore(statePath), conversationSessionId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "herdr-session-ownership-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

test("pre-ownership version 1 state loads with empty Herdr ownership and persists new bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-herdr-state-migration-"));
  const statePath = join(root, "state.json");
  try {
    writeFileSync(statePath, JSON.stringify({ version: 1, sessions: {}, jobs: {} }), "utf8");
    const store = new LunaStateStore(statePath);
    expect(store.herdrWorkspaceOwner(HERDR_SESSION, WORKSPACE_ID)).toBeUndefined();
    expect(store.herdrPaneOwner(HERDR_SESSION, PANE_ID)).toBeUndefined();
    store.bindHerdrWorkspace("chatgpt:migrated-owner", HERDR_SESSION, WORKSPACE_ID);
    store.bindHerdrPane("chatgpt:migrated-owner", HERDR_SESSION, PANE_ID);
    const reloaded = new LunaStateStore(statePath);
    expect(reloaded.herdrWorkspaceOwner(HERDR_SESSION, WORKSPACE_ID)).toBe("chatgpt:migrated-owner");
    expect(reloaded.herdrPaneOwner(HERDR_SESSION, PANE_ID)).toBe("chatgpt:migrated-owner");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Herdr ownership survives GWC restart and blocks cross-session cwd or pane reacquisition", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-herdr-session-owner-"));
  const statePath = join(root, "state.json");
  const sessionA = "herdr-owner-a";
  const sessionB = "herdr-owner-b";
  const canonicalA = conversationSessionId(undefined, { "openai/session": sessionA }, false);
  let first: Awaited<ReturnType<typeof ownershipHarness>> | undefined;
  let restarted: Awaited<ReturnType<typeof ownershipHarness>> | undefined;
  try {
    first = await ownershipHarness(root, statePath);
    const adopted = await first.client.callTool({
      name: "herdr_workspace_open",
      arguments: {
        session: HERDR_SESSION,
        cwd: root,
        workspace_path: root,
        permission_mode: "read-only",
      },
      _meta: { "openai/session": sessionA },
    });
    expect(adopted.isError).not.toBe(true);
    expect(adopted.structuredContent).toMatchObject({
      web_session_id: canonicalA,
      created: false,
      workspace: { workspace_id: WORKSPACE_ID },
      panes: [{ pane_id: PANE_ID }],
    });
    await first.close();
    first = undefined;

    restarted = await ownershipHarness(root, statePath);
    const ownerRead = await restarted.client.callTool({
      name: "herdr_pane_read",
      arguments: {
        session: HERDR_SESSION,
        pane_id: PANE_ID,
        workspace_path: root,
        permission_mode: "read-only",
      },
      _meta: { "openai/session": sessionA },
    });
    expect(ownerRead.isError).not.toBe(true);
    expect(ownerRead.structuredContent).toMatchObject({
      web_session_id: canonicalA,
      read: { pane_id: PANE_ID, text: "owned output" },
    });

    const crossOpen = await restarted.client.callTool({
      name: "herdr_workspace_open",
      arguments: {
        session: HERDR_SESSION,
        cwd: root,
        workspace_path: root,
        permission_mode: "read-only",
      },
      _meta: { "openai/session": sessionB },
    });
    expect(crossOpen.isError).toBe(true);
    expect(crossOpen.structuredContent).toMatchObject({
      error: { code: "cross_session_ownership" },
    });
    expect(JSON.stringify(crossOpen.structuredContent)).not.toContain(WORKSPACE_ID);
    expect(JSON.stringify(crossOpen.structuredContent)).not.toContain(PANE_ID);

    const crossRead = await restarted.client.callTool({
      name: "herdr_pane_read",
      arguments: {
        session: HERDR_SESSION,
        pane_id: PANE_ID,
        workspace_path: root,
        permission_mode: "danger-full-access",
      },
      _meta: { "openai/session": sessionB },
    });
    expect(crossRead.isError).toBe(true);
    expect(crossRead.structuredContent).toMatchObject({
      error: { code: "cross_session_ownership" },
    });

    const crossStatus = await restarted.client.callTool({
      name: "herdr_pane_status",
      arguments: {
        session: HERDR_SESSION,
        pane_id: PANE_ID,
        workspace_path: root,
        permission_mode: "read-only",
      },
      _meta: { "openai/session": sessionB },
    });
    expect(crossStatus.isError).toBe(true);
    expect(crossStatus.structuredContent).toMatchObject({
      error: { code: "cross_session_ownership" },
    });

    const spoofedOwner = await restarted.client.callTool({
      name: "herdr_pane_read",
      arguments: {
        web_session_id: canonicalA,
        session: HERDR_SESSION,
        pane_id: PANE_ID,
        workspace_path: root,
        permission_mode: "read-only",
      },
      _meta: { "openai/session": sessionB },
    });
    expect(spoofedOwner.isError).toBe(true);
    expect(spoofedOwner.structuredContent).toMatchObject({
      error: { message: expect.stringContaining("authoritative ChatGPT openai/session metadata") },
    });
  } finally {
    if (first) await first.close();
    if (restarted) await restarted.close();
    rmSync(root, { recursive: true, force: true });
  }
});
