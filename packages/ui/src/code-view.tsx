/**
 * Highlighted code, drawn the one way both surfaces draw it.
 *
 * `CodeLine` is the whole component: one line, already tokenized. The file
 * viewer maps it over a document; the diff maps it over the lines of a hunk.
 * Neither one owns a second way of turning tokens into spans.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not virtualize. `HIGHLIGHT_LINE_LIMIT` below is the answer instead,
 * and it is the honest one for a *read-only* viewer: past the limit the file
 * is rendered as one plain `<pre>` text node, which the browser handles at any
 * size, and the viewer says so on screen. Windowing a read-only file view buys
 * nothing a limit does not, and costs scroll-position and find-in-page
 * correctness.
 *
 * The class names are `hl-*` and are styled only in
 * `apps/desktop/src/styles.css`. `apps/guest` shares this package's markup but
 * not its stylesheet, so an unstyled `hl-*` span there renders as plain text —
 * exactly what the guest shows today. That degradation is why highlighting
 * could land here at all without touching the guest.
 */

import { piecesFor, type Piece, type Token } from "./highlight.ts";

/**
 * Above this many lines a file is shown unhighlighted.
 *
 * Measured on this repository's own files rather than guessed
 * (`highlightLines`, warm, Node 24 on an M-series Mac):
 *
 *   session-tab.tsx     916 lines,  32KB  ts    1.5ms
 *   contracts.ts      1,376 lines,  47KB  ts    1.0ms
 *   pnpm-lock.yaml    1,875 lines,  60KB  yaml  2.0ms
 *   styles.css        2,918 lines,  73KB  css   3.4ms
 *   generated fixture 6,004 lines, 355KB  ts   30.4ms
 *
 * So real source costs roughly 1-2ms per thousand lines and the limit below
 * buys about 8ms of tokenizing worst case — comfortably inside one frame, and
 * why the file viewer can memoize this synchronously instead of scheduling it.
 *
 * The cost that actually decides the limit is the DOM, not the tokenizer:
 * highlighting turns one text node into an element per line plus one per
 * coloured run. 4,000 lines is past every hand-written source file in this
 * repository, and the one fixture above it is generated data nobody reads.
 */
export const HIGHLIGHT_LINE_LIMIT = 4_000;

/**
 * And above this many characters, regardless of line count — one 200,000
 * character line is a minified bundle, and tokenizing it is unbounded work for
 * a line nobody can read anyway.
 */
export const HIGHLIGHT_CHARACTER_LIMIT = 400_000;

export const shouldHighlight = (content: string, lineCount: number): boolean =>
  lineCount <= HIGHLIGHT_LINE_LIMIT &&
  content.length <= HIGHLIGHT_CHARACTER_LIMIT;

const pieceClass = (piece: Piece): string | undefined =>
  piece.kind === null ? undefined : `hl-${piece.kind}`;

/**
 * One line of code as spans.
 *
 * Plain runs render as bare strings rather than wrapped in a span, so an
 * ordinary line of code costs about as many DOM nodes as it has coloured runs
 * — not one per character and not one per word.
 */
export const CodeLine = ({
  text,
  tokens,
}: {
  text: string;
  tokens: readonly Token[];
}) => {
  const pieces = piecesFor(text, tokens);

  return (
    <>
      {pieces.map((piece, index) => {
        const className = pieceClass(piece);

        return className === undefined ? (
          piece.text
        ) : (
          <span className={className} key={index}>
            {piece.text}
          </span>
        );
      })}
    </>
  );
};
