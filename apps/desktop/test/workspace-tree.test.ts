import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceCommandError } from "../electron/workspace-processes";
import { listWorkspaceTree, readWorkspaceFile, writeWorkspaceFile } from "../electron/workspace-tree";

/**
 * Reading the workspace's files, against a real directory (D-048).
 *
 * The assertions that matter are the refusals. A pane that shows a project's
 * files is one `..` away from showing somebody's private keys, and a symlink
 * inside the worktree is an ordinary-looking relative path right up until it is
 * followed — so the containment is tested with real symlinks pointing at real
 * files outside, not with strings that merely look suspicious.
 */

let worktree: string;
let outside: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "novus-tree-"));
  outside = mkdtempSync(join(tmpdir(), "novus-outside-"));
  writeFileSync(join(outside, "secrets.txt"), "an api key that lives somewhere else\n");

  writeFileSync(join(worktree, "README.md"), "# fixture\n\nSome prose.\n");
  writeFileSync(join(worktree, "app.ts"), "export const answer = 42;\n");
  mkdirSync(join(worktree, "src"));
  writeFileSync(join(worktree, "src", "index.ts"), "console.log('hi');\n");
  mkdirSync(join(worktree, ".git"));
  writeFileSync(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(worktree, "node_modules"));
  writeFileSync(join(worktree, "node_modules", "junk.js"), "module.exports = 1;\n");
});

afterEach(() => {
  for (const path of [worktree, outside]) rmSync(path, { recursive: true, force: true });
});

describe("listing a workspace", () => {
  it("shows the project, folders first, and never its bookkeeping", () => {
    const entries = listWorkspaceTree(worktree);
    expect(entries.map((entry) => entry.name)).toEqual(["src", "app.ts", "README.md"]);
    expect(entries[0]?.kind).toBe("directory");
    expect(entries.find((entry) => entry.name === "README.md")?.extension).toBe("md");
    // `.git` is not the project and `node_modules` is not somebody's reading.
    expect(entries.map((entry) => entry.name)).not.toContain(".git");
    expect(entries.map((entry) => entry.name)).not.toContain("node_modules");
  });

  it("lists a folder inside it by its relative path", () => {
    const entries = listWorkspaceTree(worktree, "src");
    expect(entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
  });

  it("refuses a path that climbs out", () => {
    for (const path of ["..", "../", "../../etc", "src/../../elsewhere"]) {
      expect(() => listWorkspaceTree(worktree, path)).toThrow(WorkspaceCommandError);
    }
  });

  it("refuses a symlink that points outside, however ordinary the path looks", () => {
    symlinkSync(outside, join(worktree, "escape"));
    // The name is a plain relative path; only following it says otherwise, which
    // is why containment is judged after `realpath` and not before.
    expect(() => listWorkspaceTree(worktree, "escape")).toThrow(/not inside this workspace/);
    expect(() => readWorkspaceFile(worktree, "escape/secrets.txt")).toThrow(
      /not inside this workspace/
    );
  });
});

describe("reading a file", () => {
  it("returns its text, its size, and where it is", () => {
    const file = readWorkspaceFile(worktree, "README.md");
    expect(file.path).toBe("README.md");
    expect(file.text).toContain("# fixture");
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(file.bytes).toBeGreaterThan(0);
  });

  it("says a file is not text rather than showing mojibake", () => {
    writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const file = readWorkspaceFile(worktree, "logo.png");
    expect(file.binary).toBe(true);
    expect(file.text).toBeNull();
  });

  it("says a file is too large rather than reading it into a pane", () => {
    writeFileSync(join(worktree, "huge.log"), "x".repeat(1_000_001));
    const file = readWorkspaceFile(worktree, "huge.log");
    expect(file.truncated).toBe(true);
    expect(file.text).toBeNull();
  });

  it("refuses a folder, by name", () => {
    expect(() => readWorkspaceFile(worktree, "src")).toThrow(/folder, not a file/);
  });
});

describe("editing a file", () => {
  it("overwrites one that is already there", () => {
    writeWorkspaceFile(worktree, "README.md", "# fixture\n\nEdited.\n");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toContain("Edited.");
  });

  it("will not create one", () => {
    // Creating files is directed work with a checkpoint behind it, not an
    // editor pane's job (D-048).
    expect(() => writeWorkspaceFile(worktree, "invented.md", "hello")).toThrow(/does not create one/);
  });

  it("will not overwrite something that is not text", () => {
    writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    expect(() => writeWorkspaceFile(worktree, "logo.png", "text")).toThrow(/not text/);
  });

  it("refuses to write outside the workspace, through a symlink or a path", () => {
    symlinkSync(join(outside, "secrets.txt"), join(worktree, "linked.txt"));
    expect(() => writeWorkspaceFile(worktree, "linked.txt", "overwritten")).toThrow(
      /not inside this workspace/
    );
    expect(() => writeWorkspaceFile(worktree, "../secrets.txt", "overwritten")).toThrow(
      WorkspaceCommandError
    );
    // And the file outside is untouched.
    expect(readFileSync(join(outside, "secrets.txt"), "utf8")).toContain("somewhere else");
  });
});
