import { expect, test } from "bun:test";
import { buildWindowsPowerShellArgs } from "../src/standalone/direct-tools";

test("PowerShell encoded command round-trips comments, quotes and multiline Unicode safely", () => {
  const userCommand = [
    'Write-Output "quoted \\"hello\\"" # GWC_TRACE_TAG=proof',
    "Write-Output 'mañana 🌙'",
    'if ($true) { Write-Output "nested brace" }',
  ].join("\n");
  const args = buildWindowsPowerShellArgs(userCommand);
  expect(args.slice(0, 4)).toEqual([
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  ]);
  expect(args).toHaveLength(5);
  const script = Buffer.from(args[4]!, "base64").toString("utf16le");
  expect(script).toContain(`& {
${userCommand}
}`);
  expect(script).toContain("Write-Output 'mañana 🌙'");
  expect(script).toContain("if ($null -ne $__gptWebCodexExitCode) { exit $__gptWebCodexExitCode }");
  expect(script).toContain("if (-not $__gptWebCodexSuccess) { exit 1 }");
  expect(script).toContain("GWC_TRACE_TAG=proof\nWrite-Output");
  expect(script).not.toContain("; }");
});

test("PowerShell encoded command handles trailing comment without eating the scriptblock", () => {
  const code = "Write-Output 'EXECUTED' # trailing-comment";
  const argv = buildWindowsPowerShellArgs(code);
  const decoded = Buffer.from(argv.at(-1)!, "base64").toString("utf16le");
  expect(decoded).toContain("# trailing-comment\n}");
  expect(decoded).toMatch(/\}\s*;\s*\$__gptWebCodexSuccess = \$\?/);
  expect(decoded).not.toContain("# trailing-comment }");
});
