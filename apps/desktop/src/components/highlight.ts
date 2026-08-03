/**
 * Syntax highlighting as *tokens*, never as markup (D-048).
 *
 * Every highlighter worth using returns an HTML string, which would mean
 * `dangerouslySetInnerHTML` over repository content — the exact thing the
 * markdown renderer refuses, and for the same reason: a file in the worktree
 * can be written by a harness turn with nobody reading it first, and this
 * window holds the bridge. So this returns spans for React to render, and the
 * worst a malicious file can do is look wrong.
 *
 * Deliberately one lexer rather than a grammar per language. Comments, strings,
 * numbers, keywords, types, and calls are what the eye actually uses to find
 * its way down a file, and they look almost the same in every language a
 * project contains. A per-language grammar buys correctness on the edges —
 * a regex literal here, an f-string there — at the cost of a dependency and a
 * maintenance surface, and this is a reading pane rather than an editor.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "call"
  | "punctuation";

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Shared across the C-like family, plus the words Python and Ruby add. One
 *  list: a keyword highlighted in a language that does not have it is a
 *  cosmetic error, and a missing one is invisible. */
const KEYWORDS = new Set([
  "abstract", "and", "as", "assert", "async", "await", "break", "case", "catch", "class", "const",
  "constructor", "continue", "debugger", "declare", "def", "default", "del", "delete", "do", "elif",
  "else", "elsif", "end", "enum", "except", "export", "extends", "false", "finally", "fn", "for",
  "from", "func", "function", "get", "global", "if", "impl", "implements", "import", "in", "instanceof",
  "interface", "is", "lambda", "let", "match", "mod", "module", "mut", "new", "nil", "none", "not",
  "null", "or", "package", "pass", "private", "protected", "pub", "public", "raise", "readonly",
  "require", "return", "satisfies", "self", "set", "static", "struct", "super", "switch", "then",
  "this", "throw", "trait", "true", "try", "type", "typeof", "undefined", "unless", "until", "use",
  "var", "void", "when", "while", "with", "yield"
]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER = /[A-Za-z0-9_$]/;
const PUNCTUATION = new Set([..."{}()[];,.:?!<>=+-*/%&|^~"]);

/** Languages whose line comment is `#` rather than `//`. */
const HASH_COMMENT = new Set(["py", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml", "conf", "cfg", "env", "rs"]);

/**
 * One pass, character at a time.
 *
 * Written as a loop rather than a set of regexes over the whole file because a
 * 60 KB source with a dozen alternating patterns is where a regex-based
 * highlighter starts backtracking, and a pane that locks the window while a
 * person opens a file is worse than one with no colour at all.
 */
export function tokenize(source: string, extension: string): Token[] {
  const hashComments = HASH_COMMENT.has(extension.toLowerCase());
  const tokens: Token[] = [];
  let plain = "";
  let index = 0;

  const flush = (): void => {
    if (plain !== "") {
      tokens.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  const push = (kind: TokenKind, text: string): void => {
    flush();
    tokens.push({ kind, text });
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    // Comments.
    if (character === "/" && next === "/" && !hashComments) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      push("comment", source.slice(index, stop));
      index = stop;
      continue;
    }
    if (character === "#" && hashComments) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      push("comment", source.slice(index, stop));
      index = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      push("comment", source.slice(index, stop));
      index = stop;
      continue;
    }

    // Strings, including the triple-quoted kind Python opens a file with.
    if (character === '"' || character === "'" || character === "`") {
      const triple = source.slice(index, index + 3);
      if (triple === '"""' || triple === "'''") {
        const end = source.indexOf(triple, index + 3);
        const stop = end === -1 ? source.length : end + 3;
        push("string", source.slice(index, stop));
        index = stop;
        continue;
      }
      let cursor = index + 1;
      while (cursor < source.length) {
        const at = source[cursor];
        if (at === "\\") {
          cursor += 2;
          continue;
        }
        if (at === character) {
          cursor += 1;
          break;
        }
        // An unterminated quote ends at the line, so one stray apostrophe in a
        // comment cannot tint the rest of the file.
        if (at === "\n" && character !== "`") break;
        cursor += 1;
      }
      push("string", source.slice(index, cursor));
      index = cursor;
      continue;
    }

    // Numbers.
    if (/[0-9]/.test(character) && !IDENTIFIER.test(source[index - 1] ?? " ")) {
      let cursor = index;
      while (cursor < source.length && /[0-9a-fA-FxX._]/.test(source[cursor] ?? "")) cursor += 1;
      push("number", source.slice(index, cursor));
      index = cursor;
      continue;
    }

    // Words: a keyword, a type, a call, or nothing in particular.
    if (IDENTIFIER_START.test(character)) {
      let cursor = index;
      while (cursor < source.length && IDENTIFIER.test(source[cursor] ?? "")) cursor += 1;
      const word = source.slice(index, cursor);
      let after = cursor;
      while (after < source.length && (source[after] === " " || source[after] === "\t")) after += 1;

      if (KEYWORDS.has(word)) push("keyword", word);
      else if (source[after] === "(") push("call", word);
      else if (/^[A-Z]/.test(word)) push("type", word);
      else plain += word;
      index = cursor;
      continue;
    }

    if (PUNCTUATION.has(character)) {
      push("punctuation", character);
      index += 1;
      continue;
    }

    plain += character;
    index += 1;
  }

  flush();
  return tokens;
}

/** Tokens split at newlines, so a pane can number its lines without the
 *  numbers and the code drifting apart on a wrapped one. */
export function tokenizeLines(source: string, extension: string): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokenize(source, extension)) {
    const pieces = token.text.split("\n");
    pieces.forEach((piece, at) => {
      if (at > 0) lines.push([]);
      if (piece !== "") (lines[lines.length - 1] as Token[]).push({ kind: token.kind, text: piece });
    });
  }
  return lines;
}
