/**
 * Synthetic Windows child-process startup probe, with a hard bound on time.
 * Uses no MCP, credentials, network requests or real user data.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SELF = fileURLToPath(import.meta.url);
const CASES = [
  "node-control", "cmd-control", "powershell-short",
  "powershell-command", "powershell-noninteractive",
  "powershell-encoded", "pwsh-short", "gwc-wrapper-short",
  "gwc-wrapper-interactive", "gwc-wrapper-temp-cwd",
];
const script = [
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [Console]::OutputEncoding",
  "& {",
  "Write-Output 'GWC_PROBE_READY'",
  "$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput())",
  "$line = $reader.ReadLine()",
  "Write-Output ('GWC_PROBE_INPUT:' + $line)",
  "}",
].join("\n");

async function childArgs(key) {
  if (key.startsWith("gwc-wrapper-")) {
    // Use the real reviewed GWC argument builder, never a rewritten copy.
    const { buildWindowsPowerShellArgs } =
      await import("../../src/standalone/direct-tools.ts");
    const interactive = key !== "gwc-wrapper-short";
    const userScript = interactive
      ? "Write-Output 'GWC_PROBE_READY'; " +
        "$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput()); " +
        "$line = $reader.ReadLine(); Write-Output ('GWC_PROBE_INPUT:' + $line)"
      : "Write-Output 'GWC_PROBE_READY'";
    const cwd = key === "gwc-wrapper-temp-cwd"
      ? mkdtempSync(join(tmpdir(), "gwc-node-terminal-mcp-")) : undefined;
    return ["powershell.exe", buildWindowsPowerShellArgs(userScript),
      interactive ? "owner\n" : "", cwd];
  }
  if (key === "node-control") {
    return ["node", ["-e", "process.stdout.write('GWC_PROBE_READY')"], ""];
  }
  if (key === "cmd-control") {
    return ["cmd.exe", ["/D", "/C", "echo GWC_PROBE_READY"], ""];
  }
  if (key === "powershell-short") {
    return ["powershell.exe",
      ["-NoLogo", "-NoProfile", "-Command", "Write-Output 'GWC_PROBE_READY'"], ""];
  }
  if (key === "powershell-command") {
    return ["powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], "owner\n"];
  }
  if (key === "powershell-noninteractive") {
    return ["powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], "owner\n"];
  }
  if (key === "powershell-encoded") {
    return ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], "owner\n"];
  }
  if (key === "pwsh-short") {
    return ["pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Write-Output 'GWC_PROBE_READY'"], ""];
  }
  throw Error("Unknown static case");
}

async function observe(name, command, args, input, timeoutMs = 6500, cwd) {
  let child;
  const started = Date.now();
  let stdout = "";
  let stderrBytes = 0;
  let timeout = false;
  let errorCode = "";
  try {
    child = spawn(command, args, {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd,
    });
  } catch (error) {
    return { name, elapsed_ms: Date.now() - started,
      spawn_error: error?.code || error?.name || "unknown" };
  }
  const completed = new Promise(resolve => {
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8").slice(0, 3000); });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    child.on("error", error => { errorCode = error.code || "unknown"; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(input, "utf8");
  const timer = setTimeout(() => {
    timeout = true;
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 1500 });
    } else child.kill();
  }, timeoutMs);
  const finished = await completed;
  clearTimeout(timer);
  let nested = null;
  const matched = stdout.match(/GWC_NESTED_PROBE=(\{[^\r\n]+\})/);
  if (matched) {
    try { nested = JSON.parse(matched[1]); } catch { /* malformed nested report */ }
  }
  return {
    name, elapsed_ms: Date.now() - started, timeout, exit: finished.code,
    signal: finished.signal, spawn_error: errorCode || null,
    stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: stderrBytes,
    ready: stdout.includes("GWC_PROBE_READY"),
    input_echo: stdout.includes("GWC_PROBE_INPUT:owner"),
    ...(nested ? { nested } : {}),
  };
}

if (process.platform !== "win32") {
  console.log("GWC_NESTED_PROCESS_PROBE_NOT_WINDOWS");
} else if (process.argv[2] === "inner") {
  const key = process.argv[3];
  if (!CASES.includes(key)) throw Error("Case is not on the static allowlist");
  const [cmd, args, input, cwd] = await childArgs(key);
  try {
    const result = await observe(key, cmd, args, input, 6500, cwd);
    console.log("GWC_NESTED_PROBE=" + JSON.stringify(result));
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
} else {
  const bunExe = process.argv[2];
  if (!bunExe) throw Error("Need the Bun executable path");
  for (const key of CASES) {
    const r = await observe(key, bunExe, [SELF, "inner", key], "", 8500);
    // The parent sees a successful Bun child only if the inner test completed;
    // keep the child's bounded diagnostic output without exposing commands.
    console.log("GWC_NESTED_PARENT=" + JSON.stringify(r));
  }
}
