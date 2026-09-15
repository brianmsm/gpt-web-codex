import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectToolService } from "../src/standalone/direct-tools";

function withWorkspace(run: (root: string, workspace: string, tools: DirectToolService) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gwc-direct-edit-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    run(root, workspace, new DirectToolService());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function unified(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

const TEXT_MUTATION_FILE_BYTES = 16 * 1024 * 1024;
const TEXT_MUTATION_TRANSACTION_BYTES = 64 * 1024 * 1024;

test("file_edit replaces one exact occurrence and reports the byte change", () => {
  withWorkspace((_root, workspace, tools) => {
    writeFileSync(join(workspace, "sample.txt"), "alpha beta gamma\n", "utf8");
    const result = tools.edit("sample.txt", "beta", "BETA", workspace, "workspace-write");
    expect(result).toEqual({
      path: join(workspace, "sample.txt"),
      replacements: 1,
      changed: true,
      bytes_before: 17,
      bytes_after: 17,
    });
    expect(readFileSync(join(workspace, "sample.txt"), "utf8")).toBe("alpha BETA gamma\n");
  });
});

test("file_edit rejects missing and ambiguous context without modifying the file", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "sample.txt");
    writeFileSync(path, "same same\n", "utf8");
    expect(() => tools.edit("sample.txt", "missing", "x", workspace, "workspace-write")).toThrow("not found");
    expect(readFileSync(path, "utf8")).toBe("same same\n");
    expect(() => tools.edit("sample.txt", "same", "x", workspace, "workspace-write")).toThrow("ambiguous");
    expect(readFileSync(path, "utf8")).toBe("same same\n");
  });
});

test("file_edit replaces exactly the declared number of non-overlapping matches", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "sample.txt");
    writeFileSync(path, "same same same\n", "utf8");
    expect(() => tools.edit("sample.txt", "same", "x", workspace, "workspace-write", 2)).toThrow("found 3");
    expect(readFileSync(path, "utf8")).toBe("same same same\n");
    const result = tools.edit("sample.txt", "same", "x", workspace, "workspace-write", 3);
    expect(result.replacements).toBe(3);
    expect(readFileSync(path, "utf8")).toBe("x x x\n");
  });
});

test("file_edit treats old_text equal to new_text as a validated no-op", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "same.txt");
    writeFileSync(path, "unchanged\n", "utf8");
    const result = tools.edit("same.txt", "unchanged", "unchanged", workspace, "workspace-write");
    expect(result).toMatchObject({ replacements: 1, changed: false });
    expect(readFileSync(path, "utf8")).toBe("unchanged\n");
  });
});

test("file_edit handles Unicode and rejects an empty file when old_text is absent", () => {
  withWorkspace((_root, workspace, tools) => {
    writeFileSync(join(workspace, "unicode.txt"), "café 🦊\n", "utf8");
    const result = tools.edit("unicode.txt", "café 🦊", "mañana 🌙", workspace, "workspace-write");
    expect(result.replacements).toBe(1);
    expect(readFileSync(join(workspace, "unicode.txt"), "utf8")).toBe("mañana 🌙\n");

    writeFileSync(join(workspace, "empty.txt"), "", "utf8");
    expect(() => tools.edit("empty.txt", "x", "y", workspace, "workspace-write")).toThrow("not found");
    expect(readFileSync(join(workspace, "empty.txt"), "utf8")).toBe("");
  });
});

test("file_edit rejects read-only, traversal, symlink escape, and non-text input", () => {
  withWorkspace((root, workspace, tools) => {
    writeFileSync(join(workspace, "inside.txt"), "inside\n", "utf8");
    expect(() => tools.edit("inside.txt", "inside", "changed", workspace, "read-only")).toThrow("read-only");
    expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("inside\n");

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside\n", "utf8");
    expect(() => tools.edit("../outside.txt", "outside", "changed", workspace, "workspace-write")).toThrow("outside");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");

    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "linked.txt"), "linked\n", "utf8");
    symlinkSync(outsideDir, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => tools.edit("escape/linked.txt", "linked", "changed", workspace, "workspace-write")).toThrow("through a link");
    expect(readFileSync(join(outsideDir, "linked.txt"), "utf8")).toBe("linked\n");

    writeFileSync(join(workspace, "binary.bin"), Buffer.from([0xff, 0x00, 0x61]));
    expect(() => tools.edit("binary.bin", "a", "b", workspace, "workspace-write")).toThrow("UTF-8 text");
  });
});

test("file_edit preserves danger-full-access semantics outside the workspace", () => {
  withWorkspace((root, workspace, tools) => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside\n", "utf8");
    tools.edit(outside, "outside", "allowed", workspace, "danger-full-access");
    expect(readFileSync(outside, "utf8")).toBe("allowed\n");
  });
});

test("file_apply_patch applies one strict unified-diff hunk", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "sample.txt");
    writeFileSync(path, "alpha\nbeta\ngamma\n", "utf8");
    const result = tools.applyPatch(unified(
      "--- a/sample.txt",
      "+++ b/sample.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
    ), workspace, "workspace-write");
    expect(result).toMatchObject({ files_applied: 1, hunks_applied: 1 });
    expect(result.files[0]).toMatchObject({ path, hunks: 1, changed: true });
    expect(readFileSync(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });
});

test("file_apply_patch applies multiple hunks at their exact declared coordinates", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "multi.txt");
    writeFileSync(path, "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
    const result = tools.applyPatch(unified(
      "--- a/multi.txt",
      "+++ b/multi.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -5,2 +5,2 @@",
      " five",
      "-six",
      "+SIX",
    ), workspace, "workspace-write");
    expect(result.hunks_applied).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("one\nTWO\nthree\nfour\nfive\nSIX\n");
  });
});

test("file_apply_patch validates every file before a multi-file commit", () => {
  withWorkspace((_root, workspace, tools) => {
    const first = join(workspace, "first.txt");
    const second = join(workspace, "second.txt");
    writeFileSync(first, "first\n", "utf8");
    writeFileSync(second, "second\n", "utf8");
    const result = tools.applyPatch(unified(
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1 +1 @@",
      "-first",
      "+FIRST",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1 +1 @@",
      "-second",
      "+SECOND",
    ), workspace, "workspace-write");
    expect(result.files_applied).toBe(2);
    expect(readFileSync(first, "utf8")).toBe("FIRST\n");
    expect(readFileSync(second, "utf8")).toBe("SECOND\n");
  });
});

test("file_apply_patch leaves every file unchanged when a later file has stale context", () => {
  withWorkspace((_root, workspace, tools) => {
    const first = join(workspace, "first.txt");
    const second = join(workspace, "second.txt");
    writeFileSync(first, "first\n", "utf8");
    writeFileSync(second, "second-current\n", "utf8");
    const patch = unified(
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1 +1 @@",
      "-first",
      "+FIRST",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1 +1 @@",
      "-second-stale",
      "+SECOND",
    );
    expect(() => tools.applyPatch(patch, workspace, "workspace-write")).toThrow("context mismatch");
    expect(readFileSync(first, "utf8")).toBe("first\n");
    expect(readFileSync(second, "utf8")).toBe("second-current\n");
  });
});

test("file_apply_patch never relocates a hunk to matching text at another line", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "strict.txt");
    writeFileSync(path, "prefix\ntarget\n", "utf8");
    const patch = unified(
      "--- a/strict.txt",
      "+++ b/strict.txt",
      "@@ -1 +1 @@",
      "-target",
      "+changed",
    );
    expect(() => tools.applyPatch(patch, workspace, "workspace-write")).toThrow("context mismatch");
    expect(readFileSync(path, "utf8")).toBe("prefix\ntarget\n");
  });
});

test("file_apply_patch rejects malformed patches and invalid hunk counts", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "sample.txt");
    writeFileSync(path, "one\ntwo\n", "utf8");
    expect(() => tools.applyPatch("not a unified diff", workspace, "workspace-write")).toThrow("Malformed unified diff");
    expect(() => tools.applyPatch(unified(
      "--- a/sample.txt",
      "+++ b/sample.txt",
      "@@ -1,2 +1,2 @@",
      " one",
    ), workspace, "workspace-write")).toThrow("hunk ended");
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });
});

test("file_apply_patch explicitly rejects file creation and deletion", () => {
  withWorkspace((_root, workspace, tools) => {
    expect(() => tools.applyPatch(unified(
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+new",
    ), workspace, "workspace-write")).toThrow("creation and deletion");
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);

    const existing = join(workspace, "existing.txt");
    writeFileSync(existing, "old\n", "utf8");
    expect(() => tools.applyPatch(unified(
      "--- a/existing.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
    ), workspace, "workspace-write")).toThrow("creation and deletion");
    expect(readFileSync(existing, "utf8")).toBe("old\n");
  });
});

test("file_apply_patch rejects traversal, symlink escape, and read-only mode", () => {
  withWorkspace((root, workspace, tools) => {
    const inside = join(workspace, "inside.txt");
    writeFileSync(inside, "inside\n", "utf8");
    const insidePatch = unified(
      "--- a/inside.txt",
      "+++ b/inside.txt",
      "@@ -1 +1 @@",
      "-inside",
      "+changed",
    );
    expect(() => tools.applyPatch(insidePatch, workspace, "read-only")).toThrow("read-only");
    expect(readFileSync(inside, "utf8")).toBe("inside\n");

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside\n", "utf8");
    const traversal = unified(
      "--- ../outside.txt",
      "+++ ../outside.txt",
      "@@ -1 +1 @@",
      "-outside",
      "+changed",
    );
    expect(() => tools.applyPatch(traversal, workspace, "workspace-write")).toThrow("outside");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");

    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    const linked = join(outsideDir, "linked.txt");
    writeFileSync(linked, "linked\n", "utf8");
    symlinkSync(outsideDir, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    const escaped = unified(
      "--- escape/linked.txt",
      "+++ escape/linked.txt",
      "@@ -1 +1 @@",
      "-linked",
      "+changed",
    );
    expect(() => tools.applyPatch(escaped, workspace, "workspace-write")).toThrow("through a link");
    expect(readFileSync(linked, "utf8")).toBe("linked\n");
  });
});

test("file_apply_patch preserves CRLF and missing-final-newline semantics", () => {
  withWorkspace((_root, workspace, tools) => {
    const crlf = join(workspace, "crlf.txt");
    writeFileSync(crlf, "one\r\ntwo\r\n", "utf8");
    tools.applyPatch(unified(
      "--- a/crlf.txt",
      "+++ b/crlf.txt",
      "@@ -1,2 +1,2 @@",
      " one\r",
      "-two\r",
      "+TWO\r",
    ), workspace, "workspace-write");
    expect(readFileSync(crlf, "utf8")).toBe("one\r\nTWO\r\n");

    const noEol = join(workspace, "no-eol.txt");
    writeFileSync(noEol, "old", "utf8");
    tools.applyPatch(unified(
      "--- a/no-eol.txt",
      "+++ b/no-eol.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ), workspace, "workspace-write");
    expect(readFileSync(noEol, "utf8")).toBe("new");
  });
});

test("file_apply_patch enforces exact final-newline markers for every transition", () => {
  withWorkspace((_root, workspace, tools) => {
    const cases = [
      { name: "eol-to-eol", initial: "old\n", oldNoNewline: false, newNoNewline: false, expected: "new\n" },
      { name: "no-eol-to-no-eol", initial: "old", oldNoNewline: true, newNoNewline: true, expected: "new" },
      { name: "no-eol-to-eol", initial: "old", oldNoNewline: true, newNoNewline: false, expected: "new\n" },
      { name: "eol-to-no-eol", initial: "old\n", oldNoNewline: false, newNoNewline: true, expected: "new" },
    ];

    for (const transition of cases) {
      const relative = `${transition.name}.txt`;
      const path = join(workspace, relative);
      writeFileSync(path, transition.initial, "utf8");
      const lines = [
        `--- a/${relative}`,
        `+++ b/${relative}`,
        "@@ -1 +1 @@",
        "-old",
      ];
      if (transition.oldNoNewline) lines.push("\\ No newline at end of file");
      lines.push("+new");
      if (transition.newNoNewline) lines.push("\\ No newline at end of file");

      tools.applyPatch(unified(...lines), workspace, "workspace-write");
      expect(readFileSync(path, "utf8")).toBe(transition.expected);
    }
  });
});

test("file_apply_patch rejects either direction of stale final-newline context", () => {
  withWorkspace((_root, workspace, tools) => {
    const missing = join(workspace, "missing-eol.txt");
    writeFileSync(missing, "old", "utf8");
    expect(() => tools.applyPatch(unified(
      "--- a/missing-eol.txt",
      "+++ b/missing-eol.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ), workspace, "workspace-write")).toThrow("patch expects a terminating newline");
    expect(readFileSync(missing, "utf8")).toBe("old");

    const present = join(workspace, "present-eol.txt");
    writeFileSync(present, "old\n", "utf8");
    expect(() => tools.applyPatch(unified(
      "--- a/present-eol.txt",
      "+++ b/present-eol.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ), workspace, "workspace-write")).toThrow("patch expects no terminating newline");
    expect(readFileSync(present, "utf8")).toBe("old\n");
  });
});

test("file_edit rejects oversized existing and updated files without modifying them", () => {
  withWorkspace((_root, workspace, tools) => {
    const oversized = join(workspace, "oversized-existing.txt");
    writeFileSync(oversized, Buffer.alloc(TEXT_MUTATION_FILE_BYTES + 1, 0x61));
    expect(() => tools.edit(
      "oversized-existing.txt", "a", "b", workspace, "workspace-write",
    )).toThrow("existing file is too large");
    expect(statSync(oversized).size).toBe(TEXT_MUTATION_FILE_BYTES + 1);

    const oversizedResult = join(workspace, "oversized-result.txt");
    const original = `old\n${"x".repeat(12 * 1024 * 1024)}\n`;
    writeFileSync(oversizedResult, original, "utf8");
    const replacement = "z".repeat(5_000_000);
    expect(() => tools.edit(
      "oversized-result.txt", "old", replacement, workspace, "workspace-write",
    )).toThrow("updated file is too large");
    expect(readFileSync(oversizedResult, "utf8")).toBe(original);
  });
});

test("file_apply_patch bounds the aggregate multi-file mutation transaction", () => {
  withWorkspace((_root, workspace, tools) => {
    const fileCount = 4;
    const payload = "x".repeat(TEXT_MUTATION_TRANSACTION_BYTES / 8);
    const patch: string[] = [];
    for (let index = 1; index <= fileCount; index += 1) {
      const relative = `budget-${index}.txt`;
      writeFileSync(join(workspace, relative), `old\n${payload}\n`, "utf8");
      patch.push(
        `--- a/${relative}`,
        `+++ b/${relative}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
      );
    }

    expect(() => tools.applyPatch(
      unified(...patch), workspace, "workspace-write",
    )).toThrow("transaction limit");
    for (let index = 1; index <= fileCount; index += 1) {
      expect(readFileSync(join(workspace, `budget-${index}.txt`), "utf8")).toBe(`old\n${payload}\n`);
    }
  });
});

test("file_apply_patch handles strict pure insertions and deletions at file boundaries", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "boundaries.txt");
    writeFileSync(path, "one\ntwo\n", "utf8");

    tools.applyPatch(unified(
      "--- a/boundaries.txt",
      "+++ b/boundaries.txt",
      "@@ -0,0 +1 @@",
      "+zero",
      "@@ -2,0 +4 @@",
      "+three",
    ), workspace, "workspace-write");
    expect(readFileSync(path, "utf8")).toBe("zero\none\ntwo\nthree\n");

    tools.applyPatch(unified(
      "--- a/boundaries.txt",
      "+++ b/boundaries.txt",
      "@@ -1 +0,0 @@",
      "-zero",
      "@@ -4 +2,0 @@",
      "-three",
    ), workspace, "workspace-write");
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });
});

test("file_apply_patch preserves mixed line endings on untouched and context lines", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "mixed-eol.txt");
    writeFileSync(path, "one\r\ntwo\nthree\r\n", "utf8");
    tools.applyPatch(unified(
      "--- a/mixed-eol.txt",
      "+++ b/mixed-eol.txt",
      "@@ -1,3 +1,3 @@",
      " one\r",
      "-two",
      "+TWO",
      " three\r",
    ), workspace, "workspace-write");
    expect(readFileSync(path)).toEqual(Buffer.from("one\r\nTWO\nthree\r\n", "utf8"));
  });
});

test("file_apply_patch cleans all staging files after a successful rollback", () => {
  withWorkspace((_root, workspace, tools) => {
    const first = join(workspace, "first-clean-rollback.txt");
    const second = join(workspace, "second-clean-rollback.txt");
    writeFileSync(first, "first\n", "utf8");
    writeFileSync(second, "second\n", "utf8");

    const originalRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      if (String(oldPath).includes(".second-clean-rollback.txt.gwc-updated-")) {
        throw new Error("synthetic second-file commit failure");
      }
      originalRename(oldPath, newPath);
    }) as typeof fs.renameSync);

    try {
      expect(() => tools.applyPatch(unified(
        "--- a/first-clean-rollback.txt",
        "+++ b/first-clean-rollback.txt",
        "@@ -1 +1 @@",
        "-first",
        "+FIRST",
        "--- a/second-clean-rollback.txt",
        "+++ b/second-clean-rollback.txt",
        "@@ -1 +1 @@",
        "-second",
        "+SECOND",
      ), workspace, "workspace-write")).toThrow("synthetic second-file commit failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect(readFileSync(first, "utf8")).toBe("first\n");
    expect(readFileSync(second, "utf8")).toBe("second\n");
    expect(fs.readdirSync(workspace).filter(name => name.includes(".gwc-"))).toEqual([]);
  });
});

test("file_apply_patch preserves only the useful recovery backup after a concurrent rollback conflict", () => {
  withWorkspace((_root, workspace, tools) => {
    const first = join(workspace, "first-race.txt");
    const second = join(workspace, "second-race.txt");
    writeFileSync(first, "first\n", "utf8");
    writeFileSync(second, "second\n", "utf8");

    const originalRename = fs.renameSync;
    let injectedConcurrentChange = false;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      originalRename(oldPath, newPath);
      if (!injectedConcurrentChange
        && String(newPath) === first
        && String(oldPath).includes(".gwc-updated-")) {
        injectedConcurrentChange = true;
        writeFileSync(first, "external-first\n", "utf8");
        writeFileSync(second, "external-second\n", "utf8");
      }
    }) as typeof fs.renameSync);

    let failure: Error | undefined;
    try {
      tools.applyPatch(unified(
        "--- a/first-race.txt",
        "+++ b/first-race.txt",
        "@@ -1 +1 @@",
        "-first",
        "+FIRST",
        "--- a/second-race.txt",
        "+++ b/second-race.txt",
        "@@ -1 +1 @@",
        "-second",
        "+SECOND",
      ), workspace, "workspace-write");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      renameSpy.mockRestore();
    }

    expect(failure?.message).toContain("rollback was incomplete");
    expect(injectedConcurrentChange).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("external-first\n");
    expect(readFileSync(second, "utf8")).toBe("external-second\n");

    const leftovers = fs.readdirSync(workspace).filter(name => name.includes(".gwc-"));
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toContain(".first-race.txt.gwc-rollback-");
    const recoveryPath = join(workspace, leftovers[0]!);
    expect(readFileSync(recoveryPath, "utf8")).toBe("first\n");
    expect(failure?.message).toContain(`original preserved at ${recoveryPath}`);
  });
});

test("file_apply_patch preserves and reports the rollback backup when restoration itself fails", () => {
  withWorkspace((_root, workspace, tools) => {
    const first = join(workspace, "first-rollback-failure.txt");
    const second = join(workspace, "second-rollback-failure.txt");
    writeFileSync(first, "first\n", "utf8");
    writeFileSync(second, "second\n", "utf8");

    const originalRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      const source = String(oldPath);
      if (source.includes(".second-rollback-failure.txt.gwc-updated-")) {
        throw new Error("synthetic second-file commit failure");
      }
      if (String(newPath) === first && source.includes(".gwc-rollback-")) {
        throw new Error("synthetic rollback rename failure");
      }
      originalRename(oldPath, newPath);
    }) as typeof fs.renameSync);

    let failure: Error | undefined;
    try {
      tools.applyPatch(unified(
        "--- a/first-rollback-failure.txt",
        "+++ b/first-rollback-failure.txt",
        "@@ -1 +1 @@",
        "-first",
        "+FIRST",
        "--- a/second-rollback-failure.txt",
        "+++ b/second-rollback-failure.txt",
        "@@ -1 +1 @@",
        "-second",
        "+SECOND",
      ), workspace, "workspace-write");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      renameSpy.mockRestore();
    }

    expect(failure?.message).toContain("synthetic rollback rename failure");
    expect(readFileSync(first, "utf8")).toBe("FIRST\n");
    expect(readFileSync(second, "utf8")).toBe("second\n");

    const leftovers = fs.readdirSync(workspace).filter(name => name.includes(".gwc-"));
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toContain(".first-rollback-failure.txt.gwc-rollback-");
    const recoveryPath = join(workspace, leftovers[0]!);
    expect(readFileSync(recoveryPath, "utf8")).toBe("first\n");
    expect(failure?.message).toContain(`original preserved at ${recoveryPath}`);
  });
});

test("file_apply_patch does not strip a literal a/ directory from non-git headers", () => {
  withWorkspace((_root, workspace, tools) => {
    mkdirSync(join(workspace, "a"));
    const path = join(workspace, "a", "nested.txt");
    writeFileSync(path, "old\n", "utf8");
    tools.applyPatch(unified(
      "--- a/nested.txt",
      "+++ a/nested.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ), workspace, "workspace-write");
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });
});

test("file_apply_patch preserves danger-full-access semantics outside the workspace", () => {
  withWorkspace((root, workspace, tools) => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "old\n", "utf8");
    tools.applyPatch(unified(
      `--- ${outside}`,
      `+++ ${outside}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ), workspace, "danger-full-access");
    expect(readFileSync(outside, "utf8")).toBe("new\n");
  });
});

test("file_edit rejects stale exact context after the file was changed externally", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "stale.txt");
    writeFileSync(path, "before expected after\n", "utf8");
    writeFileSync(path, "before current after\n", "utf8");
    expect(() => tools.edit("stale.txt", "before expected after", "replacement", workspace, "workspace-write")).toThrow("not found");
    expect(readFileSync(path, "utf8")).toBe("before current after\n");
  });
});

test("file_apply_patch accepts ordinary git unified-diff metadata without weakening hunk matching", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "git-style.txt");
    writeFileSync(path, "old\n", "utf8");
    tools.applyPatch(unified(
      "diff --git a/git-style.txt b/git-style.txt",
      "index 1111111..2222222 100644",
      "--- a/git-style.txt",
      "+++ b/git-style.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ), workspace, "workspace-write");
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });
});


test("direct text mutations preserve existing POSIX permission bits", () => {
  if (process.platform === "win32") return;
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "mode.txt");
    writeFileSync(path, "before\n", "utf8");
    chmodSync(path, 0o764);
    tools.edit("mode.txt", "before", "after", workspace, "workspace-write");
    expect(statSync(path).mode & 0o777).toBe(0o764);
  });
});

test("file_apply_patch rejects unsupported structural metadata instead of ignoring it", () => {
  withWorkspace((_root, workspace, tools) => {
    const path = join(workspace, "mode.txt");
    writeFileSync(path, "old\n", "utf8");
    const patch = unified(
      "diff --git a/mode.txt b/mode.txt",
      "old mode 100644",
      "new mode 100755",
      "--- a/mode.txt",
      "+++ b/mode.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    );
    expect(() => tools.applyPatch(patch, workspace, "workspace-write")).toThrow("metadata is not supported");
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });
});
