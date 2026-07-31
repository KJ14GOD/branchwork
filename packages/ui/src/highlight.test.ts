import assert from "node:assert/strict";
import test from "node:test";

import {
  highlightLine,
  highlightLines,
  INITIAL_STATE,
  languageForPath,
  piecesFor,
  type LanguageId,
  type Token,
  type TokenKind,
} from "./highlight.ts";

/** The tokens of one line, as `kind:text` pairs, for readable assertions. */
const marks = (line: string, language: LanguageId): string[] =>
  highlightLine(line, language).tokens.map(
    (token) => `${token.kind}:${line.slice(token.start, token.end)}`,
  );

const kindsOf = (line: string, language: LanguageId): TokenKind[] =>
  highlightLine(line, language).tokens.map((token) => token.kind);

test("languageForPath maps the extensions the app actually shows", () => {
  assert.equal(languageForPath("src/session.ts"), "typescript");
  assert.equal(languageForPath("a/b/c.tsx"), "typescript");
  assert.equal(languageForPath("main.rs"), "rust");
  assert.equal(languageForPath("cmd/serve.go"), "go");
  assert.equal(languageForPath("tokenize.py"), "python");
  assert.equal(languageForPath("theme.css"), "css");
  assert.equal(languageForPath("package.json"), "json");
  assert.equal(languageForPath("config/pipeline.yaml"), "yaml");
  assert.equal(languageForPath("deploy.sh"), "shell");
  assert.equal(languageForPath("docs/README.md"), "markdown");
  assert.equal(languageForPath("index.html"), "markup");
});

test("an unknown extension gets no language rather than a guess", () => {
  assert.equal(languageForPath("data.bin"), null);
  assert.equal(languageForPath("LICENSE"), null);
  assert.equal(languageForPath("notes"), null);
});

test("extension-less files that are still a known format are recognised", () => {
  assert.equal(languageForPath("Dockerfile"), "shell");
  assert.equal(languageForPath("app/Makefile"), "shell");
  assert.equal(languageForPath(".gitignore"), "shell");
});

test("keywords, strings, numbers and calls are told apart", () => {
  assert.deepEqual(marks(`const limit = 32;`, "typescript"), [
    "keyword:const",
    "punct:=",
    "number:32",
    "punct:;",
  ]);

  assert.deepEqual(marks(`return greet("world");`, "typescript"), [
    "keyword:return",
    "entity:greet",
    "punct:(",
    'string:"world"',
    "punct:);",
  ]);
});

test("a line comment swallows the rest of the line, including quotes", () => {
  assert.deepEqual(marks(`let x = 1; // it's fine`, "typescript"), [
    "keyword:let",
    "punct:=",
    "number:1",
    "punct:;",
    "comment:// it's fine",
  ]);
});

test("a block comment carries across lines and closes on its delimiter", () => {
  const opened = highlightLine("/* start", "typescript");
  assert.deepEqual(
    opened.tokens.map((token) => token.kind),
    ["comment"],
  );
  assert.equal(opened.state.pending, "*/");

  const middle = highlightLine("still comment", "typescript", opened.state);
  assert.equal(middle.state.pending, "*/");
  assert.deepEqual(middle.tokens, [
    { kind: "comment", start: 0, end: "still comment".length },
  ]);

  const closed = highlightLine("done */ const x = 1;", "typescript", middle.state);
  assert.equal(closed.state.pending, null);
  assert.deepEqual(
    closed.tokens.map((token) => token.kind),
    ["comment", "keyword", "punct", "number", "punct"],
  );
});

test("a template literal spans lines; an ordinary quote does not", () => {
  const template = highlightLine("const a = `one", "typescript");
  assert.equal(template.state.pending, "`");

  // An unterminated single-line quote must not bleed into the next line: in a
  // diff it is usually a line the hunk cut in half, and carrying it forward
  // would miscolour everything after it.
  const quote = highlightLine(`const a = "one`, "typescript");
  assert.equal(quote.state.pending, null);
});

test("an escaped quote does not end the string", () => {
  assert.deepEqual(marks(`"a\\"b" + 1`, "typescript"), [
    'string:"a\\"b"',
    "punct:+",
    "number:1",
  ]);
});

test("python triple-quoted strings span lines", () => {
  const opened = highlightLine('"""Turn a query into tokens.', "python");
  assert.equal(opened.state.pending, '"""');

  const closed = highlightLine('still docstring."""', "python", opened.state);
  assert.equal(closed.state.pending, null);
  assert.deepEqual(
    closed.tokens.map((token) => token.kind),
    ["string"],
  );
});

test("python decorators and defs read as keyword plus entity", () => {
  assert.deepEqual(marks("def tokenize(source: str) -> list[Token]:", "python"), [
    "keyword:def",
    "entity:tokenize",
    "punct:(",
    "punct::",
    "entity:str",
    "punct:)",
    "punct:->",
    "entity:list",
    "punct:[",
    "entity:Token",
    "punct:]:",
  ]);
});

test("builtin types read as types, not as literals", () => {
  // `None` is a value and `str` is a type; before they shared a set, which put
  // Python's whole builtin type vocabulary in the literal colour.
  assert.deepEqual(marks("x: str = None", "python"), [
    "punct::",
    "entity:str",
    "punct:=",
    "number:None",
  ]);

  assert.deepEqual(marks("let x: string = null;", "typescript"), [
    "keyword:let",
    "punct::",
    "entity:string",
    "punct:=",
    "number:null",
    "punct:;",
  ]);
});

test("shell variables are marked, braced or bare", () => {
  assert.deepEqual(marks(`rsync "$BUILD_DIR/" "\${TARGET}"`, "shell"), [
    'string:"$BUILD_DIR/"',
    'string:"${TARGET}"',
  ]);

  assert.deepEqual(marks("TARGET=${1:-staging}", "shell"), [
    "punct:=",
    "entity:${1:-staging}",
  ]);

  assert.deepEqual(marks("echo $HOME and $1", "shell"), [
    "entity:$HOME",
    "entity:$1",
  ]);
});

test("JSON keys are entities and its three literals are constants", () => {
  assert.deepEqual(marks(`  "name": "scratch",`, "json"), [
    'entity:"name"',
    "punct::",
    'string:"scratch"',
    "punct:,",
  ]);

  assert.deepEqual(marks(`  "telemetry": null`, "json"), [
    'entity:"telemetry"',
    "punct::",
    "number:null",
  ]);
});

test("YAML keys are entities and # starts a comment", () => {
  assert.deepEqual(marks("  runs-on: ubuntu-latest # the runner", "yaml"), [
    "entity:runs-on",
    "punct::",
    "punct:-",
    "comment:# the runner",
  ]);
});

test("shell keeps # a comment and knows its control words", () => {
  assert.deepEqual(marks("if [[ -n $x ]]; then # go", "shell"), [
    "keyword:if",
    "punct:[[",
    "punct:-",
    "entity:$x",
    "punct:]];",
    "keyword:then",
    "comment:# go",
  ]);
});

test("markup separates tag, attribute and value", () => {
  assert.deepEqual(marks(`<a href="/x" class='y'>text</a>`, "markup"), [
    "punct:<",
    "keyword:a",
    "entity:href",
    "punct:=",
    'string:"/x"',
    "entity:class",
    "punct:=",
    "string:'y'",
    "punct:>",
    "punct:</",
    "keyword:a",
    "punct:>",
  ]);
});

test("markup comments span lines", () => {
  const opened = highlightLine("<!-- note", "markup");
  assert.equal(opened.state.pending, "-->");

  const closed = highlightLine("still --> <b>", "markup", opened.state);
  assert.equal(closed.state.pending, null);
  assert.deepEqual(
    closed.tokens.map((token) => token.kind),
    ["comment", "punct", "keyword", "punct"],
  );
});

test("markdown marks headings, quotes, code spans and links", () => {
  assert.deepEqual(kindsOf("## Layout", "markdown"), ["keyword"]);
  assert.deepEqual(kindsOf("> Nothing here is load-bearing.", "markdown"), [
    "comment",
  ]);
  assert.deepEqual(marks("- `src/` is the code", "markdown"), [
    "punct:- ",
    "string:`src/`",
  ]);
  assert.deepEqual(marks("See [deploy](../deploy.sh) for more", "markdown"), [
    "entity:[deploy]",
    "string:(../deploy.sh)",
  ]);
});

test("a markdown fence toggles a plain block and closes again", () => {
  const open = highlightLine("```ts", "markdown");
  assert.equal(open.state.pending, "```");

  const inside = highlightLine("const x = 1; # not a comment", "markdown", open.state);
  assert.deepEqual(inside.tokens, []);
  assert.equal(inside.state.pending, "```");

  const close = highlightLine("```", "markdown", inside.state);
  assert.equal(close.state.pending, null);
});

test("highlightLines carries state down a document", () => {
  const lines = ["/* one", "two", "three */ const x = 1;"];
  const perLine = highlightLines(lines, "typescript");

  assert.deepEqual(perLine[0]?.map((token) => token.kind), ["comment"]);
  assert.deepEqual(perLine[1]?.map((token) => token.kind), ["comment"]);
  assert.deepEqual(perLine[2]?.map((token) => token.kind), [
    "comment",
    "keyword",
    "punct",
    "number",
    "punct",
  ]);
});

/*
 * The property that actually matters for correctness: whatever the tokenizer
 * decides, the rendered pieces must reconstruct the line exactly. A
 * highlighter that silently drops or duplicates a character is worse than one
 * that colours nothing, because the file viewer would be lying about the file.
 */
const RECONSTRUCTION_CASES: [LanguageId, string][] = [
  ["typescript", `export const greet = (name = "world") => \`Hello, \${name}!\`;`],
  ["typescript", `if (a<b && c>=d) { return /* mid */ 0x1f; } // tail`],
  ["typescript", `const re = "unterminated`],
  ["python", `def f(x): return {"a": 1, 'b': [2, 3]}  # note`],
  ["rust", `pub fn main() -> Result<(), Box<dyn Error>> { Ok(()) }`],
  ["go", "func main() {\tfmt.Println(`raw`)}"],
  ["css", `.panel:hover { box-shadow: 0 0 0 2px rgb(231 231 234 / 0.28); }`],
  ["json", `{"limits": {"participants": 32}, "ok": true}`],
  ["yaml", `  - uses: actions/checkout@v4 # pinned`],
  ["toml", `name = "scratch" # trailing`],
  ["shell", `rsync -az --delete "$BUILD_DIR/" "deploy@$TARGET:/srv/app/"`],
  ["sql", `SELECT id, name FROM t WHERE x = 'y' -- note`],
  ["markup", `<input type="text" disabled value='a > b' />`],
  ["markdown", `A [link](http://x) and \`code\` and **bold**.`],
  ["markdown", ""],
  ["typescript", ""],
  ["typescript", "   "],
  ["typescript", "\t\tconst\ta\t=\t1"],
  ["c", `#include <stdio.h> /* std */`],
  ["java", `public static void main(String[] args) throws Exception {}`],
  ["ruby", `attr_reader :name # exposed`],
];

test("pieces always reconstruct the original line, byte for byte", () => {
  for (const [language, line] of RECONSTRUCTION_CASES) {
    const { tokens } = highlightLine(line, language);
    const rebuilt = piecesFor(line, tokens)
      .map((piece) => piece.text)
      .join("");

    assert.equal(
      rebuilt,
      line,
      `${language} lost or duplicated text in: ${JSON.stringify(line)}`,
    );
  }
});

test("tokens are ordered, non-overlapping and inside the line", () => {
  for (const [language, line] of RECONSTRUCTION_CASES) {
    const { tokens } = highlightLine(line, language);
    let previousEnd = 0;

    for (const token of tokens) {
      assert.ok(
        token.start >= previousEnd,
        `${language}: token overlaps its predecessor in ${JSON.stringify(line)}`,
      );
      assert.ok(
        token.end > token.start,
        `${language}: empty token in ${JSON.stringify(line)}`,
      );
      assert.ok(
        token.end <= line.length,
        `${language}: token past end of ${JSON.stringify(line)}`,
      );
      previousEnd = token.end;
    }
  }
});

test("piecesFor survives a token list that is out of range", () => {
  const line = "abcdef";
  const rubbish: Token[] = [
    { kind: "string", start: -5, end: 2 },
    { kind: "keyword", start: 1, end: 4 },
    { kind: "number", start: 4, end: 99 },
  ];

  assert.equal(
    piecesFor(line, rubbish)
      .map((piece) => piece.text)
      .join(""),
    line,
  );
});

test("an empty line produces no pieces at all", () => {
  assert.deepEqual(piecesFor("", []), []);
});

test("a line with no tokens is one plain piece", () => {
  assert.deepEqual(piecesFor("plain text", []), [
    { kind: null, text: "plain text" },
  ]);
});

test("the initial state is not mutated by tokenizing", () => {
  highlightLine("/* open", "typescript", INITIAL_STATE);
  assert.deepEqual(INITIAL_STATE, { pending: null, pendingKind: "comment" });
});

/*
 * A budget check rather than a benchmark. The claim in code-view.tsx is that
 * tokenizing 4,000 lines is a few milliseconds; this fails loudly if that ever
 * stops being true by an order of magnitude, which is the point at which the
 * synchronous useMemo in the file viewer would become the wrong design.
 */
test("tokenizing 4,000 lines of TypeScript stays well inside a frame", () => {
  const lines = Array.from(
    { length: 4_000 },
    (_unused, index) =>
      `  { id: ${index}, name: "row-${index}", ok: ${index % 3 === 0}, /* c */ score: 0x${index.toString(16)} },`,
  );

  const started = performance.now();
  highlightLines(lines, "typescript");
  const elapsed = performance.now() - started;

  assert.ok(
    elapsed < 250,
    `tokenizing 4,000 lines took ${elapsed.toFixed(1)}ms, which is far past the few milliseconds the viewer's design assumes`,
  );
});
