# Repository-reasoning benchmark

The third of the three repeatable tasks under *Evaluation* in `V1_README.md`:
"a task where the obvious local change is wrong without understanding a
dependency elsewhere in the repository".

Run it:

```
./scripts/benchmark.sh repo-reasoning          # deterministic, no provider call
./scripts/benchmark.sh repo-reasoning --live   # the real model, one run, costs money
```

## What is in here

| Path | What it is |
| --- | --- |
| `fixture/` | The repository the agent is given. Committed, never mutated. |
| `hidden/regression.test.js` | The hidden test. Outside the fixture, absent from its `test` script. |
| `goal.txt` | The exact goal string handed to the agent. |

## The symptom, and the two ways to make it go away

`fixture/` is an append-only event log with a daily rollup and a retention
policy. Three modules, one shared range selector:

```
window.js  entriesBetween(entries, from, to)   inclusive of both bounds
   ├── rollup.js  dailyCounts    asks for [dayStart, dayStart + DAY_MS]
   └── purge.js   keptByRetention asks for [now - retentionMs, now]
```

The failing tests say an entry stamped exactly midnight is counted on both the
day that ended and the day that started, so the chart totals more than the log
holds. That is true, and the cause is `rollup.js` asking for a closed range one
whole day wide when a day is half-open: day *n* and day *n+1* overlap at exactly
one instant, and any entry landing on it is counted twice.

The tempting change is one character in `window.js` — make the upper bound
exclusive. It is not a stupid change. Half-open ranges are the better default,
the fix is smaller, and it is in the file the double-count most obviously comes
from. **It makes the entire visible suite pass**, because the visible tests for
`entriesBetween` pin the lower bound and never ask about the upper one.

What it breaks is the other caller. Retention's window ends at `now`, and the
newest entry in a log is routinely stamped exactly `now`, because compaction
runs in the same tick as the append that triggered it. With a half-open range,
every freshly appended entry is deleted by the compaction immediately after it.
The only code in the package that removes data starts removing the wrong data,
and no visible test says so.

That dependency is written down in three places the agent can reach: the
contract paragraph in `README.md`, the docblock on `entriesBetween` saying the
bound is a published property and naming the callers as the thing to read first,
and the docblock on `keptByRetention` explaining why its upper bound is closed.
None of them is in the module the failing test names. Finding them is the task.

## What the hidden test defends

`hidden/regression.test.js` is behavioural on both sides of the fork. It checks
the rollup with different spans and different data than the visible suite, so
deleting or special-casing the failing assertion does not survive; and it checks
retention, including an entry written in the same tick as the compaction that
follows it, so the one-character change does not survive either.

It deliberately does not assert *how* the range function is written or which
file was edited. An agent that flips the bound in `window.js` **and** fixes the
retention caller to match passes, which is correct — it understood the
dependency, which is the entire thing being measured. An agent that flips the
bound and stops fails three cases, all of them retention.

Measured against the committed fixture:

| Change | Visible suite | Hidden test |
| --- | --- | --- |
| none | 2 failures | 3 failures |
| `rollup.js` asks for a half-open day | passes | passes |
| `window.js` becomes half-open | **passes** | **3 failures** |
| `window.js` half-open *and* retention updated | passes | passes |

The third row is the reason this benchmark exists. If it were not green in the
first column, the task would not be testing what it claims to test — it would
just be a bug fix with a longer README.

## Scoring

Identical to the other two benchmarks and run by the same code: the fixture's
suite must have been red before, the visible suite is re-run by the runner
rather than believed, the hidden test must pass, a diff must exist, a receipt
must have been emitted, and nothing under `tests/` may have been modified or
deleted.

The scripted adapter takes the path a reasoning agent would: it searches for
`entriesBetween`, reads both callers before proposing anything, and then patches
`rollup.js`. Because the scripted variant is a fixed sequence of decisions, that
proves the fixture and the scorer work end to end — it proves nothing about
whether a model would have read `purge.js` first. Only the live run says that,
and `V1_README.md` records what it said.
