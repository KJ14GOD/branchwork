---
name: novus-merge-slice
description: Land a finished parallel slice from a Novus fleet worktree back into main, including the gate, the invariant audit, the merge, and tearing the worktree down. Use when a fleet branch is done, when several agents have been working in parallel and their work needs integrating, or when asked to merge, land, or clean up a slice.
---

# Novus Merge Slice

A slice is finished when it is green **and** audited **and** merged **and** torn
down. Stopping after the merge leaves worktrees that quietly rot.

## Before anything, know who owns the contract

`packages/contracts/src/contracts.ts` is the bottleneck: every capability
touches it, and two slices editing it will conflict in a way the type checker
cannot warn about ahead of time.

```bash
git diff main...fleet/<slice> --name-only | grep packages/contracts
```

If more than one open slice touches it, **merge the contract-owning slice
first**, then rebase the others onto the new main before continuing. Do not
merge two contract-editing slices back to back and hope.

## Verify in the worktree, not in main

```bash
cd ../novus-fleet/<slice>
./scripts/gate.sh
```

Red gate, stop here. The slice is not done and merging it makes main red too.

## Audit before landing

Run the `merge-guard` subagent against the branch. It checks the things the gate
cannot: contract consumers left unhandled, filesystem access that skips the
resolver, a new tool with no permission class, a tool failure that ends a run,
strip-only syntax that type-checks but will not execute, and secrets in the diff.

`DO NOT MERGE` is a stop, not a suggestion. Fix it in the worktree, re-run the
gate, and audit again.

## Merge

```bash
cd <repo root>
git merge --no-ff fleet/<slice>
```

Keep `--no-ff`. The merge commit is the record that a slice existed as a unit of
parallel work, which is the only trace left once the worktree is gone.

Then re-run the gate **in main**. A slice can be green alone and red once
combined with another slice that landed while it was working — that is exactly
what parallel work risks, and the only place it shows up is here.

If main is red after the merge, fix forward on main. Do not reset or rewrite the
merge unless the user asks.

## Tear down

```bash
./scripts/fleet.sh rm <slice>
./scripts/fleet.sh list
```

The worktree and its branch both go. `list` should no longer show the slice.

## Report

- which slice, which branch, which merge commit;
- gate result in the worktree and again in main;
- the `merge-guard` verdict and anything it flagged;
- slices still open and whether any of them now need a rebase;
- anything left uncommitted, and why.
