import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import type { LunaSandbox } from "./types";
import { terminateOwnedProcessTree } from "./process-tree";

const MAX_DIRECT_IMAGE_BYTES = 20_000_000;
const MAX_SOURCE_IMAGE_BYTES = 50_000_000;
const MODEL_IMAGE_MAX_DIMENSION = 1_600;

export interface DirectTextFileRead {
  path: string;
  text: string;
  truncated: boolean;
}

export interface DirectImageFileRead {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  bytes: number;
  optimized?: boolean;
  sourceBytes?: number;
  sourceMimeType?: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
}

function imageMimeType(bytes: Buffer): DirectImageFileRead["mimeType"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

interface TerminalJob {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "cancelled";
  pid?: number;
  exitCode?: number | null;
  output: string;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  startedAt: string;
  finishedAt?: string;
  child?: ChildProcessWithoutNullStreams;
}

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveScopedPath(path: string, workspace: string, mode: LunaSandbox): string {
  const target = resolve(workspace, path);
  if (mode !== "danger-full-access" && !within(target, workspace)) {
    throw new Error(`Path is outside the disclosed workspace: ${target}`);
  }
  return target;
}

function assertWritableMode(mode: LunaSandbox, operation: string): void {
  if (mode === "read-only") throw new Error(`${operation} is disabled in read-only mode`);
}

function assertExistingAncestorWithinWorkspace(target: string, workspace: string, mode: LunaSandbox): void {
  if (mode === "danger-full-access") return;
  const workspaceRoot = realpathSync(resolve(workspace));
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const resolvedAncestor = realpathSync(ancestor);
  if (!within(resolvedAncestor, workspaceRoot)) {
    throw new Error(`Path resolves outside the disclosed workspace through a link: ${target}`);
  }
}


interface PreparedTextMutation {
  path: string;
  original: Buffer;
  updated: Buffer;
}

interface UnifiedDiffLine {
  kind: "context" | "remove" | "add";
  text: string;
  noNewline: boolean;
}

interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffLine[];
}

interface UnifiedDiffFile {
  path: string;
  hunks: UnifiedDiffHunk[];
}

interface TextLine {
  text: string;
  newline: boolean;
}

export interface DirectFileEditResult {
  path: string;
  replacements: number;
  changed: boolean;
  bytes_before: number;
  bytes_after: number;
}

export interface DirectFilePatchResult {
  files_applied: number;
  hunks_applied: number;
  files: Array<{
    path: string;
    hunks: number;
    changed: boolean;
    bytes_before: number;
    bytes_after: number;
  }>;
}

function resolveExistingMutationTarget(path: string, workspace: string, mode: LunaSandbox): string {
  const scoped = resolveScopedPath(path, workspace, mode);
  let target: string;
  try {
    target = realpathSync(scoped);
  } catch (error) {
    throw new Error(`Text file does not exist or cannot be resolved: ${scoped}`, { cause: error });
  }
  if (mode !== "danger-full-access") {
    const workspaceRoot = realpathSync(resolve(workspace));
    if (!within(target, workspaceRoot)) {
      throw new Error(`Path resolves outside the disclosed workspace through a link: ${scoped}`);
    }
  }
  if (!statSync(target).isFile()) throw new Error(`Path is not a file: ${target}`);
  return target;
}

function decodeTextFile(bytes: Buffer, path: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
    throw new Error(`File is not UTF-8 text: ${path}`);
  }
  return text;
}

function readMutationTarget(path: string, workspace: string, mode: LunaSandbox): {
  path: string;
  bytes: Buffer;
  text: string;
} {
  const target = resolveExistingMutationTarget(path, workspace, mode);
  const bytes = readFileSync(target);
  return { path: target, bytes, text: decodeTextFile(bytes, target) };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function stagedMutationPath(path: string, label: string): string {
  return resolve(dirname(path), `.${basename(path)}.gwc-${label}-${randomUUID()}.tmp`);
}

function commitTextMutations(plans: PreparedTextMutation[], operation: string): void {
  const changed = plans.filter(plan => !plan.original.equals(plan.updated));
  if (changed.length === 0) return;

  for (const plan of changed) {
    const current = readFileSync(plan.path);
    if (!current.equals(plan.original)) {
      throw new Error(`${operation} aborted because the file changed during validation: ${plan.path}`);
    }
  }

  const staged = changed.map(plan => ({
    ...plan,
    updatedTemp: stagedMutationPath(plan.path, "updated"),
    rollbackTemp: stagedMutationPath(plan.path, "rollback"),
    mode: statSync(plan.path).mode & 0o777,
  }));
  const cleanup = () => {
    for (const plan of staged) {
      try { rmSync(plan.updatedTemp, { force: true }); } catch {}
      try { rmSync(plan.rollbackTemp, { force: true }); } catch {}
    }
  };

  try {
    for (const plan of staged) {
      writeFileSync(plan.updatedTemp, plan.updated, { flag: "wx", mode: plan.mode });
      writeFileSync(plan.rollbackTemp, plan.original, { flag: "wx", mode: plan.mode });
      chmodSync(plan.updatedTemp, plan.mode);
      chmodSync(plan.rollbackTemp, plan.mode);
    }
    for (const plan of staged) {
      const current = readFileSync(plan.path);
      if (!current.equals(plan.original)) {
        throw new Error(`${operation} aborted because the file changed during staging: ${plan.path}`);
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  const touched: typeof staged = [];
  try {
    for (const plan of staged) {
      const current = readFileSync(plan.path);
      if (!current.equals(plan.original)) {
        throw new Error(`${operation} aborted because the file changed before commit: ${plan.path}`);
      }
      renameSync(plan.updatedTemp, plan.path);
      touched.push(plan);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const plan of touched.reverse()) {
      try {
        const current = readFileSync(plan.path);
        if (!current.equals(plan.updated)) {
          rollbackErrors.push(`${plan.path}: file changed after commit; refusing to overwrite concurrent changes`);
          continue;
        }
        renameSync(plan.rollbackTemp, plan.path);
      } catch (rollbackError) {
        rollbackErrors.push(`${plan.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${operation} failed and rollback was incomplete: ${rollbackErrors.join("; ")}`, { cause: error });
    }
    cleanup();
    throw error;
  }

  cleanup();
}

function stripPatchSyntaxCarriage(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function patchHeaderPath(header: string, label: string): string {
  const withoutTimestamp = header.split("\t", 1)[0] ?? "";
  if (!withoutTimestamp) throw new Error(`Malformed unified diff: missing ${label} path`);
  if (withoutTimestamp === "/dev/null") {
    throw new Error("Unified diff file creation and deletion are not supported");
  }
  if (withoutTimestamp.startsWith('"')) {
    throw new Error(`Quoted unified diff paths are not supported: ${withoutTimestamp}`);
  }
  if (withoutTimestamp.includes("\0")) throw new Error(`Malformed unified diff ${label} path`);
  return withoutTimestamp;
}

function unifiedDiffPath(oldPath: string, newPath: string): string {
  if (oldPath.startsWith("a/") && newPath.startsWith("b/") && oldPath.slice(2) === newPath.slice(2)) {
    return oldPath.slice(2);
  }
  if (oldPath === newPath) return oldPath;
  throw new Error(`Unified diff rename is not supported: ${oldPath} -> ${newPath}`);
}

function parseUnifiedDiff(patch: string): UnifiedDiffFile[] {
  if (!patch) throw new Error("Unified diff patch is empty");
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: UnifiedDiffFile[] = [];
  let index = 0;

  const isSupportedMetadata = (line: string) => ["diff --git ", "index "].some(prefix => line.startsWith(prefix));
  const unsupportedMetadata = [
    "old mode ", "new mode ", "similarity index ", "rename from ", "rename to ",
    "new file mode ", "deleted file mode ",
  ];
  const rejectUnsupportedMetadata = (line: string): void => {
    const prefix = unsupportedMetadata.find(candidate => line.startsWith(candidate));
    if (prefix) throw new Error(`Unified diff metadata is not supported: ${prefix.trim()}`);
  };

  while (index < lines.length) {
    const syntax = stripPatchSyntaxCarriage(lines[index]!);
    rejectUnsupportedMetadata(syntax);
    if (isSupportedMetadata(syntax)) {
      index += 1;
      continue;
    }
    if (!syntax.startsWith("--- ")) {
      throw new Error(`Malformed unified diff at line ${index + 1}: expected '---' file header`);
    }
    const oldPath = patchHeaderPath(syntax.slice(4), "old");
    index += 1;
    if (index >= lines.length) throw new Error("Malformed unified diff: missing '+++' file header");
    const newHeader = stripPatchSyntaxCarriage(lines[index]!);
    if (!newHeader.startsWith("+++ ")) {
      throw new Error(`Malformed unified diff at line ${index + 1}: expected '+++' file header`);
    }
    const newPath = patchHeaderPath(newHeader.slice(4), "new");
    const path = unifiedDiffPath(oldPath, newPath);
    index += 1;

    const file: UnifiedDiffFile = { path, hunks: [] };
    while (index < lines.length) {
      const hunkHeader = stripPatchSyntaxCarriage(lines[index]!);
      rejectUnsupportedMetadata(hunkHeader);
      if (hunkHeader.startsWith("--- ") || isSupportedMetadata(hunkHeader)) break;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(hunkHeader);
      if (!match) {
        throw new Error(`Malformed unified diff at line ${index + 1}: expected hunk header`);
      }
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      index += 1;

      const hunkLines: UnifiedDiffLine[] = [];
      let oldSeen = 0;
      let newSeen = 0;
      while (oldSeen < oldCount || newSeen < newCount) {
        if (index >= lines.length) throw new Error("Malformed unified diff: hunk ended before its declared line counts");
        const raw = lines[index]!;
        const prefix = raw[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          throw new Error(`Malformed unified diff at line ${index + 1}: invalid hunk line prefix`);
        }
        const line: UnifiedDiffLine = {
          kind: prefix === " " ? "context" : prefix === "+" ? "add" : "remove",
          text: raw.slice(1),
          noNewline: false,
        };
        if (line.kind !== "add") oldSeen += 1;
        if (line.kind !== "remove") newSeen += 1;
        if (oldSeen > oldCount || newSeen > newCount) {
          throw new Error(`Malformed unified diff at line ${index + 1}: hunk exceeds its declared line counts`);
        }
        hunkLines.push(line);
        index += 1;
        if (index < lines.length
          && stripPatchSyntaxCarriage(lines[index]!) === "\\ No newline at end of file") {
          line.noNewline = true;
          index += 1;
        }
      }
      if (hunkLines.length === 0) throw new Error("Malformed unified diff: empty hunks are not supported");
      file.hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
    }
    if (file.hunks.length === 0) throw new Error(`Unified diff has no hunks for ${file.path}`);
    files.push(file);
  }

  if (files.length === 0) throw new Error("Unified diff patch contains no file changes");
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`Unified diff contains duplicate file sections: ${file.path}`);
    paths.add(file.path);
  }
  return files;
}

function splitTextLines(text: string): TextLine[] {
  if (!text) return [];
  const parts = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) parts.pop();
  return parts.map((part, index) => ({
    text: part,
    newline: endsWithNewline || index < parts.length - 1,
  }));
}

function joinTextLines(lines: TextLine[]): string {
  return lines.map(line => `${line.text}${line.newline ? "\n" : ""}`).join("");
}

function applyUnifiedHunks(path: string, text: string, hunks: UnifiedDiffHunk[]): string {
  const original = splitTextLines(text);
  const output: TextLine[] = [];
  let cursor = 0;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const startIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (startIndex < 0 || startIndex > original.length) {
      throw new Error(`Hunk ${hunkIndex + 1} for ${path} starts outside the file`);
    }
    if (startIndex < cursor) {
      throw new Error(`Hunk ${hunkIndex + 1} for ${path} overlaps or is out of order`);
    }
    output.push(...original.slice(cursor, startIndex));
    const expectedNewStart = hunk.newCount === 0 ? output.length : output.length + 1;
    if (hunk.newStart !== expectedNewStart) {
      throw new Error(`Hunk ${hunkIndex + 1} for ${path} has inconsistent new-file line number: expected ${expectedNewStart}, got ${hunk.newStart}`);
    }

    let position = startIndex;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push({ text: line.text, newline: !line.noNewline });
        continue;
      }
      const current = original[position];
      if (!current || current.text !== line.text) {
        throw new Error(`Hunk ${hunkIndex + 1} context mismatch for ${path} at old line ${position + 1}`);
      }
      const expectedNewline = !line.noNewline;
      if (current.newline !== expectedNewline) {
        const expectation = expectedNewline ? "a terminating newline" : "no terminating newline";
        throw new Error(`Hunk ${hunkIndex + 1} newline mismatch for ${path} at old line ${position + 1}: patch expects ${expectation}`);
      }
      if (line.kind === "context") output.push(current);
      position += 1;
    }
    cursor = position;
  }

  output.push(...original.slice(cursor));
  const prematureNoNewline = output.findIndex((line, index) => !line.newline && index < output.length - 1);
  if (prematureNoNewline >= 0) {
    throw new Error(`Unified diff creates an invalid missing newline before the end of ${path}`);
  }
  return joinTextLines(output);
}

export class DirectToolService {
  private readonly terminals = new Map<string, TerminalJob>();

  shutdown(): void {
    for (const job of this.terminals.values()) {
      if (job.status !== "running" || !job.child) continue;
      try { terminateOwnedProcessTree(job.child); } catch {}
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      delete job.child;
    }
  }

  read(path: string, workspace: string, mode: LunaSandbox, maxChars = 200_000, maxImageBytes = 10_000_000): DirectTextFileRead | DirectImageFileRead {
    const target = resolveScopedPath(path, workspace, mode);
    const bytes = readFileSync(target);
    const mimeType = imageMimeType(bytes);
    if (mimeType) {
      const limit = Math.min(Math.max(1, maxImageBytes), MAX_DIRECT_IMAGE_BYTES);
      if (bytes.length > limit) {
        throw new Error(`Image exceeds the ${limit}-byte MCP transfer limit: ${target}`);
      }
      return { path: target, mimeType, data: bytes.toString("base64"), bytes: bytes.length };
    }
    const text = bytes.toString("utf8");
    return { path: target, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  async readForTransfer(
    path: string,
    workspace: string,
    mode: LunaSandbox,
    maxChars = 200_000,
    maxImageBytes = 1_500_000,
  ): Promise<DirectTextFileRead | DirectImageFileRead> {
    const target = resolveScopedPath(path, workspace, mode);
    const source = readFileSync(target);
    const sourceMimeType = imageMimeType(source);
    if (!sourceMimeType) {
      const text = source.toString("utf8");
      return { path: target, text: text.slice(0, maxChars), truncated: text.length > maxChars };
    }
    if (source.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`Image exceeds the ${MAX_SOURCE_IMAGE_BYTES}-byte local decode limit: ${target}`);
    }
    const limit = Math.min(Math.max(1, maxImageBytes), MAX_DIRECT_IMAGE_BYTES);
    const metadata = await sharp(source, { animated: false }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (source.length <= limit && width <= MODEL_IMAGE_MAX_DIMENSION && height <= MODEL_IMAGE_MAX_DIMENSION) {
      return { path: target, mimeType: sourceMimeType, data: source.toString("base64"), bytes: source.length, width, height };
    }

    let best: { bytes: Buffer; width: number; height: number } | undefined;
    for (const dimension of [1_600, 1_280, 1_024, 768, 512]) {
      for (const quality of [82, 72, 62]) {
        const transformed = await sharp(source, { animated: false })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        if (!best || transformed.data.length < best.bytes.length) {
          best = { bytes: transformed.data, width: transformed.info.width, height: transformed.info.height };
        }
        if (transformed.data.length <= limit) {
          return {
            path: target,
            mimeType: "image/webp",
            data: transformed.data.toString("base64"),
            bytes: transformed.data.length,
            optimized: true,
            sourceBytes: source.length,
            sourceMimeType,
            width: transformed.info.width,
            height: transformed.info.height,
          };
        }
      }
    }
    throw new Error(`Image could not be reduced below the ${limit}-byte MCP transfer limit: ${target} (smallest ${best?.bytes.length ?? source.length} bytes)`);
  }

  list(path: string, workspace: string, mode: LunaSandbox): {
    path: string;
    entries: Array<{ name: string; kind: string; size?: number; modified_at: string }>;
  } {
    const target = resolveScopedPath(path, workspace, mode);
    const entries = readdirSync(target, { withFileTypes: true }).map(entry => {
      const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      const metadata = lstatSync(resolve(target, entry.name));
      const size = entry.isFile() ? metadata.size : undefined;
      return {
        name: entry.name,
        kind,
        ...(size === undefined ? {} : { size }),
        modified_at: metadata.mtime.toISOString(),
      };
    });
    return { path: target, entries };
  }

  search(query: string, path: string, workspace: string, mode: LunaSandbox, maxResults = 200): {
    path: string; matches: Array<{ path: string; line: number; text: string }>; truncated: boolean;
  } {
    const root = resolveScopedPath(path, workspace, mode);
    const needle = query.toLowerCase();
    if (!needle) throw new Error("query is required");
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const pending = [root];
    let truncated = false;
    while (pending.length > 0 && !truncated) {
      const current = pending.pop()!;
      const stat = statSync(current);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isDirectory() && [".git", "node_modules", ".local"].includes(entry.name)) continue;
          pending.push(resolve(current, entry.name));
        }
        continue;
      }
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      let text: string;
      try { text = readFileSync(current, "utf8"); } catch { continue; }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        matches.push({ path: current, line: index + 1, text: line.slice(0, 2_000) });
        if (matches.length >= maxResults) { truncated = true; break; }
      }
    }
    return { path: root, matches, truncated };
  }

  write(path: string, content: string, workspace: string, mode: LunaSandbox): { path: string; bytes: number } {
    if (mode === "read-only") throw new Error("File writes are disabled in read-only mode");
    const target = resolveScopedPath(path, workspace, mode);
    writeFileSync(target, content, "utf8");
    return { path: target, bytes: Buffer.byteLength(content) };
  }

  edit(
    path: string,
    oldText: string,
    newText: string,
    workspace: string,
    mode: LunaSandbox,
    expectedOccurrences?: number,
  ): DirectFileEditResult {
    assertWritableMode(mode, "File editing");
    if (!oldText) throw new Error("old_text must not be empty");
    if (expectedOccurrences !== undefined && (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1)) {
      throw new Error("expected_occurrences must be a positive integer when provided");
    }

    const source = readMutationTarget(path, workspace, mode);
    const occurrences = countOccurrences(source.text, oldText);
    const expected = expectedOccurrences ?? 1;
    if (occurrences !== expected) {
      if (occurrences === 0) throw new Error(`old_text was not found in ${source.path}`);
      if (expectedOccurrences === undefined) {
        throw new Error(`old_text is ambiguous in ${source.path}: found ${occurrences} occurrences; provide expected_occurrences to replace all exact matches`);
      }
      throw new Error(`Expected ${expected} occurrences of old_text in ${source.path}, found ${occurrences}`);
    }

    const updatedText = source.text.split(oldText).join(newText);
    const updated = Buffer.from(updatedText, "utf8");
    commitTextMutations([{ path: source.path, original: source.bytes, updated }], "File edit");
    return {
      path: source.path,
      replacements: occurrences,
      changed: !source.bytes.equals(updated),
      bytes_before: source.bytes.length,
      bytes_after: updated.length,
    };
  }

  applyPatch(patch: string, workspace: string, mode: LunaSandbox): DirectFilePatchResult {
    assertWritableMode(mode, "File patching");
    const parsed = parseUnifiedDiff(patch);
    const canonicalTargets = new Set<string>();
    const plans: PreparedTextMutation[] = [];
    const files: DirectFilePatchResult["files"] = [];

    for (const file of parsed) {
      const source = readMutationTarget(file.path, workspace, mode);
      if (canonicalTargets.has(source.path)) {
        throw new Error(`Unified diff resolves multiple file sections to the same file: ${source.path}`);
      }
      canonicalTargets.add(source.path);
      const updatedText = applyUnifiedHunks(file.path, source.text, file.hunks);
      const updated = Buffer.from(updatedText, "utf8");
      plans.push({ path: source.path, original: source.bytes, updated });
      files.push({
        path: source.path,
        hunks: file.hunks.length,
        changed: !source.bytes.equals(updated),
        bytes_before: source.bytes.length,
        bytes_after: updated.length,
      });
    }

    commitTextMutations(plans, "File patch");
    return {
      files_applied: files.length,
      hunks_applied: files.reduce((sum, file) => sum + file.hunks, 0),
      files,
    };
  }

  createDirectory(path: string, workspace: string, mode: LunaSandbox, recursive = true): {
    path: string; created: boolean; recursive: boolean;
  } {
    assertWritableMode(mode, "Directory creation");
    const target = resolveScopedPath(path, workspace, mode);
    assertExistingAncestorWithinWorkspace(target, workspace, mode);
    const existed = existsSync(target);
    if (existed && !lstatSync(target).isDirectory()) {
      throw new Error(`A non-directory entry already exists at: ${target}`);
    }
    mkdirSync(target, { recursive });
    return { path: target, created: !existed, recursive };
  }

  deleteDirectory(path: string, workspace: string, mode: LunaSandbox, recursive = false): {
    path: string; deleted: true; recursive: boolean;
  } {
    assertWritableMode(mode, "Directory deletion");
    const target = resolveScopedPath(path, workspace, mode);
    const workspaceRoot = resolve(workspace);
    if (target === workspaceRoot) {
      throw new Error(`Refusing to delete the disclosed workspace root: ${target}`);
    }
    assertExistingAncestorWithinWorkspace(target, workspace, mode);
    const entry = lstatSync(target);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to delete a directory through a symbolic link or junction: ${target}`);
    }
    if (!entry.isDirectory()) throw new Error(`Path is not a directory: ${target}`);
    if (recursive) rmSync(target, { recursive: true, force: false });
    else rmdirSync(target);
    return { path: target, deleted: true, recursive };
  }

  startTerminal(command: string, cwd: string, workspace: string, mode: LunaSandbox): Omit<TerminalJob, "child"> {
    if (mode === "read-only") throw new Error("Terminal execution is disabled in read-only mode");
    const resolvedCwd = resolveScopedPath(cwd, workspace, mode);
    const id = randomUUID();
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const powershellCommand = [
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
      "$global:LASTEXITCODE = $null",
      `& { ${command} }`,
      "$__gptWebCodexSuccess = $?",
      "$__gptWebCodexExitCode = $LASTEXITCODE",
      "if ($null -ne $__gptWebCodexExitCode) { exit $__gptWebCodexExitCode }",
      "if (-not $__gptWebCodexSuccess) { exit 1 }",
    ].join("; ");
    const args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-Command", powershellCommand]
      : ["-lc", command];
    const child = spawn(shell, args, { cwd: resolvedCwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const job: TerminalJob = {
      id, command, cwd: resolvedCwd, status: "running", pid: child.pid,
      output: "", stdout: "", stderr: "", outputTruncated: false,
      startedAt: new Date().toISOString(), child,
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const combined = `${job.output}${text}`;
      const streamed = `${job[stream]}${text}`;
      if (combined.length > 1_000_000 || streamed.length > 1_000_000) job.outputTruncated = true;
      job.output = combined.slice(-1_000_000);
      job[stream] = streamed.slice(-1_000_000);
    };
    child.stdout.on("data", chunk => collect("stdout", chunk));
    child.stderr.on("data", chunk => collect("stderr", chunk));
    child.once("error", error => {
      job.output = `${job.output}\n${error.message}`.trim();
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
    });
    child.once("close", code => {
      if (job.status === "running") job.status = code === 0 ? "completed" : "failed";
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      delete job.child;
    });
    this.terminals.set(id, job);
    return this.publicTerminal(job);
  }

  terminal(jobId: string): Omit<TerminalJob, "child"> {
    const job = this.terminals.get(jobId);
    if (!job) throw new Error(`Unknown terminal job: ${jobId}`);
    return this.publicTerminal(job);
  }

  async waitTerminal(jobId: string, waitMs = 60_000): Promise<Omit<TerminalJob, "child">> {
    const job = this.terminals.get(jobId);
    if (!job) throw new Error(`Unknown terminal job: ${jobId}`);
    if (job.status !== "running" || !job.child || waitMs <= 0) return this.publicTerminal(job);
    await new Promise<void>(resolveWait => {
      const child = job.child!;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        child.off("close", finish);
        child.off("error", finish);
        resolveWait();
      };
      child.once("close", finish);
      child.once("error", finish);
      timer = setTimeout(finish, waitMs);
    });
    return this.publicTerminal(job);
  }

  writeTerminalStdin(jobId: string, input: string, close = false): Omit<TerminalJob, "child"> {
    const job = this.terminals.get(jobId);
    if (!job) throw new Error(`Unknown terminal job: ${jobId}`);
    if (job.status !== "running" || !job.child) throw new Error(`Terminal job is not running: ${jobId}`);
    if (job.child.stdin.destroyed || job.child.stdin.writableEnded) throw new Error(`Terminal stdin is closed: ${jobId}`);
    if (input) job.child.stdin.write(input, "utf8");
    if (close) job.child.stdin.end();
    return this.publicTerminal(job);
  }

  cancelTerminal(jobId: string): Omit<TerminalJob, "child"> {
    const job = this.terminals.get(jobId);
    if (!job) throw new Error(`Unknown terminal job: ${jobId}`);
    if (job.status === "running") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      if (job.child) {
        const child = job.child;
        child.kill("SIGTERM");
        setTimeout(() => { try { terminateOwnedProcessTree(child); } catch {} }, 5_000).unref?.();
      }
    }
    return this.publicTerminal(job);
  }

  private publicTerminal({ child: _child, ...job }: TerminalJob): Omit<TerminalJob, "child"> {
    return { ...job };
  }
}
