# Bug-fix benchmark

The first of the three repeatable tasks under *Evaluation* in `V1_README.md`:
"a repository with a failing test and a hidden regression test". It is the
evidence Milestone 2's exit condition asks for, and until it is run that
milestone is a claim about the parts rather than the whole.

Run it:

```
./scripts/benchmark.sh              # deterministic, no provider call
./scripts/benchmark.sh --live       # the real model, one run, costs money
```

## What is in here

| Path | What it is |
| --- | --- |
| `fixture/` | The repository the agent is given. Committed, never mutated. |
| `hidden/regression.test.js` | The hidden test. Outside the fixture, absent from its `test` script. |
| `goal.txt` | The exact goal string handed to the agent. |

`apps/worker/src/benchmark.ts` is the runner and the scorer.

## The bug

`fixture/src/rate-limiter.js` is a token bucket that credits `refill` tokens
every whole `intervalMs`. `settle()` computes how many whole intervals have
elapsed, credits them, and then sets `lastRefillAt` to *now* — which throws away
the part of the interval that had not completed yet.

A caller polling once a second never notices, because a whole interval has
always elapsed by the time it asks. A caller polling every 100ms is starved
completely: each poll sees 100ms elapsed, floors that to zero intervals, and
then resets the clock, so the remainder is destroyed a tenth of a second at a
time and the bucket never refills again.

That is the bug worth having in a benchmark. The symptom is far from the cause,
the code at the cause reads as correct, and the fix is a reasoning step rather
than a typo: the accumulator has to advance by the time it *consumed*
(`lastRefillAt += earned * intervalMs`) and not by the time that *passed*. It is
also not fixable by inspection of the failing assertion alone — nothing in the
failing test mentions `lastRefillAt`.

## Why the hidden test is not optional

"Make the failing test pass" is satisfied by deleting the assertion, by
special-casing a 100ms poll, or by making `available()` return `burst`. Each of
those would be scored a pass by the visible suite alone. The hidden test uses
different intervals, different refill rates and different call shapes, and
additionally pins the properties the visible suite only implies — the burst
ceiling, all-or-nothing spending, and that carrying the remainder forward must
not double-credit it.

It also rejects the most plausible *wrong* fix, which is to make refill
continuous. Trickling `elapsed / intervalMs * refill` tokens makes the failing
test pass and reads as more elegant, but it contradicts the documented contract
and the visible test that already pins it.

## Scoring

The runner records, and the verdict requires, all of:

- the fixture's own suite failed **before** the agent ran (the bug was real)
- the visible suite passes after, re-run by the runner rather than believed
- the hidden test passes
- a diff was produced against the scratch repository's base commit
- a `receipt.created` event was emitted
- nothing under `tests/` was modified or deleted

Tokens, model calls and elapsed time come from the receipt and are reported
whatever the verdict. The scripted variant reports zero tokens and a non-zero
`callsMissingUsage`, which is the receipt honestly saying its totals are a floor
— no provider call happened, so there is no usage to report.

## The two variants, and what each one proves

`scripted` wires `ScriptedModelAdapter`'s pattern to a fixed sequence of tool
calls. Every tool is real, the scratch repository is real, the patch, the test
run, the diff and the receipt are all real; only the decisions are canned. It
proves the harness can carry a fix from proposal to applied diff to verified
receipt, and it proves the fixture and the scorer work. It does not prove a
model can find the bug, and nothing in this repository should claim it does.

`live` swaps in `AnthropicModelAdapter` and changes nothing else. That is the
run that proves the agent, and it is the one that cannot be in the gate.
