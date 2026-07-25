---
name: novus-finish-run
description: Finish and publish a Novus coding run by locating the Git repository, auditing the exact change scope, running required checks, preventing secrets or unrelated work from being staged, creating an intentional commit, and pushing the current branch. Use when the user asks to finish, commit, push, ship, publish, checkpoint, or wrap up completed Novus work.
---

# Novus Finish Run

Turn completed local work into a verified, traceable Git result. Never let
automation hide the diff or absorb unrelated user changes.

## Locate and audit

1. Run `git rev-parse --show-toplevel` and perform all following commands there.
2. Run `git status -sb`, `git diff --stat`, and inspect the complete diff.
3. Identify which files belong to the current coding run.
4. If unrelated changes overlap the intended files, stop and ask for direction.
5. Confirm `.env` and other secrets are ignored and absent from the intended
   staged set.

## Verify

Run the strongest checks supported by the changed area. For the current Novus
workspace, the default gate is:

```bash
pnpm typecheck
pnpm test
git diff --check
```

Do not publish a known failing state unless the user explicitly asks to preserve
it as a checkpoint and the commit message says so.

## Commit

1. Stage explicit intended paths. Do not use `git add -A` in a mixed worktree.
2. Review `git diff --cached --stat` and `git diff --cached`.
3. Create one terse commit describing the completed capability.
4. Do not amend, force-push, reset, or rewrite history unless explicitly asked.

## Push

1. Confirm the configured remote with `git remote -v`.
2. Determine the current branch with `git branch --show-current`.
3. Push with tracking:

   ```bash
   git push -u origin <current-branch>
   ```

4. Never force-push.
5. If the user requested a pull request, create a draft PR after the push.

## Return a run receipt

Report:

- repository and branch;
- commit hash and message;
- pushed remote;
- checks run and results;
- files intentionally left uncommitted;
- PR link when one was requested.
