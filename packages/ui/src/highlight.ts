/**
 * Syntax highlighting, line by line, with no dependencies.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN A LIBRARY
 *
 * Novus needs highlighting in two places whose shapes disagree: the Browse
 * viewer holds a whole file, and a diff holds *isolated lines* that have been
 * stripped of their `+`/`-` marker and pulled out of any surrounding context.
 *
 * Every mainstream highlighter — highlight.js, Prism, Shiki — is a
 * whole-document API. Handed one line of a hunk it has no file to parse, and
 * handed a whole diff it sees `+`/`-` prefixes rather than source. Making
 * either work on a diff means re-deriving the original file, which the diff
 * does not contain. So the shape this app actually needs is the *streaming
 * line tokenizer* CodeMirror 5's mode API had: tokenize one line, hand back a
 * small state, feed that state to the next line. That serves both callers, and
 * it is what is implemented here.
 *
 * The cost side agrees. Shiki carries a multi-megabyte oniguruma WASM build
 * plus TextMate grammars; highlight.js core with a useful language set is
 * ~90KB minified and still cannot do the diff case. This file is a few
 * kilobytes and no install.
 *
 * WHAT IT IS NOT
 *
 * It is a *reader's* highlighter, not a parser. It knows nothing about scope,
 * types, or whether a program is valid. Known approximations, stated rather
 * than discovered:
 *
 *   - A `/` is treated as punctuation, never as the start of a regex literal,
 *     so `/[a-z]"/ ` will open a string. Distinguishing the two needs the
 *     preceding expression's grammar.
 *   - Nested template-literal interpolation (`` `${`inner`}` ``) is read as
 *     one string.
 *   - `<script>` and `<style>` bodies inside HTML stay markup, not JS/CSS.
 *   - A fenced code block in Markdown is not re-tokenized in its own language.
 *
 * All four are wrong in the direction of "less colour than deserved", never
 * "wrong colour on the rest of the file": the state machine always closes on
 * the delimiter it is waiting for.
 *
 * PERFORMANCE
 *
 * One left-to-right pass per line. The only regexes are anchored with `y`
 * (sticky) at a known offset, so there is no scanning and no backtracking.
 * Tokens are emitted as `{start, end}` offsets and only for the *non-plain*
 * runs, so a line of ordinary code allocates a handful of small objects and
 * the renderer fills the gaps with raw text nodes — that keeps the DOM node
 * count near the number of coloured runs rather than near the character count.
 */

export type TokenKind =
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "entity"
  | "punct";

/** A coloured run within one line. Plain text is the gaps between these. */
export type Token = {
  kind: TokenKind;
  /** Offset into the line, inclusive. */
  start: number;
  /** Offset into the line, exclusive. */
  end: number;
};

/**
 * What one line hands the next.
 *
 * `pending` is the delimiter an unterminated construct is waiting for; a line
 * that opens a block comment hands `"* /"` (without the space) to the line
 * after it. `null` means the line ended cleanly.
 */
export type HighlightState = {
  readonly pending: string | null;
  readonly pendingKind: TokenKind;
};

export const INITIAL_STATE: HighlightState = {
  pending: null,
  pendingKind: "comment",
};

type Pair = readonly [open: string, close: string];

type Grammar = {
  /** Comment-to-end-of-line starters. */
  readonly lineComment: readonly string[];
  /** Comment delimiters that may span lines. */
  readonly blockComment: readonly Pair[];
  /** String delimiters that may span lines. Checked before `quotes`. */
  readonly longStrings: readonly Pair[];
  /** String delimiters that end at the line break if unterminated. */
  readonly quotes: readonly string[];
  /** Whether a backslash escapes the next character inside a string. */
  readonly escapes: boolean;
  readonly keywords: ReadonlySet<string>;
  /** Literal-ish words — true, false, null, self, and friends. */
  readonly constants: ReadonlySet<string>;
  /**
   * Built-in type names.
   *
   * Kept apart from `constants` because they are not literals: `str` in
   * `x: str` names a type and belongs with the other type names on screen,
   * while `None` is a value. Collapsing the two put Python's whole builtin
   * type vocabulary in the literal colour, which is what the test caught.
   */
  readonly types: ReadonlySet<string>;
  /** Colour `name(` as an entity. */
  readonly callEntities: boolean;
  /** Colour a Capitalised word as an entity (a type, by convention). */
  readonly capitalEntities: boolean;
  /** Colour `word:` at the head of a line as an entity (JSON, YAML, TOML). */
  readonly keyEntities: boolean;
  /**
   * The sigil that introduces a variable reference, when the language has one.
   *
   * Shell without this is the case that made it necessary: `$BUILD_DIR` fell
   * through every branch and rendered plain, so a script's variables — the
   * one thing you scan a shell script for — were the only thing not marked.
   */
  readonly variableSigil: string | null;
};

const words = (source: string): ReadonlySet<string> =>
  new Set(source.split(/\s+/).filter(Boolean));

const NONE: ReadonlySet<string> = new Set();

// Sticky, so every match is anchored at the cursor and the engine never scans.
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER =
  /0[xXbBoO][0-9a-fA-F_]+n?|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?n?/y;
const WHITESPACE = /[ \t]+/y;
const PUNCTUATION = /[-+*/%=<>!&|^~?:;,.(){}\[\]@#\\]+/y;

/** Every field a grammar must set, so each entry below states only what differs. */
const BASE: Grammar = {
  lineComment: [],
  blockComment: [],
  longStrings: [],
  quotes: ['"', "'"],
  escapes: true,
  keywords: NONE,
  constants: NONE,
  types: NONE,
  callEntities: false,
  capitalEntities: false,
  keyEntities: false,
  variableSigil: null,
};

const C_FAMILY: Grammar = {
  ...BASE,
  lineComment: ["//"],
  blockComment: [["/*", "*/"]],
  callEntities: true,
};

const GRAMMARS = {
  typescript: {
    ...C_FAMILY,
    longStrings: [["`", "`"]],
    capitalEntities: true,
    keywords: words(`
      abstract as async await break case catch class const continue debugger
      declare default delete do else enum export extends finally for from
      function get if implements import in infer instanceof interface is keyof
      let new of package private protected public readonly return satisfies set
      static super switch symbol this throw try type typeof var void while with
      yield namespace module asserts override accessor using
    `),
    constants: words("true false null undefined NaN Infinity"),
    types: words(`
      any unknown never string number boolean object bigint void symbol
    `),
  },
  rust: {
    ...C_FAMILY,
    longStrings: [['r#"', '"#']],
    capitalEntities: true,
    keywords: words(`
      as async await break const continue crate dyn else enum extern fn for if
      impl in let loop match mod move mut pub ref return self Self static struct
      super trait type unsafe use where while macro_rules union
    `),
    constants: words("true false None Some Ok Err"),
    types: words(`
      i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str
      String Vec Option Result Box
    `),
  },
  go: {
    ...C_FAMILY,
    longStrings: [["`", "`"]],
    keywords: words(`
      break case chan const continue default defer else fallthrough for func go
      goto if import interface map package range return select struct switch type
      var
    `),
    constants: words("true false nil iota"),
    types: words(`
      int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32
      float64 complex64 complex128 string bool byte rune error any
    `),
  },
  java: {
    ...C_FAMILY,
    capitalEntities: true,
    keywords: words(`
      abstract assert break case catch class const continue default do else enum
      extends final finally for goto if implements import instanceof interface
      native new package private protected public return static strictfp super
      switch synchronized this throw throws transient try volatile while var
      record sealed permits yield fun val suspend override internal
    `),
    constants: words("true false null nil"),
    types: words("boolean byte char double float int long short void String Int"),
  },
  c: {
    ...C_FAMILY,
    keywords: words(`
      alignas alignof auto break case catch class const constexpr continue
      decltype default delete do else enum explicit extern for friend goto if
      inline namespace new noexcept operator private protected public register
      return sizeof static struct switch template this throw try typedef typename
      union unsigned signed using virtual volatile while
    `),
    constants: words("true false NULL nullptr"),
    types: words(`
      bool char double float int long short void size_t uint8_t uint16_t
      uint32_t uint64_t int8_t int16_t int32_t int64_t FILE
    `),
  },
  python: {
    ...BASE,
    lineComment: ["#"],
    longStrings: [
      ['"""', '"""'],
      ["'''", "'''"],
    ],
    callEntities: true,
    capitalEntities: true,
    keywords: words(`
      and as assert async await break class continue def del elif else except
      finally for from global if import in is lambda match case nonlocal not or
      pass raise return try while with yield
    `),
    constants: words("True False None self cls NotImplemented Ellipsis"),
    types: words(`
      int str float bool list dict set tuple bytes bytearray complex frozenset
      object type
    `),
  },
  ruby: {
    ...BASE,
    lineComment: ["#"],
    blockComment: [["=begin", "=end"]],
    callEntities: true,
    capitalEntities: true,
    keywords: words(`
      alias and begin break case class def defined do else elsif end ensure for
      if in module next not or redo rescue retry return self super then undef
      unless until when while yield require require_relative attr_accessor
      attr_reader attr_writer
    `),
    constants: words("true false nil __FILE__ __LINE__"),
    variableSigil: "@",
  },
  shell: {
    ...BASE,
    lineComment: ["#"],
    keywords: words(`
      if then else elif fi for while until do done case esac in function select
      return break continue local export readonly declare typeset source exit
      trap shift set unset eval exec
    `),
    constants: words("true false"),
    variableSigil: "$",
  },
  css: {
    ...BASE,
    blockComment: [["/*", "*/"]],
    callEntities: true,
    keywords: words(`
      important media supports keyframes import charset font-face namespace
      layer container property page from to and not only or
    `),
    constants: words("inherit initial unset revert none auto currentColor transparent"),
  },
  json: {
    ...BASE,
    quotes: ['"'],
    keyEntities: true,
    constants: words("true false null"),
  },
  yaml: {
    ...BASE,
    lineComment: ["#"],
    keyEntities: true,
    constants: words("true false null yes no on off"),
  },
  toml: {
    ...BASE,
    lineComment: ["#"],
    longStrings: [
      ['"""', '"""'],
      ["'''", "'''"],
    ],
    keyEntities: true,
    constants: words("true false"),
  },
  sql: {
    ...BASE,
    lineComment: ["--"],
    blockComment: [["/*", "*/"]],
    quotes: ["'", '"'],
    escapes: false,
    callEntities: true,
    keywords: words(`
      add all alter and as asc begin between by case cast column commit
      constraint create cross delete desc distinct drop else end exists foreign
      from full group having if in index inner insert intersect into is join key
      left like limit not null offset on or order outer primary references
      returning right rollback select set table then union unique update using
      values view when where with
    `),
    constants: words("true false null"),
    types: words("integer text real blob varchar boolean timestamp uuid jsonb"),
  },
} as const satisfies Record<string, Grammar>;

export type LanguageId = keyof typeof GRAMMARS | "markup" | "markdown";

/**
 * Which grammar a path gets, or null for "render it plain".
 *
 * Null is a real answer and the honest default: a viewer that guesses at an
 * unknown format and colours half of it wrong is worse than one that shows it
 * as text.
 */
export const languageForPath = (path: string): LanguageId | null => {
  const name = path.split("/").at(-1) ?? path;
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? (lower.split(".").at(-1) ?? "") : "";

  // Extension-less files that are nonetheless a known format.
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "shell";
  if (lower === "makefile" || lower === "gnumakefile") return "shell";
  if (lower === ".gitignore" || lower === ".npmrc" || lower === ".editorconfig") {
    return "shell";
  }
  if (lower.startsWith(".env")) return "shell";

  switch (extension) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "typescript";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
    case "kt":
    case "kts":
    case "scala":
    case "cs":
    case "swift":
    case "dart":
      return "java";
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
    case "m":
    case "mm":
      return "c";
    case "py":
    case "pyi":
      return "python";
    case "rb":
    case "gemspec":
    case "rake":
      return "ruby";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "bat":
      return "shell";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "json":
    case "jsonc":
    case "json5":
    case "webmanifest":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "sql":
      return "sql";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "vue":
    case "xhtml":
    case "plist":
      return "markup";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    default:
      return null;
  }
};

/** True when the character cannot be part of an identifier. */
const isBoundary = (line: string, index: number): boolean => {
  if (index < 0 || index >= line.length) {
    return true;
  }

  const code = line.charCodeAt(index);

  return !(
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
};

const matchAt = (
  pattern: RegExp,
  line: string,
  index: number,
): string | null => {
  pattern.lastIndex = index;

  return pattern.exec(line)?.[0] ?? null;
};

/**
 * Scan forward for `close`, honouring escapes, and emit one token.
 *
 * Returns where the cursor lands and whether the construct is still open —
 * the caller turns "still open" into the state the next line starts from.
 */
const consumeUntil = (
  line: string,
  from: number,
  close: string,
  kind: TokenKind,
  escapes: boolean,
  tokens: Token[],
): { next: number; open: boolean } => {
  let index = from;

  while (index < line.length) {
    if (escapes && line[index] === "\\") {
      index += 2;
      continue;
    }

    if (line.startsWith(close, index)) {
      const end = index + close.length;
      tokens.push({ kind, start: from, end });

      return { next: end, open: false };
    }

    index += 1;
  }

  tokens.push({ kind, start: from, end: line.length });

  return { next: line.length, open: true };
};

const tokenizeCode = (
  line: string,
  grammar: Grammar,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } => {
  const tokens: Token[] = [];
  let index = 0;

  // Finish whatever the previous line left open before reading anything else.
  if (state.pending !== null) {
    const resumed = consumeUntil(
      line,
      0,
      state.pending,
      state.pendingKind,
      // A block comment does not honour backslash escapes; a long string does.
      state.pendingKind === "string" && grammar.escapes,
      tokens,
    );

    if (resumed.open) {
      return { tokens, state };
    }

    index = resumed.next;
  }

  // `word:` at the head of a line is a key in the data formats.
  if (grammar.keyEntities) {
    const indent = matchAt(WHITESPACE, line, index) ?? "";
    const keyStart = index + indent.length;

    if (line[keyStart] === '"') {
      const probe: Token[] = [];
      const quoted = consumeUntil(line, keyStart + 1, '"', "string", true, probe);

      if (!quoted.open && line[quoted.next] === ":") {
        tokens.push({ kind: "entity", start: keyStart, end: quoted.next });
        index = quoted.next;
      }
    } else {
      const bare = matchAt(/[A-Za-z_][\w.-]*/y, line, keyStart);

      if (bare !== null && line[keyStart + bare.length] === ":") {
        tokens.push({
          kind: "entity",
          start: keyStart,
          end: keyStart + bare.length,
        });
        index = keyStart + bare.length;
      }
    }
  }

  while (index < line.length) {
    const character = line[index]!;

    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }

    const lineComment = grammar.lineComment.find((marker) =>
      line.startsWith(marker, index),
    );

    if (lineComment !== undefined) {
      tokens.push({ kind: "comment", start: index, end: line.length });
      break;
    }

    const block = grammar.blockComment.find(([open]) =>
      line.startsWith(open, index),
    );

    if (block !== undefined) {
      const consumed = consumeUntil(
        line,
        index + block[0].length,
        block[1],
        "comment",
        false,
        tokens,
      );
      // Rewrite the token to include the opening delimiter.
      tokens[tokens.length - 1]!.start = index;
      index = consumed.next;

      if (consumed.open) {
        return {
          tokens,
          state: { pending: block[1], pendingKind: "comment" },
        };
      }

      continue;
    }

    const long = grammar.longStrings.find(([open]) =>
      line.startsWith(open, index),
    );

    if (long !== undefined) {
      const consumed = consumeUntil(
        line,
        index + long[0].length,
        long[1],
        "string",
        grammar.escapes,
        tokens,
      );
      tokens[tokens.length - 1]!.start = index;
      index = consumed.next;

      if (consumed.open) {
        return { tokens, state: { pending: long[1], pendingKind: "string" } };
      }

      continue;
    }

    if (grammar.quotes.includes(character)) {
      const consumed = consumeUntil(
        line,
        index + 1,
        character,
        "string",
        grammar.escapes,
        tokens,
      );
      tokens[tokens.length - 1]!.start = index;
      // An unterminated single-line quote ends at the line break rather than
      // bleeding into the next line: in practice it is a quote inside prose or
      // a line the diff cut in half, and carrying it forward miscolours
      // everything after it.
      index = consumed.next;
      continue;
    }

    // `$NAME`, `${NAME}`, `@name` — read before identifiers, because `$` is
    // itself an identifier character in the C-family pattern.
    if (grammar.variableSigil !== null && character === grammar.variableSigil) {
      const braced = line[index + 1] === "{";
      const close = braced ? line.indexOf("}", index) : -1;

      if (braced && close !== -1) {
        tokens.push({ kind: "entity", start: index, end: close + 1 });
        index = close + 1;
        continue;
      }

      const name = matchAt(/[A-Za-z_][A-Za-z0-9_]*|[0-9@*?#!$]/y, line, index + 1);

      if (name !== null) {
        tokens.push({
          kind: "entity",
          start: index,
          end: index + 1 + name.length,
        });
        index += 1 + name.length;
        continue;
      }
    }

    const number = isBoundary(line, index - 1)
      ? matchAt(NUMBER, line, index)
      : null;

    if (number !== null && number.length > 0) {
      tokens.push({ kind: "number", start: index, end: index + number.length });
      index += number.length;
      continue;
    }

    const identifier = matchAt(IDENTIFIER, line, index);

    if (identifier !== null) {
      const end = index + identifier.length;
      let kind: TokenKind | null = null;

      if (grammar.keywords.has(identifier)) {
        kind = "keyword";
      } else if (grammar.constants.has(identifier)) {
        kind = "number";
      } else if (grammar.types.has(identifier)) {
        kind = "entity";
      } else if (grammar.callEntities && line[end] === "(") {
        kind = "entity";
      } else if (
        grammar.capitalEntities &&
        identifier[0] === identifier[0]?.toUpperCase() &&
        identifier[0] !== identifier[0]?.toLowerCase()
      ) {
        kind = "entity";
      }

      if (kind !== null) {
        tokens.push({ kind, start: index, end });
      }

      index = end;
      continue;
    }

    const punctuation = matchAt(PUNCTUATION, line, index);

    if (punctuation !== null) {
      tokens.push({
        kind: "punct",
        start: index,
        end: index + punctuation.length,
      });
      index += punctuation.length;
      continue;
    }

    index += 1;
  }

  return { tokens, state: INITIAL_STATE };
};

const MARKUP_COMMENT: Pair = ["<!--", "-->"];

const tokenizeMarkup = (
  line: string,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } => {
  const tokens: Token[] = [];
  let index = 0;

  if (state.pending !== null) {
    const resumed = consumeUntil(
      line,
      0,
      state.pending,
      state.pendingKind,
      false,
      tokens,
    );

    if (resumed.open) {
      return { tokens, state };
    }

    index = resumed.next;
  }

  while (index < line.length) {
    if (line.startsWith(MARKUP_COMMENT[0], index)) {
      const consumed = consumeUntil(
        line,
        index + MARKUP_COMMENT[0].length,
        MARKUP_COMMENT[1],
        "comment",
        false,
        tokens,
      );
      tokens[tokens.length - 1]!.start = index;
      index = consumed.next;

      if (consumed.open) {
        return {
          tokens,
          state: { pending: MARKUP_COMMENT[1], pendingKind: "comment" },
        };
      }

      continue;
    }

    if (line[index] === "<") {
      const openLength = line.startsWith("</", index) ? 2 : 1;
      const name = matchAt(/[A-Za-z_][\w:.-]*/y, line, index + openLength);

      tokens.push({ kind: "punct", start: index, end: index + openLength });
      index += openLength;

      if (name !== null) {
        tokens.push({ kind: "keyword", start: index, end: index + name.length });
        index += name.length;
      }

      // Attributes, up to the tag's own close.
      while (index < line.length && line[index] !== ">") {
        if (line[index] === " " || line[index] === "\t") {
          index += 1;
          continue;
        }

        if (line[index] === '"' || line[index] === "'") {
          const quote = line[index]!;
          const consumed = consumeUntil(
            line,
            index + 1,
            quote,
            "string",
            false,
            tokens,
          );
          tokens[tokens.length - 1]!.start = index;
          index = consumed.next;
          continue;
        }

        const attribute = matchAt(/[A-Za-z_@:][\w:.-]*/y, line, index);

        if (attribute !== null) {
          tokens.push({
            kind: "entity",
            start: index,
            end: index + attribute.length,
          });
          index += attribute.length;
          continue;
        }

        tokens.push({ kind: "punct", start: index, end: index + 1 });
        index += 1;
      }

      if (line[index] === ">") {
        tokens.push({ kind: "punct", start: index, end: index + 1 });
        index += 1;
      }

      continue;
    }

    index += 1;
  }

  return { tokens, state: INITIAL_STATE };
};

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const QUOTE = /^\s{0,3}>/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s/y;

const tokenizeMarkdown = (
  line: string,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } => {
  const tokens: Token[] = [];

  // A fence toggles "inside a code block", carried in the same state field.
  if (FENCE.test(line)) {
    tokens.push({ kind: "punct", start: 0, end: line.length });

    return {
      tokens,
      state:
        state.pending === "```"
          ? INITIAL_STATE
          : { pending: "```", pendingKind: "string" },
    };
  }

  if (state.pending === "```") {
    // Inside a fence. Left plain deliberately — see the header comment; the
    // fence's own language is not re-tokenized.
    return { tokens, state };
  }

  if (HEADING.test(line)) {
    tokens.push({ kind: "keyword", start: 0, end: line.length });

    return { tokens, state: INITIAL_STATE };
  }

  if (QUOTE.test(line)) {
    tokens.push({ kind: "comment", start: 0, end: line.length });

    return { tokens, state: INITIAL_STATE };
  }

  let index = 0;
  const bullet = matchAt(BULLET, line, 0);

  if (bullet !== null) {
    tokens.push({ kind: "punct", start: 0, end: bullet.length });
    index = bullet.length;
  }

  while (index < line.length) {
    if (line[index] === "`") {
      const consumed = consumeUntil(line, index + 1, "`", "string", false, tokens);
      tokens[tokens.length - 1]!.start = index;
      index = consumed.next;
      continue;
    }

    if (line[index] === "[") {
      const close = line.indexOf("]", index);

      if (close !== -1) {
        tokens.push({ kind: "entity", start: index, end: close + 1 });
        index = close + 1;

        if (line[index] === "(") {
          const paren = line.indexOf(")", index);
          const end = paren === -1 ? line.length : paren + 1;
          tokens.push({ kind: "string", start: index, end });
          index = end;
        }

        continue;
      }
    }

    index += 1;
  }

  return { tokens, state: INITIAL_STATE };
};

/** Tokenize one line, given what the line before it left open. */
export const highlightLine = (
  line: string,
  language: LanguageId,
  state: HighlightState = INITIAL_STATE,
): { tokens: Token[]; state: HighlightState } => {
  if (language === "markup") {
    return tokenizeMarkup(line, state);
  }

  if (language === "markdown") {
    return tokenizeMarkdown(line, state);
  }

  return tokenizeCode(line, GRAMMARS[language], state);
};

/**
 * Tokenize a whole document, carrying state down the lines.
 *
 * Returns one token list per line, parallel to `lines`.
 */
export const highlightLines = (
  lines: readonly string[],
  language: LanguageId,
): Token[][] => {
  const result: Token[][] = [];
  let state = INITIAL_STATE;

  for (const line of lines) {
    const next = highlightLine(line, language, state);
    result.push(next.tokens);
    state = next.state;
  }

  return result;
};

/**
 * The renderable pieces of one line: coloured runs and the plain gaps between
 * them, in order, with no gaps and no overlaps.
 *
 * Callers render this directly; it exists so both the file viewer and the diff
 * agree on how a token list becomes spans, and so the "plain text is a gap"
 * optimisation is written once.
 */
export type Piece = { kind: TokenKind | null; text: string };

export const piecesFor = (line: string, tokens: readonly Token[]): Piece[] => {
  if (tokens.length === 0) {
    return line.length === 0 ? [] : [{ kind: null, text: line }];
  }

  const pieces: Piece[] = [];
  let cursor = 0;

  for (const token of tokens) {
    // Defensive: a malformed token list must never drop or duplicate text.
    const start = Math.max(cursor, token.start);
    const end = Math.max(start, Math.min(line.length, token.end));

    if (start > cursor) {
      pieces.push({ kind: null, text: line.slice(cursor, start) });
    }

    if (end > start) {
      pieces.push({ kind: token.kind, text: line.slice(start, end) });
    }

    cursor = Math.max(cursor, end);
  }

  if (cursor < line.length) {
    pieces.push({ kind: null, text: line.slice(cursor) });
  }

  return pieces;
};
