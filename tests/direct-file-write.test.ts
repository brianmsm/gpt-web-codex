import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectToolService } from "../src/standalone/direct-tools";

const TEXT_MUTATION_FILE_BYTES = 16 * 1024 * 1024;

function withWorkspace(run: (root: string, workspace: string, tools: DirectToolService) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gwc-direct-write-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    run(root, workspace, new DirectToolService());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stagingFiles(path: string): string[] {
  return fs.readdirSync(path).filter(name => name.includes(".gwc-"));
}

function unified(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

test("file_write safely replaces an existing UTF-8 file and preserves its mode", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "existing.txt");
    writeFileSync(path, "before\n", "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o764);

    const content = "mañana 🌙\n";
    const result = tools.write("existing.txt", content, workspace, "workspace-write");

    expect(result).toEqual({ path, bytes: Buffer.byteLength(content, "utf8") });
    expect(readFileSync(path, "utf8")).toBe(content);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o764);
    expect(stagingFiles(workspace)).toEqual([]);
  });
});

test("file_write follows an internal file symlink but rejects an escaping file symlink", () => {
  withWorkspace((root, workspace, tools) => {
    const inside = join(workspace, "inside.txt");
    const insideLink = join(workspace, "inside-link.txt");
    writeFileSync(inside, "inside\n", "utf8");
    symlinkSync(inside, insideLink, "file");

    tools.write("inside-link.txt", "changed\n", workspace, "workspace-write");
    expect(readFileSync(inside, "utf8")).toBe("changed\n");
    expect(lstatSync(insideLink).isSymbolicLink()).toBe(true);

    const outside = join(root, "outside.txt");
    const outsideLink = join(workspace, "outside-link.txt");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, outsideLink, "file");

    expect(() => tools.write("outside-link.txt", "blocked\n", workspace, "workspace-write")).toThrow("through a link");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });
});

test("file_write rejects non-UTF-8 existing files instead of bypassing the text mutation boundary", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "binary.bin");
    writeFileSync(path, Buffer.from([0xff, 0x00, 0x61]));

    expect(() => tools.write("binary.bin", "text\n", workspace, "workspace-write")).toThrow("UTF-8 text");
    expect(readFileSync(path)).toEqual(Buffer.from([0xff, 0x00, 0x61]));
  });
});

test("file_write creates new Unicode files in canonical in-workspace parents", () => {
  withWorkspace((_root, workspace, tools) => {
    mkdirSync(join(workspace, "nested", "deep"), { recursive: true });
    const content = "café 🦊\n";
    const target = join(workspace, "nested", "deep", "new.txt");

    const result = tools.write("nested/deep/new.txt", content, workspace, "workspace-write");

    expect(result).toEqual({ path: target, bytes: Buffer.byteLength(content, "utf8") });
    expect(readFileSync(target, "utf8")).toBe(content);
    expect(stagingFiles(join(workspace, "nested", "deep"))).toEqual([]);
  });
});

test("file_write allows an internal parent symlink but rejects a parent symlink escape", () => {
  withWorkspace((root, workspace, tools) => {
    const insideDir = join(workspace, "real-dir");
    mkdirSync(insideDir);
    symlinkSync(insideDir, join(workspace, "inside-dir"), process.platform === "win32" ? "junction" : "dir");
    tools.write("inside-dir/new.txt", "inside\n", workspace, "workspace-write");
    expect(readFileSync(join(insideDir, "new.txt"), "utf8")).toBe("inside\n");

    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(workspace, "escape-dir"), process.platform === "win32" ? "junction" : "dir");
    expect(() => tools.write("escape-dir/new.txt", "outside\n", workspace, "workspace-write")).toThrow("through a link");
    expect(existsSync(join(outsideDir, "new.txt"))).toBe(false);
  });
});

test("file_write rejects workspace traversal and read-only writes for both create and replace", () => {
  withWorkspace((root, workspace, tools) => {
    const existing = join(workspace, "existing.txt");
    writeFileSync(existing, "before\n", "utf8");

    expect(() => tools.write("existing.txt", "blocked\n", workspace, "read-only")).toThrow("read-only");
    expect(readFileSync(existing, "utf8")).toBe("before\n");
    expect(() => tools.write("new.txt", "blocked\n", workspace, "read-only")).toThrow("read-only");
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);

    const outside = join(root, "outside.txt");
    expect(() => tools.write("../outside.txt", "blocked\n", workspace, "workspace-write")).toThrow("outside");
    expect(existsSync(outside)).toBe(false);
  });
});

test("file_write refuses missing parents and dangling symlink targets instead of weakening create semantics", () => {
  withWorkspace((_root, workspace, tools) => {
    expect(() => tools.write("missing/new.txt", "new\n", workspace, "workspace-write")).toThrow("Parent directory does not exist");
    expect(existsSync(join(workspace, "missing"))).toBe(false);

    const dangling = join(workspace, "dangling.txt");
    symlinkSync(join(workspace, "does-not-exist.txt"), dangling, "file");
    expect(() => tools.write("dangling.txt", "new\n", workspace, "workspace-write")).toThrow("does not exist or cannot be resolved");
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
  });
});

test("file_write preserves danger-full-access semantics outside the workspace", () => {
  withWorkspace((root, workspace, tools) => {
    const outsideExisting = join(root, "outside-existing.txt");
    writeFileSync(outsideExisting, "before\n", "utf8");
    tools.write(outsideExisting, "after\n", workspace, "danger-full-access");
    expect(readFileSync(outsideExisting, "utf8")).toBe("after\n");

    const outsideNew = join(root, "outside-new.txt");
    tools.write(outsideNew, "new\n", workspace, "danger-full-access");
    expect(readFileSync(outsideNew, "utf8")).toBe("new\n");
  });
});

test("file_write enforces the mutation limit in UTF-8 bytes before writing or allocating an output buffer", () => {
  withWorkspace((_root, workspace, tools) => {
    const existing = join(workspace, "existing.txt");
    writeFileSync(existing, "before\n", "utf8");
    const oversized = "é".repeat(Math.floor(TEXT_MUTATION_FILE_BYTES / 2) + 1);
    expect(oversized.length).toBeLessThan(TEXT_MUTATION_FILE_BYTES);
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(TEXT_MUTATION_FILE_BYTES);

    expect(() => tools.write("existing.txt", oversized, workspace, "workspace-write")).toThrow("updated file is too large");
    expect(readFileSync(existing, "utf8")).toBe("before\n");
    expect(() => tools.write("new.txt", oversized, workspace, "workspace-write")).toThrow("updated file is too large");
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);
    expect(stagingFiles(workspace)).toEqual([]);
  });
});

test("file_write does not truncate an existing file when staged publication fails", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "existing.txt");
    writeFileSync(path, "before\n", "utf8");
    const originalRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      if (String(oldPath).includes(".existing.txt.gwc-updated-") && String(newPath) === path) {
        throw new Error("synthetic publish failure");
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync);

    try {
      expect(() => tools.write("existing.txt", "after\n", workspace, "workspace-write")).toThrow("synthetic publish failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect(readFileSync(path, "utf8")).toBe("before\n");
    expect(stagingFiles(workspace)).toEqual([]);
  });
});

test("file_write refuses a concurrent external change detected during existing-file staging", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "existing.txt");
    writeFileSync(path, "before\n", "utf8");
    const originalWrite = fs.writeFileSync;
    let injected = false;
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      originalWrite(file, data, options as never);
      if (!injected && String(file).includes(".existing.txt.gwc-rollback-")) {
        injected = true;
        originalWrite(path, "external\n", "utf8");
      }
    }) as typeof fs.writeFileSync);

    try {
      expect(() => tools.write("existing.txt", "after\n", workspace, "workspace-write")).toThrow("changed during staging");
    } finally {
      writeSpy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("external\n");
    expect(stagingFiles(workspace)).toEqual([]);
  });
});

test("file_write create publication never overwrites a target that appears in the race window", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "race.txt");
    const originalLink = fs.linkSync;
    let injected = false;
    const linkSpy = spyOn(fs, "linkSync").mockImplementation(((existingPath, newPath) => {
      if (!injected && String(newPath) === path) {
        injected = true;
        writeFileSync(path, "racer\n", "utf8");
      }
      return originalLink(existingPath, newPath);
    }) as typeof fs.linkSync);

    try {
      expect(() => tools.write("race.txt", "ours\n", workspace, "workspace-write")).toThrow("target appeared before publication");
    } finally {
      linkSpy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("racer\n");
    expect(stagingFiles(workspace)).toEqual([]);
  });
});

test("file_write cleans create staging files after a publication error", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "new.txt");
    const linkSpy = spyOn(fs, "linkSync").mockImplementation((() => {
      throw new Error("synthetic create publish failure");
    }) as typeof fs.linkSync);

    try {
      expect(() => tools.write("new.txt", "content\n", workspace, "workspace-write")).toThrow("synthetic create publish failure");
    } finally {
      linkSpy.mockRestore();
    }

    expect(existsSync(path)).toBe(false);
    expect(stagingFiles(workspace)).toEqual([]);
  });
});

test("file_write, file_edit, and file_apply_patch share the canonical direct-mutation lock", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "shared.txt");
    const alias = join(workspace, "alias.txt");
    writeFileSync(path, "before\n", "utf8");
    symlinkSync(path, alias, "file");

    const originalWrite = fs.writeFileSync;
    let editBlockedWrite = false;
    let injected = false;
    let writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      if (!injected && String(file).includes(".shared.txt.gwc-updated-")) {
        injected = true;
        try {
          tools.write("alias.txt", "nested-write\n", workspace, "workspace-write");
        } catch (error) {
          editBlockedWrite = String(error).includes("another direct text mutation");
        }
      }
      originalWrite(file, data, options as never);
    }) as typeof fs.writeFileSync);
    try {
      tools.edit("shared.txt", "before", "edited", workspace, "workspace-write");
    } finally {
      writeSpy.mockRestore();
    }
    expect(editBlockedWrite).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("edited\n");

    let patchBlockedWrite = false;
    injected = false;
    writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      if (!injected && String(file).includes(".shared.txt.gwc-updated-")) {
        injected = true;
        try {
          tools.write("shared.txt", "nested-write\n", workspace, "workspace-write");
        } catch (error) {
          patchBlockedWrite = String(error).includes("another direct text mutation");
        }
      }
      originalWrite(file, data, options as never);
    }) as typeof fs.writeFileSync);
    try {
      tools.applyPatch(unified(
        "--- a/shared.txt",
        "+++ b/shared.txt",
        "@@ -1 +1 @@",
        "-edited",
        "+patched",
      ), workspace, "workspace-write");
    } finally {
      writeSpy.mockRestore();
    }
    expect(patchBlockedWrite).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("patched\n");

    let writeBlockedEdit = false;
    injected = false;
    writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      if (!injected && String(file).includes(".shared.txt.gwc-updated-")) {
        injected = true;
        try {
          tools.edit("alias.txt", "patched", "nested-edit", workspace, "workspace-write");
        } catch (error) {
          writeBlockedEdit = String(error).includes("another direct text mutation");
        }
      }
      originalWrite(file, data, options as never);
    }) as typeof fs.writeFileSync);
    try {
      tools.write("shared.txt", "written\n", workspace, "workspace-write");
    } finally {
      writeSpy.mockRestore();
    }
    expect(writeBlockedEdit).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("written\n");
    expect(stagingFiles(workspace)).toEqual([]);
  });
});
