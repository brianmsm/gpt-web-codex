import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildWindowsPowerShellArgs, windowsPowerShellSpawnEnv,
} from "../src/standalone/direct-tools";

test("PowerShell command round-trips comments, quotes and multiline Unicode safely", () => {
  const userCommand = [
    'Write-Output "quoted \\"hello\\"" # GWC_TRACE_TAG=proof',
    "Write-Output 'mañana 🌙'",
    'if ($true) { Write-Output "nested brace" }',
  ].join("\n");
  const args = buildWindowsPowerShellArgs(userCommand);
  expect(args.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-Command"]);
  expect(args).toHaveLength(4);
  const script = args[3]!;
  expect(script).toContain(`& {
${userCommand}
}`);
  expect(script).toContain("Write-Output 'mañana 🌙'");
  expect(script).toContain("if ($null -ne $__gptWebCodexExitCode) { exit $__gptWebCodexExitCode }");
  expect(script).toContain("if (-not $__gptWebCodexSuccess) { exit 1 }");
  expect(script).toContain("GWC_TRACE_TAG=proof\nWrite-Output");
  expect(script).not.toContain("; }");
});

test("PowerShell command handles trailing comment without eating the scriptblock", () => {
  const code = "Write-Output 'EXECUTED' # trailing-comment";
  const argv = buildWindowsPowerShellArgs(code);
  const decoded = argv.at(-1)!;
  expect(decoded).toContain("# trailing-comment\n}");
  expect(decoded).toMatch(/\}\s*;\s*\$__gptWebCodexSuccess = \$\?/);
  expect(decoded).not.toContain("# trailing-comment }");
});

test("Windows PowerShell reconstructs standard module paths without broad env inheritance", () => {
  const restrictedEnv: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "D:\\Windows",
    ProgramFiles: "D:\\Program Files",
    USERPROFILE: "D:\\Users\\synthetic",
  };
  const env = windowsPowerShellSpawnEnv(restrictedEnv, "win32");
  expect(env.PSModulePath).toBe([
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    "D:\\Users\\synthetic\\Documents\\WindowsPowerShell\\Modules",
    "D:\\Program Files\\WindowsPowerShell\\Modules",
  ].join(";"));
  expect(env.PATH).toBe(restrictedEnv.PATH);
  expect(env.PSModulePath).not.toBeUndefined();
  expect(restrictedEnv.PSModulePath).toBeUndefined();
  expect(Object.keys(env).sort()).toEqual([...Object.keys(restrictedEnv), "PSModulePath"].sort());
});

test("PowerShell module path fallback preserves explicit values and skips non-Windows", () => {
  const explicit: NodeJS.ProcessEnv = { PSModulePath: "C:\\custom\\psmodules", PATH: "synthetic" };
  expect(windowsPowerShellSpawnEnv(explicit, "win32")).toBe(explicit);
  expect(windowsPowerShellSpawnEnv({ PATH: "synthetic" }, "linux")).toEqual({ PATH: "synthetic" });
});


test.skipIf(process.platform !== "win32")("limited PowerShell environment cannot load incompatible PowerShell 7 built-ins", () => {
  const root = mkdtempSync(join(tmpdir(), "gwc-powershell-modules-"));
  try {
    const programFiles = join(root, "Program Files");
    // Model a side-by-side PS7 installation without touching installed modules.
    // If the fallback injects PS7 before PS5, this sentinel is selected.
    for (const name of ["Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Management"]) {
      const moduleDir = join(programFiles, "PowerShell", "7", "Modules", name);
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(join(moduleDir, name + ".psd1"),
        "@{ RootModule='" + name + ".psm1'; ModuleVersion='7.0.0'; " +
        "GUID='a5b3001b-731b-464c-b2a2-2f1976770636'; CompatiblePSEditions=@('Core') }");
      writeFileSync(join(moduleDir, name + ".psm1"),
        "throw 'GWC_INCOMPATIBLE_CORE_MODULE_LOADED'");
    }
    const env = windowsPowerShellSpawnEnv({
      ...getDefaultEnvironment(), PROGRAMFILES: programFiles,
    }, "win32");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Import-Module Microsoft.PowerShell.Utility -Force -ErrorAction Stop",
      "Import-Module Microsoft.PowerShell.Management -Force -ErrorAction Stop",
      "foreach ($name in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management')) { " +
        "$m = Get-Module $name; " +
        "if (-not $m.Path.StartsWith($PSHOME + '\\Modules\\', [StringComparison]::OrdinalIgnoreCase)) { " +
        "throw 'GWC_WRONG_BUILTIN_MODULE_ORIGIN' } }",
      "$null = Get-Date",
      "$null = Get-Item -LiteralPath $PSHOME",
      "[Console]::WriteLine('GWC_BUILTIN_MODULES_OK')",
    ].join("; ");
    const result = spawnSync("powershell.exe", buildWindowsPowerShellArgs(script), {
      env, encoding: "utf8", windowsHide: true, input: "",
      timeout: 8_000, maxBuffer: 64 * 1024,
    });
    if (result.status !== 0) {
      console.error("GWC_MODULE_REGRESSION=" + JSON.stringify({
        status: result.status,
        error: result.error?.message,
        incompatible: result.stderr?.includes("GWC_INCOMPATIBLE_CORE_MODULE_LOADED"),
        wrongOrigin: result.stderr?.includes("GWC_WRONG_BUILTIN_MODULE_ORIGIN"),
      }));
    }
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GWC_BUILTIN_MODULES_OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
