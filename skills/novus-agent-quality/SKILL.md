---
name: novus-agent-quality
description: Stress-test the Novus agent loop for livelocks, wasted calls, and confidently wrong conclusions, and keep the bounds that stop a stuck run honest. Use when elision, budgets, retries, or the system prompt change, when a live run loops or dies for an unclear reason, or when a run's summary needs checking against the code it describes.
---

# Novus Agent Quality

A run can fail two ways, and only one of them is visible. It can loop or
waste calls — the log shows it. Or it can finish cleanly and be *wrong*:
state where something is handled, how two files relate, why something works,
with full confidence and no error anywhere. The second kind is worse, because
the only way to catch it is to check the claims against the code yourself.
Test for both, separately, every time the loop changes.

## Run a stress test

Headless runs, isolated from anything else on the machine:

```bash
NOVUS_ALLOW_WRITES=0 NOVUS_ALLOW_COMMANDS=0 NOVUS_PORT=4519 \
NOVUS_DB=/tmp/stress-run.db NOVUS_REPO=<target repo> \
pnpm --filter @novus/worker start "<goal>"
```

- Pin the permission variables in the environment — `--env-file` cannot
  override them, so a `.env` that enables writes stays overridden.
- One worker per port; the process stays alive after the run, so kill it
  before the next one.
- Use broad goals, not bug fixes: "explain this repo", "trace how X flows end
  to end", "summarize <one huge file>". Broad goals are what exposed every
  livelock so far; narrow goals fit inside every window and prove nothing.
- Test against a repository that is *not* this one too. lessong
  (`~/Desktop/lessong`) has `.cache/*.json` files over 100k characters, which
  is the oversize-result path; this repo's own worker sources are the
  many-medium-files path.

## Judge efficiency

Read the tool lines, not just the receipt. Healthy shapes observed live:
"explain this repo" on a small repo — 14 model calls, 276k tokens, 97s, zero
repeated calls. Summarizing a 206k file post-fix — 7 calls, one read of the
big file, then `search_repository` into it. The worst *legitimate* shape: a
convergent trace of this repo whose working set overflowed the 100k verbatim
window ran ~45 calls and re-read one file four times, each re-read invited
by elision. That thrash is bounded and real, and it is why the read ceiling
sits at eight, not three.

Suspect a loop when the same tool runs with the same arguments repeatedly
with no write in between. The runner fails the run at eight — if a run dies
with "re-reading what it already had", believe it, then find why the model
could not converge. Fix convergence, never the ceiling: raising a ceiling to
keep a stuck run alive is explicitly forbidden (novus-build-harness), and
both livelocks so far were convergence bugs in elision, not undersized
limits.

## Audit correctness

Take the summary apart claim by claim and check each against the actual code.
The failure modes found live, in order of danger:

- **Invented citations.** `read_file` returns no line numbers, so every
  `file:line` a summary cites came from somewhere. A live run cited
  `server.mjs:274`, `:530`, `:345` — all real code, all 20–30 lines off,
  every number an estimate dressed as a citation. The system prompt now
  forbids citing lines a tool result didn't show; spot-check that it holds.
- **Invented external facts.** The same run declared `claude-opus-4-8` "not a
  real Anthropic model id — would fail with a 400" and called working code a
  typo. The id is real; the model's knowledge was stale. Anything a summary
  asserts about the world outside the repository — model ids, library
  behavior, versions — is unverifiable by the run and must be checked or
  distrusted. The prompt now requires labelling these unverified.
- **Truncation presented as completion.** A summary that hit the output
  ceiling was recorded in `run.completed` mid-sentence, and the cut-off half
  contained the answer to the question asked. The reply now carries a visible
  cut-off note; if you ever see one, the answer is incomplete no matter how
  finished it reads.
- **Harness-induced near-misses.** The oversize note reports the length of
  the JSON-encoded payload; a run repeated that number as the file's size on
  disk (~10% high — escaping). Small, but it came from us.

## The bounds, and why they are what they are

- `identicalReads: 5` — the behavioural loop check. A read is a pure function
  of the repository, so identical reads with no write between are zero
  information. Five, because elision legitimately invites re-reads and a
  healthy run was observed at two; the counter resets on any write or
  command execution, so read-patch-readback never trips. This catches a
  livelock in a dozen calls instead of thirty minutes.
- `totalTokens`, `wallClockMs`, `maxModelCalls` — deliberately left alone.
  They measure cost and patience, not health; the 79-call livelock proved
  they cannot catch a loop early, and tightening them would stop runs that
  are merely working hard. Detection is the identical-read counter's job.
- Transient provider errors (429/5xx/529, connection drops) are waited out
  through three lengthening delays before they may end a run. Two live runs
  in one night each lost ~20 calls of gathered context to single 529s;
  everything needed to continue was in memory both times.

## When the loop changes, re-test these

- **Any elision change** → the three livelock shapes: many medium files
  (fixed by the size budget), one file larger than the whole budget (fixed by
  the truncated head — the stub's "call the tool again" advice must never
  reappear on a result that cannot fit), and multi-turn history (finished
  turns must elide; they each used to spend a fresh 100k).
  `context-size.test.ts` holds all three.
- **Any system prompt change** → rerun a broad goal and re-audit citations
  and external claims; the prompt is the only control on fabrication and
  nothing else will fail when it regresses.
- **Any adapter change** → `model-response.test.ts` (truncation, malformed
  calls) and the transient-error mapping; a 529 must reach the runner as
  `TransientModelError` or runs start dying to weather again.
- **Anything touching the runner loop** → the detector tests in
  `agent-runner.test.ts`, especially "re-reading after a write is recovery" —
  the reset is what keeps the detector from punishing legitimate work.

## Still open

- `search_repository` silently skips files over ripgrep's 1M cap, so the
  oversize note's "search this file" advice is dead advice for very large
  files.
- Fabrication is mitigated by prompt, not solved; only live runs measure it.
  If it recurs, the next lever is numbering lines in search output the model
  is told to prefer, not numbering `read_file` (models copy line numbers into
  `oldText` and break `propose_patch`).
- The event log stores oversized tool results whole; the model boundary is
  protected but renderers and the relay still carry the full payload.
