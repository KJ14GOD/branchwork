import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLineDiff, parseUnifiedZero } from "../electron/workspace-diff";
import { gitExec } from "../electron/workspace-git";

/**
 * The in-place wash (D-227): the file view paints what the mission did to an
 * open file. The parser is proven on git's own hunk grammar; the whole answer
 * is proven against a real repository with a real pinned base.
 */

describe("reading git's zero-context hunks", () => {
  it("washes added and rewritten runs, and seams pure removals", () => {
    const diff = [
      "diff --git a/x b/x",
      "@@ -0,0 +1,2 @@", // two lines added at the top
      "@@ -10,3 +12,0 @@", // three lines removed after new line 12
      "@@ -20 +22 @@", // one line rewritten (count-1 shorthand)
      ""
    ].join("\n");
    expect(parseUnifiedZero(diff)).toEqual({
      changed: true,
      washed: [1, 2, 22],
      deletions: [12]
    });
  });

  it("an empty diff is quiet nothing", () => {
    expect(parseUnifiedZero("")).toEqual({ changed: false, washed: [], deletions: [] });
  });
});

describe("the whole answer, against a real repository", () => {
  let worktree: string;
  let baseSha: string;

  const git = async (args: string[]): Promise<string> => {
    const outcome = await gitExec(worktree, args);
    if (outcome.code !== 0) throw new Error(outcome.stderr);
    return outcome.stdout.trim();
  };

  beforeEach(async () => {
    worktree = mkdtempSync(join(tmpdir(), "novus-diff-"));
    await git(["init", "-b", "main"]);
    writeFileSync(join(worktree, ".gitignore"), ".env\n");
    writeFileSync(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nfive\nsix\n");
    await git(["add", "-A"]);
    await git(["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-m", "base"]);
    baseSha = await git(["rev-parse", "HEAD"]);
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it("washes the mission's rewrite and addition, and seams its removal, against the pinned base", async () => {
    // Rewrite line 2, delete the non-adjacent line 5, append a line — and
    // commit it, so the wash proves "since the base", not "uncommitted".
    writeFileSync(join(worktree, "app.ts"), "one\nTWO\nthree\nfour\nsix\nseven\n");
    await git(["add", "-A"]);
    await git(["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-m", "turn"]);

    const diff = await fileLineDiff(gitExec, worktree, baseSha, "app.ts");
    expect(diff.changed).toBe(true);
    expect(diff.washed).toContain(2); // the rewrite
    expect(diff.washed).toContain(6); // the appended line
    expect(diff.deletions).toEqual([4]); // "five" vanished after new line 4
  });

  it("a brand-new untracked file is the green change whole, before any commit", async () => {
    writeFileSync(join(worktree, "fresh.ts"), "alpha\nbeta\n");
    const diff = await fileLineDiff(gitExec, worktree, baseSha, "fresh.ts");
    expect(diff.changed).toBe(true);
    expect(diff.washed).toEqual([1, 2]);
    expect(diff.deletions).toEqual([]);
  });

  it("an untouched file, an ignored file, and an unanswerable base all stay quiet", async () => {
    expect((await fileLineDiff(gitExec, worktree, baseSha, "app.ts")).changed).toBe(false);

    // A person-supplied ignored file never wears the mission's wash.
    writeFileSync(join(worktree, ".env"), "KEY=x\n");
    expect((await fileLineDiff(gitExec, worktree, baseSha, ".env")).changed).toBe(false);

    // A base the checkout does not hold falls back to HEAD rather than erroring.
    writeFileSync(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    const fallback = await fileLineDiff(gitExec, worktree, "f".repeat(40), "app.ts");
    expect(fallback.changed).toBe(true);
    expect(fallback.washed).toEqual([7]);
  });
});
