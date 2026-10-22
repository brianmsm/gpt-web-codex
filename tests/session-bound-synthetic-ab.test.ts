import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These three live-process fixtures launch executable Python scripts using
// Unix shebangs, execve and chmod/fchmod checks. They are not a Windows MCP
// deployment target. A platform-neutral RoleSessionGuard integration test
// below still asserts the same cross-role deny-by-default contract on Windows.
const posixFixtureTest = process.platform === "win32" ? test.skip : test;

const root = join(import.meta.dir, "..");
const prepareScript = join(root, "scripts", "diagnostics", "prepare-synthetic-ab-connectors.py");
const enrollmentScript = join(root, "scripts", "diagnostics", "bind-synthetic-rater-session.py");
const names = [
  "study_identity", "get_case_plan", "list_materials", "read_material",
  "current_drafts", "save_artifact", "seal_submission",
].sort();
const sessionA = "ChatGPT intended conversation A (synthetic)";
const sessionB = "ChatGPT intended conversation B (synthetic)";

function createLab() {
  const folder = mkdtempSync(join(tmpdir(), "gwc-bound-stdio-fixture-"));
  const lab = join(folder, "lab");
  const launched = Bun.spawnSync({
    cmd: ["python3", "-B", prepareScript, "--lab-dir", lab, "--bun", process.execPath],
    stdout: "pipe", stderr: "pipe",
  });
  if (launched.exitCode !== 0) {
    throw new Error("Synthetic fixture preparation failed (" + launched.exitCode
      + "): " + launched.stderr.toString().slice(0, 500));
  }
  return { folder, lab };
}

function bind(lab: string, role: "A" | "B", fingerprint?: string, ...opts: string[]) {
  return Bun.spawnSync({
    cmd: ["python3", "-B", enrollmentScript, "--lab-dir", lab, "--role", role,
      ...(fingerprint ? ["--fingerprint", fingerprint] : []), ...opts],
    stdout: "pipe", stderr: "pipe",
  });
}

function meta(raw: string) {
  return { "openai/session": raw };
}

async function connect(lab: string, role: "A" | "B") {
  const transport = new StdioClientTransport({
    command: join(lab, role, "run-mcp-locked.py"),
    env: getDefaultEnvironment(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "synthetic-sticky-session-auth-test", version: "1.0.0" });
  await client.connect(transport, { timeout: 7000, maxTotalTimeout: 7000 });
  return client;
}

async function call(client: Client, tool: string, raw?: string, args: Record<string, unknown> = {}) {
  return client.callTool({
    name: tool, arguments: args,
    ...(raw === undefined ? {} : { _meta: meta(raw) }),
  });
}

function candidate(response: Awaited<ReturnType<typeof call>>, role: "A" | "B") {
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({
    authorization: "denied",
    reason: "enrollment_required",
  });
  expect(JSON.stringify(response)).not.toContain("pid");
  const fingerprint = (response.structuredContent as { session_fingerprint: string }).session_fingerprint;
  expect(fingerprint).toMatch(new RegExp("^rater-session:" + role + ":[a-f0-9]{64}$"));
  return fingerprint;
}

posixFixtureTest("two session-locked MCPs deny all data before enrollment, survive enrollment and block real cross-session calls", async () => {
  const { folder, lab } = createLab();
  const opened: Client[] = [];
  try {
    const a = await connect(lab, "A"); opened.push(a);
    const b = await connect(lab, "B"); opened.push(b);
    expect((await a.listTools()).tools.map(t => t.name).sort()).toEqual(names);
    expect((await b.listTools()).tools.map(t => t.name).sort()).toEqual(names);
    for (const client of [a, b]) {
      const missing = await call(client, "study_identity");
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({
        reason: "missing_identity", authorization: "denied",
      });
      const deniedRead = await call(client, "read_material", sessionA, { name: "AGENTS.md" });
      expect(deniedRead.isError).toBe(true);
      expect(deniedRead.structuredContent).toMatchObject({ reason: "forbidden" });
      expect(JSON.stringify(deniedRead)).not.toContain("AGENTS.md");
    }

    const tokenA = candidate(await call(a, "study_identity", sessionA), "A");
    const tokenB = candidate(await call(b, "study_identity", sessionB), "B");
    expect(tokenA).not.toBe(tokenB);
    // Role-binding from a wrong app is invalid even when a malicious chat
    // copies the other app's enrollment fingerprint into the admin workflow.
    const wrongRole = bind(lab, "B", tokenA);
    expect(wrongRole.exitCode).toBe(2);
    expect(wrongRole.stderr.toString()).toContain("does not belong");
    expect(bind(lab, "A", tokenA).exitCode).toBe(0);
    expect(bind(lab, "B", tokenB).exitCode).toBe(0);
    expect(bind(lab, "A").stdout.toString()).toContain("bound=true");
    expect(bind(lab, "B").stdout.toString()).toContain("bound=true");

    // The same already-running process immediately sees the new protected
    // binding file; it does not need a restart to enforce exact calls.
    const authorizedA = await call(a, "study_identity", sessionA);
    const authorizedB = await call(b, "study_identity", sessionB);
    expect(authorizedA.isError).not.toBe(true);
    expect(authorizedB.isError).not.toBe(true);
    expect(authorizedA.structuredContent).toMatchObject({ role: "A" });
    expect(authorizedB.structuredContent).toMatchObject({ role: "B" });
    expect((authorizedA.structuredContent as { pid: number }).pid)
      .not.toBe((authorizedB.structuredContent as { pid: number }).pid);

    // Adversarial app switching from chat A -> B, and chat B -> A.
    for (const [client, wrongSession] of [[a, sessionB], [b, sessionA]] as const) {
      for (const name of ["study_identity", "read_material", "save_artifact",
        "current_drafts", "seal_submission", "get_case_plan", "list_materials"]) {
        const result = await call(client, name, wrongSession, {
          ...(name === "read_material" ? { name: "AGENTS.md" } : {}),
          ...(name === "get_case_plan" ? { case_id: "SYNTH-01" } : {}),
          ...(name === "save_artifact" ? { value: "BAD CROSS-ROLE" } : {}),
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ reason: "forbidden" });
        expect(JSON.stringify(result)).not.toContain("pid");
      }
    }
    // A model-controlled argument may not select another conversation.
    expect((await call(a, "read_material", sessionB, {
      name: "AGENTS.md", web_session_id: sessionA,
    })).isError).toBe(true);
    expect((await call(b, "read_material", sessionA, {
      name: "AGENTS.md", web_session_id: sessionB,
    })).isError).toBe(true);
    expect((await call(a, "read_material", sessionA, { name: "AGENTS.md" })).isError).not.toBe(true);
    expect((await call(b, "read_material", sessionB, { name: "AGENTS.md" })).isError).not.toBe(true);

    // Benign writes prove independent authorized output directories while
    // cross-role writes are rejected before touching the filesystem.
    expect((await call(a, "save_artifact", sessionA, { value: "AUTHORIZED A ONLY" })).isError).not.toBe(true);
    expect((await call(b, "save_artifact", sessionB, { value: "AUTHORIZED B ONLY" })).isError).not.toBe(true);
    expect(readFileSync(join(lab, "A", "output", "assessment.txt"), "utf8")).toBe("AUTHORIZED A ONLY");
    expect(readFileSync(join(lab, "B", "output", "assessment.txt"), "utf8")).toBe("AUTHORIZED B ONLY");
    expect((await call(a, "save_artifact", sessionB, { value: "B REPLACES A" })).isError).toBe(true);
    expect((await call(b, "save_artifact", sessionA, { value: "A REPLACES B" })).isError).toBe(true);
    expect(readFileSync(join(lab, "A", "output", "assessment.txt"), "utf8")).toBe("AUTHORIZED A ONLY");
    expect(readFileSync(join(lab, "B", "output", "assessment.txt"), "utf8")).toBe("AUTHORIZED B ONLY");
    await expect(a.listResources()).rejects.toThrow();

    // The same test harness may forge raw openai/session on its MCP call,
    // establishing that this is NOT cryptographic upstream authentication.
    const spoofed = await call(a, "study_identity", sessionA);
    expect(spoofed.isError).not.toBe(true);
    // This fact is explicitly documented; do not report an authentication
    // guarantee from the local HMAC-derived enrollment fingerprint.
  } finally {
    await Promise.all(opened.map(client => client.close()));
    rmSync(folder, { recursive: true, force: true });
  }
});

posixFixtureTest("supervisor enrollment is immutable without replace and protected-file tampering fails closed", async () => {
  const { folder, lab } = createLab();
  let client: Client | undefined;
  try {
    client = await connect(lab, "A");
    const token = candidate(await call(client, "study_identity", sessionA), "A");
    const second = candidate(await call(client, "study_identity", sessionB), "A");
    expect(bind(lab, "A", token).exitCode).toBe(0);
    expect(bind(lab, "A", second).exitCode).toBe(2);
    expect((await call(client, "study_identity", sessionA)).isError).not.toBe(true);

    const binding = join(lab, "A", "authorized-session.txt");
    const original = readFileSync(binding, "utf8");
    chmodSync(binding, 0o644);
    const insecure = await call(client, "study_identity", sessionA);
    expect(insecure.isError).toBe(true);
    expect(insecure.structuredContent).toMatchObject({ reason: "invalid_binding" });
    chmodSync(binding, 0o600);
    expect((await call(client, "study_identity", sessionA)).isError).not.toBe(true);
    expect(readFileSync(binding, "utf8")).toBe(original);

    // Replace only via explicit local supervisor action, not a tool call.
    expect(bind(lab, "A", second, "--replace").exitCode).toBe(0);
    expect((await call(client, "study_identity", sessionA)).isError).toBe(true);
    expect((await call(client, "study_identity", sessionB)).isError).not.toBe(true);
    expect(bind(lab, "A", undefined, "--clear").exitCode).toBe(2);
    expect(bind(lab, "A", undefined, "--clear", "--replace").exitCode).toBe(0);
    const pending = await call(client, "study_identity", sessionA);
    expect(pending.isError).toBe(true);
    expect(pending.structuredContent).toMatchObject({ reason: "enrollment_required" });

    // A symlink may never replace a binding: no permissive fallback.
    rmSync(binding);
    const foreign = join(lab, "A", "other.txt");
    writeFileSync(foreign, token + "\n", { mode: 0o600 });
    symlinkSync(foreign, binding);
    const bad = await call(client, "study_identity", sessionA);
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ reason: "invalid_binding" });
  } finally {
    await client?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

posixFixtureTest("role session enrollment and keyed identity remain valid across MCP process restart", async () => {
  const { folder, lab } = createLab();
  let client: Client | undefined;
  try {
    client = await connect(lab, "A");
    const roleToken = candidate(await call(client, "study_identity", sessionA), "A");
    expect(bind(lab, "A", roleToken).exitCode).toBe(0);
    const first = await call(client, "study_identity", sessionA);
    expect(first.isError).not.toBe(true);
    const firstPid = (first.structuredContent as { pid: number }).pid;
    await client.close();
    client = undefined;

    client = await connect(lab, "A");
    const second = await call(client, "study_identity", sessionA);
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({ role: "A" });
    expect((second.structuredContent as { pid: number }).pid).not.toBe(firstPid);
    const prohibited = await call(client, "study_identity", sessionB);
    expect(prohibited.isError).toBe(true);
    expect(prohibited.structuredContent).toMatchObject({ reason: "forbidden" });
    const binding = readFileSync(join(lab, "A", "authorized-session.txt"), "utf8").trim();
    expect(binding).toBe(roleToken);
  } finally {
    await client?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
