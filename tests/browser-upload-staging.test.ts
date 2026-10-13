import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DirectToolService } from "../src/standalone/direct-tools";

const roots: string[] = [];
const stagedDirs: string[] = [];

afterEach(() => {
  for (const path of stagedDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gwc-browser-upload-test-"));
  roots.push(root);
  const path = join(root, "workspace");
  mkdirSync(path);
  return path;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

test("browser upload staging copies a scoped file into private OS temp storage", () => {
  const root = workspace();
  const source = join(root, "cv.pdf");
  const bytes = Buffer.from("browser upload fixture\n", "utf8");
  writeFileSync(source, bytes);

  const staged = new DirectToolService().stageBrowserUpload("cv.pdf", root, "workspace-write");
  stagedDirs.push(dirname(staged.staged_path));

  expect(staged.source_path).toBe(source);
  expect(staged.bytes).toBe(bytes.length);
  expect(staged.staging_ttl_ms).toBe(24 * 60 * 60 * 1_000);
  expect(isWithin(staged.staged_path, tmpdir())).toBe(true);
  expect(dirname(staged.staged_path).split(sep).at(-1)).toStartWith("gpt-web-codex-browser-upload-");
  expect(readFileSync(staged.staged_path)).toEqual(bytes);

  if (process.platform !== "win32") {
    expect(statSync(dirname(staged.staged_path)).mode & 0o777).toBe(0o700);
    expect(statSync(staged.staged_path).mode & 0o777).toBe(0o600);
  }
});

test("browser upload staging respects sandbox scope and size limits", () => {
  const root = workspace();
  const source = join(root, "payload.bin");
  writeFileSync(source, "12345", "utf8");
  const tools = new DirectToolService();

  expect(() => tools.stageBrowserUpload("payload.bin", root, "read-only"))
    .toThrow("Browser upload staging is disabled in read-only mode");
  expect(() => tools.stageBrowserUpload("../outside.bin", root, "workspace-write"))
    .toThrow("Path is outside the disclosed workspace");
  expect(() => tools.stageBrowserUpload("payload.bin", root, "workspace-write", 4))
    .toThrow("exceeds the 4-byte staging limit");
});

test("browser upload staging rejects directories instead of copying recursively", () => {
  const root = workspace();
  mkdirSync(join(root, "folder"));
  expect(() => new DirectToolService().stageBrowserUpload("folder", root, "workspace-write"))
    .toThrow("Browser upload source is not a regular file");
});
