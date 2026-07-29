# Running several agents on Novus at once

Four terminals all pointed at this directory is not parallelism — it is four
agents sharing one working tree, overwriting each other's edits and running
tests against half-written files. The fleet gives each agent its own checkout,
its own branch, and one shared rule about the file they all want to touch.

## The three pieces

**Isolation.** `scripts/fleet.sh` cuts a Git worktree per slice under
`../novus-fleet/<slice>`, on branch `fleet/<slice>`, with its own
`node_modules`. Agents cannot collide because they are not in the same
directory.

**The loop.** `scripts/stop-gate.sh` is a Stop hook: an agent that tries to end
its turn on a red gate gets the failure back instead of ending. Three strikes
and it reports rather than spinning. `fleet.sh run` wraps that in an outer loop
that starts a *fresh* session when the inner one exhausts itself, because a new
context is usually what an agent stuck on its own reasoning needs.

**The boundary.** `packages/contracts` is the one file every slice wants.
`scripts/contract-lock.sh` is a mutex on it, stored in the shared `.git`
directory so a claim in one worktree is visible in all of them.
`scripts/contract-guard.sh` is a PreToolUse hook that denies writes to
`packages/contracts` from any branch not holding the lock — so an agent that
forgets to claim it is stopped, not trusted.

## Commands

```
./scripts/fleet.sh add <slice> "<task>"   cut the worktree and write the brief
./scripts/fleet.sh list                   branches, drift from main, dirt, lock
./scripts/fleet.sh status                 same, plus run the gate in each slice
./scripts/fleet.sh integrate [slice...]   gate the slices merged together
./scripts/fleet.sh tmux                   one window per slice, already cd'd in
./scripts/fleet.sh launch <slice>         print the command to drive it yourself
./scripts/fleet.sh run <slice> [rounds]   drive it unattended until green
./scripts/fleet.sh rm <slice>             tear it down, releasing the lock

./scripts/contract-lock.sh acquire|release|status|force-release
```

`tmux` builds a `novus` session: window 0 is the main repo — the one checkout no
agent writes to, where you watch status and merge from — and one window per
slice, each already in its worktree with `claude "$(cat .fleet-task)"` typed but
**not** sent. Read the brief, press Enter. Re-running attaches rather than
rebuilding, so it is safe to call again after adding a slice.

`run` uses `--permission-mode acceptEdits`: file edits inside the worktree go
through, commands still respect `.claude/settings.json`. Override with
`NOVUS_FLEET_PERMISSION_MODE`.

## The one rule

**Exactly one slice may hold `packages/contracts` at a time.** A slice that needs
the boundary acquires the lock, makes the contract change, and merges promptly so
the next slice can move. Everything downstream of an already-merged contract runs
beside it without coordination.

When a slice is denied the lock, the right move is not to wait — it is to build
the part of the slice that does not touch the boundary, then acquire afterwards.

## Testing slices together before you merge

A worktree can only ever hold one slice, so `status` showing every slice GREEN
proves each one works *alone*. It says nothing about whether they work together —
two slices can pass separately and still break combined, because they touched the
same function from different directions or one added a field the other does not
handle.

```
./scripts/fleet.sh integrate                 # every slice
./scripts/fleet.sh integrate a b             # just these
```

This cuts a scratch branch from main, merges the slices onto it, and runs the
gate on the combination. Main is never touched. A conflicting slice is reported
by filename and backed out so the others still get judged, and the whole branch
is destroyed and rebuilt on the next run — so fix what it finds in the slice that
owns the behaviour, never in the integration worktree.

Green apart and red together is the result worth having. It is much cheaper to
learn here than after a merge to main.

## Subagents

Four exist, and each answers a question you do not want filling a slice's own
context. Ask for them by name.

| Agent | When | Answers |
| --- | --- | --- |
| `contract-mapper` | Before taking the lock | If this schema changes, what breaks — and is it worth the lock? |
| `scope-warden` | Before writing a brief | Is this V1, or is the README talking? |
| `merge-guard` | Before merging | Does this branch violate an invariant? |
| `Explore` | Any time | Where does X live, without reading the files into this session? |

`contract-mapper` is the one that pays for itself repeatedly: holding the
boundary is expensive for every other slice, so knowing the full reach of a
change before you claim it is what keeps the lock held briefly.

## Merging

`skills/novus-merge-slice` owns this, and `.claude/agents/merge-guard.md` audits
a branch against the invariants before it lands. The short version:

```
cd ../novus-fleet/<slice> && ./scripts/gate.sh     # green, in the slice
cd - && git merge --no-ff fleet/<slice>
./scripts/gate.sh                                   # green again, after merging
./scripts/fleet.sh rm <slice>
```

Rebase the other slices onto main after any contract change lands.

## A backlog that actually parallelises

Derived from the V1 build order. The split is by whether the work touches the
boundary, because that is what decides if two slices can run at the same time.

### Needs the contract lock — run these one at a time

| Slice | Work | Milestone |
| --- | --- | --- |
| `git-tools` | `list_directory`, `git_status`, `git_diff` — read class | 2 |
| `run-tools` | `run_command`, `run_tests` — dangerous class, approval gated | 2 |
| `receipt` | Run receipt: goal, revision, tools, diff, tests, cost, tokens | 2 |
| `direction-queue` | `direction.submitted` / `direction.applied`, applied at a turn boundary | 3 |
| `checkpoint-fork` | `checkpoint.created` / `fork.created` plus the worktree manager | 4 |

### Boundary-free — run these in parallel with anything

| Slice | Work | Milestone |
| --- | --- | --- |
| `sqlite-store` | Replace the in-memory event store with SQLite; events are the source of truth | 1 |
| `secret-redaction` | Redact env vars, keys, and credential files before events leave the worker | 5 |
| `guest-shell` | `apps/guest` is a bare `package.json` — build the browser guest client | 1 |
| `compare-screen` | Side-by-side diff, tests, cost, elapsed for two attempts | 4 |

Ready to paste:

```
./scripts/fleet.sh add sqlite-store    "Replace the worker's in-memory event store with SQLite. The event log is the source of truth and current state is a projection rebuilt from it. Do not change packages/contracts."
./scripts/fleet.sh add secret-redaction "Redact environment variables, API keys, and credential-file contents from events before they leave the worker. Add tests proving a known key never reaches the event stream."
./scripts/fleet.sh add guest-shell     "apps/guest has only a package.json. Build the browser guest client shell that connects to the session service and renders the same ordered event timeline the desktop shows."
```

Three at once is the honest ceiling here: you are the merge point, and a fourth
slice produces work faster than one person can review and land it.

## If it breaks

The toolchain is the usual culprit. `nvm` is a shell function from an
interactive profile, so anything the fleet spawns inherits `/usr/local/bin/node`
— Node 22 on this machine, which cannot run the repo at all.
`scripts/toolchain.sh` resolves the right Node from nvm's directory and every
script sources it. If a worktree reports an engine mismatch, that file is where
to look.
