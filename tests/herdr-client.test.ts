import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HerdrClient,
  HerdrClientError,
  requestHerdrSocket,
  type HerdrSessionInfo,
  type HerdrWireRequest,
} from "../src/standalone/herdr-client";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const session: HerdrSessionInfo = {
  name: "test",
  default: false,
  running: true,
  sessionDir: "/tmp/herdr-test",
  socketPath: "/tmp/herdr-test/herdr.sock",
};

function fakeClient(handler: (request: HerdrWireRequest) => Record<string, unknown>) {
  return new HerdrClient({
    discoverSessions: async () => [session],
    sendRequest: async (_socket, request) => ({ id: request.id, result: handler(request) }),
  });
}

function emptySnapshot() {
  return { type: "session_snapshot", snapshot: { workspaces: [], tabs: [], panes: [], agents: [], layouts: [], version: "0.8.2", protocol: 20 } };
}

test("status reports Herdr not installed without throwing", async () => {
  const client = new HerdrClient({ executable: `/definitely-missing-herdr-${process.pid}` });
  const status = await client.status();
  expect(status.installed).toBe(false);
  expect(status.health).toBe("not_found");
  expect(status.sessions).toEqual([]);
});

test("status treats an unreachable running session as unknown instead of failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-herdr-unavailable-"));
  roots.push(root);
  const client = new HerdrClient({
    discoverSessions: async () => [{ ...session, socketPath: join(root, "missing.sock") }],
  });
  const status = await client.status("test");
  expect(status.health).toBe("unknown");
  expect("selected" in status ? status.selected?.health : null).toBe("unknown");
});

test("socket transport speaks Herdr newline-delimited JSON and validates a live response", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-herdr-socket-"));
  roots.push(root);
  const socketPath = join(root, "herdr.sock");
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as HerdrWireRequest;
      expect(request).toMatchObject({ id: "req-1", method: "ping", params: {} });
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "pong", version: "0.8.2", protocol: 20 } })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const response = await requestHerdrSocket(socketPath, { id: "req-1", method: "ping", params: {} }, 500);
  expect(response).toEqual({ id: "req-1", result: { type: "pong", version: "0.8.2", protocol: 20 } });
});

test("socket transport rejects malformed Herdr responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-herdr-malformed-"));
  roots.push(root);
  const socketPath = join(root, "herdr.sock");
  const server = createServer(socket => socket.end("not-json\n"));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  await expect(requestHerdrSocket(socketPath, { id: "req-2", method: "ping", params: {} }, 500)).rejects.toMatchObject({
    health: "failed",
    code: "malformed_response",
  });
});

test("socket transport reports timeout as unknown and performs no cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-herdr-timeout-"));
  roots.push(root);
  const socketPath = join(root, "herdr.sock");
  const server = createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  await expect(requestHerdrSocket(socketPath, { id: "req-3", method: "ping", params: {} }, 25)).rejects.toMatchObject({
    health: "unknown",
    code: "socket_timeout",
  });
});

test("workspace open reuses the workspace whose pane cwd matches exactly", async () => {
  const client = fakeClient(request => {
    expect(request.method).toBe("session.snapshot");
    return {
      type: "session_snapshot",
      snapshot: {
        workspaces: [
          { workspace_id: "w1", active_tab_id: "w1:t1", label: "one" },
          { workspace_id: "w2", active_tab_id: "w2:t1", label: "two" },
        ],
        tabs: [
          { tab_id: "w1:t1", workspace_id: "w1" },
          { tab_id: "w2:t1", workspace_id: "w2" },
        ],
        panes: [
          { pane_id: "w1:p1", terminal_id: "term1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/repo/a" },
          { pane_id: "w2:p1", terminal_id: "term2", tab_id: "w2:t1", workspace_id: "w2", cwd: "/repo/b" },
        ],
      },
    };
  });
  const opened = await client.openWorkspace("test", "/repo/b");
  expect(opened.created).toBe(false);
  expect(opened.workspace).toMatchObject({ workspace_id: "w2" });
  expect(opened.root_pane).toMatchObject({ pane_id: "w2:p1" });
});

test("workspace open creates without focus when no workspace owns the cwd", async () => {
  const requests: HerdrWireRequest[] = [];
  const client = fakeClient(request => {
    requests.push(request);
    if (request.method === "session.snapshot") return emptySnapshot();
    if (request.method === "workspace.create") return {
      type: "workspace_created",
      workspace: { workspace_id: "w7", label: "worker" },
      tab: { tab_id: "w7:t1", workspace_id: "w7" },
      root_pane: { pane_id: "w7:p1", terminal_id: "term7", workspace_id: "w7", tab_id: "w7:t1" },
    };
    throw new Error(`unexpected ${request.method}`);
  });
  const opened = await client.openWorkspace("test", "/repo/new", "worker");
  expect(opened.created).toBe(true);
  expect(opened.workspace).toMatchObject({ workspace_id: "w7" });
  expect(requests[1]?.params).toMatchObject({ cwd: "/repo/new", label: "worker", focus: false });
});

test("workspace open refuses an ambiguous cwd rather than relying on focus", async () => {
  const client = fakeClient(() => ({
    type: "session_snapshot",
    snapshot: {
      workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
      tabs: [],
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo/shared" },
        { pane_id: "w2:p1", workspace_id: "w2", cwd: "/repo/shared" },
      ],
    },
  }));
  await expect(client.openWorkspace("test", "/repo/shared")).rejects.toMatchObject({ code: "ambiguous_workspace" });
});

test("worktree creation returns the workspace tab pane and worktree identities", async () => {
  const client = fakeClient(request => {
    expect(request.method).toBe("worktree.create");
    expect(request.params).toMatchObject({ cwd: "/repo/main", branch: "feat/a", base: "main", path: "/repo/a", focus: false });
    return {
      type: "worktree_created",
      workspace: { workspace_id: "wA" },
      tab: { tab_id: "wA:t1" },
      root_pane: { pane_id: "wA:p1", terminal_id: "termA" },
      worktree: { path: "/repo/a", branch: "feat/a", open_workspace_id: "wA" },
    };
  });
  const created = await client.createWorktree("test", { sourceCwd: "/repo/main", branch: "feat/a", base: "main", path: "/repo/a" });
  expect(created.workspace).toMatchObject({ workspace_id: "wA" });
  expect(created.root_pane).toMatchObject({ pane_id: "wA:p1", terminal_id: "termA" });
});

test("tab and pane creation target explicit workspace and pane ids", async () => {
  const methods: string[] = [];
  const client = fakeClient(request => {
    methods.push(request.method);
    if (request.method === "tab.create") {
      expect(request.params).toMatchObject({ workspace_id: "wA", cwd: "/repo/a", label: "tests", focus: false });
      return { type: "tab_created", tab: { tab_id: "wA:t2", workspace_id: "wA" }, root_pane: { pane_id: "wA:p2", terminal_id: "term2" } };
    }
    expect(request.params).toMatchObject({ target_pane_id: "wA:p2", direction: "right", cwd: "/repo/a", focus: false });
    return { type: "pane_info", pane: { pane_id: "wA:p3", terminal_id: "term3", workspace_id: "wA", tab_id: "wA:t2" } };
  });
  const tab = await client.createTab("test", { workspaceId: "wA", cwd: "/repo/a", label: "tests" });
  const pane = await client.splitPane("test", { targetPaneId: "wA:p2", direction: "right", cwd: "/repo/a" });
  expect(tab.root_pane).toMatchObject({ pane_id: "wA:p2" });
  expect(pane.pane).toMatchObject({ pane_id: "wA:p3" });
  expect(methods).toEqual(["tab.create", "pane.split"]);
});

test("run sends command plus Enter atomically to the explicit pane", async () => {
  const client = fakeClient(request => {
    expect(request.method).toBe("pane.send_input");
    expect(request.params).toEqual({ pane_id: "wA:p1", text: "sleep 10", keys: ["Enter"] });
    return { type: "ok" };
  });
  expect(await client.runPane("test", "wA:p1", "sleep 10")).toMatchObject({ pane_id: "wA:p1", accepted: true });
});

test("reads keep two panes isolated by their explicit ids", async () => {
  const seen: string[] = [];
  const client = fakeClient(request => {
    const paneId = request.params.pane_id as string;
    seen.push(paneId);
    return { type: "pane_read", read: { pane_id: paneId, workspace_id: "wA", tab_id: "wA:t1", source: "recent", format: "text", text: `out:${paneId}`, revision: 1, truncated: false } };
  });
  const one = await client.readPane("test", { paneId: "wA:p1", source: "recent" });
  const two = await client.readPane("test", { paneId: "wA:p2", source: "recent" });
  expect(one.read).toMatchObject({ pane_id: "wA:p1", text: "out:wA:p1" });
  expect(two.read).toMatchObject({ pane_id: "wA:p2", text: "out:wA:p2" });
  expect(seen).toEqual(["wA:p1", "wA:p2"]);
});

test("wait uses Herdr output waiting rather than GWC polling", async () => {
  const client = fakeClient(request => {
    expect(request.method).toBe("pane.wait_for_output");
    expect(request.params).toMatchObject({
      pane_id: "wA:p1",
      source: "recent",
      match: { type: "substring", value: "READY" },
      timeout_ms: 750,
    });
    return { type: "output_matched", pane_id: "wA:p1", revision: 8, matched_line: "READY", read: { text: "READY" } };
  });
  const waited = await client.waitPane("test", { paneId: "wA:p1", source: "recent", matchType: "substring", match: "READY", timeoutMs: 750 });
  expect(waited).toMatchObject({ pane_id: "wA:p1", revision: 8, matched_line: "READY" });
});

test("pane status reports not-found explicitly for invalid ids", async () => {
  const client = new HerdrClient({
    discoverSessions: async () => [session],
    sendRequest: async (_socket, request) => ({ id: request.id, error: { code: "pane_not_found", message: "missing pane" } }),
  });
  const status = await client.paneStatus("test", "wZ:p99");
  expect(status.health).toBe("not_found");
  expect(status.process_error).toMatchObject({ code: "pane_not_found" });
});

test("a pane with no foreground child remains healthy instead of being declared dead", async () => {
  const client = fakeClient(request => request.method === "pane.get"
    ? { type: "pane_info", pane: { pane_id: "wA:p1", agent_status: "done", revision: 4 } }
    : { type: "pane_process_info", process_info: { pane_id: "wA:p1", shell_pid: 10, foreground_processes: [] } });
  const status = await client.paneStatus("test", "wA:p1");
  expect(status.health).toBe("healthy");
  expect(status.agent_state).toBe("done");
  expect(status.process_info).toMatchObject({ shell_pid: 10, foreground_processes: [] });
});

test("transient probe failures remain unknown and never trigger destructive calls", async () => {
  const methods: string[] = [];
  const client = new HerdrClient({
    discoverSessions: async () => [session],
    sendRequest: async (_socket, request) => {
      methods.push(request.method);
      throw new HerdrClientError("temporary timeout", "unknown", "socket_timeout");
    },
  });
  const status = await client.paneStatus("test", "wA:p1");
  expect(status.health).toBe("unknown");
  expect(methods).toEqual(["pane.get"]);
  expect(methods.some(method => /close|remove|stop|kill/.test(method))).toBe(false);
});

test("a fresh GWC-side client can resume the same Herdr pane without local ownership state", async () => {
  const send = async (_socket: string, request: HerdrWireRequest) => ({
    id: request.id,
    result: { type: "pane_read", read: { pane_id: request.params.pane_id, text: "persistent", revision: 9 } },
  });
  const options = { discoverSessions: async () => [session], sendRequest: send };
  const beforeRestart = new HerdrClient(options);
  const afterRestart = new HerdrClient(options);
  expect((await beforeRestart.readPane("test", { paneId: "wA:p1", source: "recent" })).read).toMatchObject({ text: "persistent" });
  expect((await afterRestart.readPane("test", { paneId: "wA:p1", source: "recent" })).read).toMatchObject({ text: "persistent" });
});

test("Herdr bridge neither requires nor fabricates HERDR_ENV context", () => {
  const source = readFileSync(join(import.meta.dir, "../src/standalone/herdr-client.ts"), "utf8");
  expect(source).not.toContain("HERDR_ENV");
  expect(source).not.toContain("HERDR_WORKSPACE_ID");
  expect(source).not.toContain("HERDR_PANE_ID");
});
