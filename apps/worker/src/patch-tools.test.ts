import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApplyPatchTool,
  ProposeDeletionTool,
  ProposeNewFileTool,
  ProposePatchTool,
} from "./tools.ts";

const temporaryRepository = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "novus-patch-tools-"));

type Suite = {
  repository: string;
  store: ProposePatchTool;
  newFile: ProposeNewFileTool;
  deletion: ProposeDeletionTool;
  apply: ApplyPatchTool;
};

const suite = async (): Promise<Suite> => {
  const repository = await temporaryRepository();
  const store = new ProposePatchTool(repository);

  return {
    repository,
    store,
    newFile: new ProposeNewFileTool(repository, store),
    deletion: new ProposeDeletionTool(repository, store),
    apply: new ApplyPatchTool(repository, store),
  };
};

const proposeNewFile = (id: string, path: string, content: string) =>
  ({
    id,
    name: "propose_new_file" as const,
    input: { path, intent: "test file creation", content },
  });

const proposeDeletion = (id: string, path: string) =>
  ({
    id,
    name: "propose_deletion" as const,
    input: { path, intent: "test file deletion" },
  });

const applyPatch = (id: string, patchId: string) =>
  ({ id, name: "apply_patch" as const, input: { patchId } });

test("propose_new_file previews a creation without writing, and apply writes it", async () => {
  const { repository, newFile, apply } = await suite();

  const proposed = await newFile.execute(
    proposeNewFile("1", "src/created.ts", "export const created = true;\n"),
  );

  if (proposed.name !== "propose_new_file") return assert.fail("wrong result");

  // The proposal is a preview: the entire file is the diff, and nothing is on
  // disk yet — that is what makes the flow reviewable before it is real.
  assert.equal(proposed.output.status, "proposed");
  assert.match(proposed.output.diff, /\+export const created = true;/);
  assert.equal(proposed.output.additions, 1);
  await assert.rejects(() => stat(join(repository, "src/created.ts")));

  const applied = await apply.execute(applyPatch("2", proposed.output.patchId));

  if (applied.name !== "apply_patch") return assert.fail("wrong result");

  assert.equal(applied.output.status, "applied");
  // Parent directories are created on apply — an agent writing the first file
  // of a new module should not need a separate mkdir tool to exist.
  assert.equal(
    await readFile(join(repository, "src/created.ts"), "utf8"),
    "export const created = true;\n",
  );
});

test("propose_new_file refuses a file that already exists", async () => {
  const { repository, newFile } = await suite();

  await writeFile(join(repository, "present.txt"), "already here\n");

  // Creation must not be a quiet overwrite path: an existing file is edited
  // through propose_patch, where the reviewer sees what is being replaced.
  await assert.rejects(
    () => newFile.execute(proposeNewFile("3", "present.txt", "new content")),
    /already exists/,
  );
});

test("apply refuses a creation when the file appeared after the proposal", async () => {
  const { repository, newFile, apply } = await suite();

  const proposed = await newFile.execute(
    proposeNewFile("4", "race.txt", "proposed content\n"),
  );

  if (proposed.name !== "propose_new_file") return assert.fail("wrong result");

  // Someone else — the human's editor, another run — creates the file between
  // proposal and apply. What was reviewed was "this path is new", so applying
  // now would overwrite content nobody looked at. This is the drift check
  // apply_patch already performs for edits, restated for creations.
  await writeFile(join(repository, "race.txt"), "someone else's file\n");

  await assert.rejects(
    () => apply.execute(applyPatch("5", proposed.output.patchId)),
    /created after this proposal/,
  );

  assert.equal(
    await readFile(join(repository, "race.txt"), "utf8"),
    "someone else's file\n",
  );
});

test("propose_new_file refuses paths outside the repository and protected files", async () => {
  const { newFile } = await suite();

  // The confinement invariant, exercised on the allowMissing path this tool
  // introduced: allowMissing relaxes existence, never the boundary.
  await assert.rejects(
    () => newFile.execute(proposeNewFile("6", "../escape.txt", "x")),
    /outside the repository/,
  );

  await assert.rejects(
    () => newFile.execute(proposeNewFile("7", "/tmp/absolute.txt", "x")),
    /repository-relative/,
  );

  // Creating .env would let the agent plant a secrets file read_file then
  // refuses to show — the protected-path rule has to hold in both directions.
  await assert.rejects(
    () => newFile.execute(proposeNewFile("8", ".env", "KEY=value")),
    /protected repository paths/,
  );

  await assert.rejects(
    () => newFile.execute(proposeNewFile("9", ".git/hooks/pre-commit", "#!/bin/sh")),
    /protected repository paths/,
  );
});

test("propose_new_file refuses a symlinked parent that points outside", async () => {
  const { repository, newFile } = await suite();
  const outside = await mkdtemp(join(tmpdir(), "novus-outside-"));

  await symlink(outside, join(repository, "link"));

  // The path is repository-relative as a string and outside as a directory.
  // The resolver resolves the deepest existing ancestor, so the symlink is
  // seen even though the file itself does not exist yet.
  await assert.rejects(
    () => newFile.execute(proposeNewFile("10", "link/new.txt", "x")),
    /outside the repository/,
  );
});

test("propose_deletion previews the removal, and apply deletes the file", async () => {
  const { repository, deletion, apply } = await suite();

  await writeFile(join(repository, "doomed.txt"), "line one\nline two\n");

  const proposed = await deletion.execute(proposeDeletion("11", "doomed.txt"));

  if (proposed.name !== "propose_deletion") return assert.fail("wrong result");

  // The diff shows exactly what approval means: every line removed.
  assert.equal(proposed.output.deletions, 2);
  assert.match(proposed.output.diff, /-line one/);
  // Still on disk — the proposal is a preview.
  assert.equal(
    await readFile(join(repository, "doomed.txt"), "utf8"),
    "line one\nline two\n",
  );

  const applied = await apply.execute(applyPatch("12", proposed.output.patchId));

  if (applied.name !== "apply_patch") return assert.fail("wrong result");

  await assert.rejects(() => stat(join(repository, "doomed.txt")));
});

test("apply refuses a deletion when the file changed after the proposal", async () => {
  const { repository, deletion, apply } = await suite();

  await writeFile(join(repository, "volatile.txt"), "reviewed content\n");

  const proposed = await deletion.execute(proposeDeletion("13", "volatile.txt"));

  if (proposed.name !== "propose_deletion") return assert.fail("wrong result");

  // Deleting what was reviewed is not deleting what is there now: the file
  // gained content after the deletion was proposed, and removing it would
  // destroy work nobody agreed to lose.
  await writeFile(join(repository, "volatile.txt"), "new unsaved work\n");

  await assert.rejects(
    () => apply.execute(applyPatch("14", proposed.output.patchId)),
    /changed after its deletion was proposed/,
  );

  assert.equal(
    await readFile(join(repository, "volatile.txt"), "utf8"),
    "new unsaved work\n",
  );
});

test("propose_deletion refuses directories and protected paths", async () => {
  const { repository, deletion } = await suite();

  await mkdir(join(repository, "dir"));
  await writeFile(join(repository, ".env"), "KEY=value\n");

  await assert.rejects(
    () => deletion.execute(proposeDeletion("15", "dir")),
    /Directories are refused/,
  );

  // Deleting .env is as protected as reading it: the tool must not be able
  // to destroy the host's credentials file any more than print it.
  await assert.rejects(
    () => deletion.execute(proposeDeletion("16", ".env")),
    /protected repository paths/,
  );
});

test("a deletion applied twice is refused the second time", async () => {
  const { repository, deletion, apply } = await suite();

  await writeFile(join(repository, "once.txt"), "content\n");

  const proposed = await deletion.execute(proposeDeletion("17", "once.txt"));

  if (proposed.name !== "propose_deletion") return assert.fail("wrong result");

  await apply.execute(applyPatch("18", proposed.output.patchId));

  // The already-applied guard, not the missing-file guard: the proposal was
  // consumed, and replaying a consumed patchId must fail for that stated
  // reason rather than a confusing one about the file.
  await assert.rejects(
    () => apply.execute(applyPatch("19", proposed.output.patchId)),
    /already applied/,
  );
});

test("all three proposal kinds share one store, so apply resolves any patchId", async () => {
  const { repository, store, newFile, apply } = await suite();

  await writeFile(join(repository, "existing.txt"), "old text\n");

  const edit = await store.execute({
    id: "20",
    name: "propose_patch",
    input: {
      path: "existing.txt",
      intent: "edit",
      edits: [{ oldText: "old text", newText: "new text" }],
    },
  });
  const create = await newFile.execute(proposeNewFile("21", "fresh.txt", "hi\n"));

  if (edit.name !== "propose_patch") return assert.fail("wrong result");
  if (create.name !== "propose_new_file") return assert.fail("wrong result");

  // One store is what makes "was this applied" answerable from one place —
  // both ids resolve through the same apply tool with no knowledge of which
  // tool minted them.
  await apply.execute(applyPatch("22", create.output.patchId));
  await apply.execute(applyPatch("23", edit.output.patchId));

  assert.equal(await readFile(join(repository, "existing.txt"), "utf8"), "new text\n");
  assert.equal(await readFile(join(repository, "fresh.txt"), "utf8"), "hi\n");
});
