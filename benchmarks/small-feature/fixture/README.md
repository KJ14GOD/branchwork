# queryfilter

The saved-search language. A saved search is one line of text; the app compiles
it once and then uses it to filter records and to render the "this search
means…" sentence under the search box.

```js
import { compile, select } from "./src/query.js";

select(records, "state = open and amount > 100");
compile("state = open and amount > 100").explain();
// "state is open, and amount is above 100"
```

## The language

A query is one or more clauses joined by ` and `. Every clause is
`<field> <operator> <value>`, split on whitespace: the first word is the field,
the second is the operator's spelling, and everything after it is the operand
text. Operand text may therefore contain spaces, but it may not contain ` and `,
because that is where clauses are cut.

| Spelling | Meaning |
| --- | --- |
| `=` | the field equals the value |
| `!=` | the field does not equal the value |
| `>` | the field is numerically above the value |
| `~` | the field contains the value as a substring |

Scalar comparisons other than `>` are made on the string form of the field, so
`priority = 2` matches a record whose `priority` is the number 2.

## Where an operator lives

An operator is not one thing in one file. It is three, and each of the three is
a different kind of work:

| File | What it holds | What adding an operator means there |
| --- | --- | --- |
| `src/tokenize.js` | `OPERATORS`, the table of spellings, and `parseOperand` | declaring the spelling, and turning operand *text* into the operand *value* the operator's kind implies |
| `src/evaluate.js` | `PREDICATES`, keyed by operator id | deciding whether one record satisfies one clause |
| `src/explain.js` | `DESCRIPTIONS`, keyed by operator id | the English the app shows a human |

`src/query.js` is only glue. It checks at compile time that every operator
declared in `OPERATORS` has both a predicate and a description, and it fails
loudly naming the missing one, because an operator that parses and then throws
`undefined is not a function` deep inside a filter is much worse to debug than
one that refuses to compile.

Adding an operator therefore touches three files and never touches `query.js`.
That is deliberate: the glue does not learn about operators one at a time.
