# Small-feature benchmark

The second of the three repeatable tasks under *Evaluation* in `V1_README.md`:
"a clear request requiring changes across several files". The bug-fix benchmark
next door is single-file by construction, so nothing in this repository had ever
asked whether the agent can finish a change rather than start one.

Run it:

```
./scripts/benchmark.sh small-feature          # deterministic, no provider call
./scripts/benchmark.sh small-feature --live   # the real model, one run, costs money
```

## What is in here

| Path | What it is |
| --- | --- |
| `fixture/` | The repository the agent is given. Committed, never mutated. |
| `hidden/integration.test.js` | The hidden test. Outside the fixture, absent from its `test` script. |
| `goal.txt` | The exact goal string handed to the agent. |

## The request

Add a membership operator — `state in open|blocked|closed` — to a saved-search
filter language. There is no bug here and nothing to diagnose. The spec is in
`goal.txt`, the visible tests are already written, and the whole task is
carrying one idea across the three files an operator lives in:

- `src/tokenize.js` declares the spelling and turns operand *text* into an
  operand *value*, which for this operator means a list rather than a scalar.
- `src/evaluate.js` decides whether a record satisfies the clause.
- `src/explain.js` writes the English a human reads under the search box, with
  its own small rule for one, two, and three-or-more options.

The three edits are deliberately not the same edit three times. A lexer branch,
a set-membership predicate, and an English list-joiner are different work, so
copying the first one twice does not finish the job.

`src/query.js` is glue and needs no change. It checks at compile time that every
declared operator has both a predicate and a description and fails naming the
missing one, so a half-finished change is loud rather than mysterious — and
so an agent that patches one file and stops fails the *visible* suite, which is
what makes this a multi-file task rather than a multi-file-looking one. Patching
only the lexer leaves six visible failures; patching the lexer and the predicate
leaves seven, because the compile-time check then fires inside tests that used to
pass.

## What the hidden test defends

Each of the three registries can be filled in plausibly and wrongly in a way the
visible suite accepts, because the visible suite checks them one file at a time.
A lexer that does not trim, a predicate that compares against untrimmed options,
and a description written for exactly two options all pass their own file's
tests.

Every case in `hidden/integration.test.js` therefore crosses at least two of the
three files in a single assertion — parse a query, then filter *and* explain the
same clause — and uses option counts and spacing the visible suite never uses:
one option, three options, spaces around the bars, an operand containing a
space, a membership clause composed with an older operator. It also imports
`tokenize`, `matches`, and `describeClause` directly rather than only through
`compile`, so an operator special-cased in the glue satisfies the visible suite
and fails here.

The last case walks the operator table and asserts every declared operator has
both a predicate and a description. That is the fixture's own invariant, checked
from outside the fixture, so it stays true for the operator that was added and
for the four that were already there.

## Scoring

Identical to the bug-fix benchmark, and run by the same code: the fixture's suite
must have been red before, the visible suite is re-run by the runner rather than
believed, the hidden test must pass, a diff must exist, a receipt must have been
emitted, and nothing under `tests/` may have been modified or deleted.

The scripted adapter proposes and applies three separate patches, one per file,
and then runs the suite. That path — several patches in one turn, each one
anchored in a file the agent has not read since the last write — is the part of
the harness this benchmark exercises that the bug-fix benchmark does not.
