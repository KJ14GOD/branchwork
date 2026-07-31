export { CompareView } from "./compare-view.tsx";

export {
  CodeLine,
  HIGHLIGHT_CHARACTER_LIMIT,
  HIGHLIGHT_LINE_LIMIT,
  shouldHighlight,
} from "./code-view.tsx";

export { highlightDiffLines, parseUnifiedDiff } from "./diff.ts";
export type { DiffLine, DiffLineKind, HighlightedDiffLine } from "./diff.ts";

export {
  highlightLine,
  highlightLines,
  INITIAL_STATE,
  languageForPath,
  piecesFor,
} from "./highlight.ts";
export type {
  HighlightState,
  LanguageId,
  Piece,
  Token,
  TokenKind,
} from "./highlight.ts";

export { DiffLines, DiffView } from "./diff-view.tsx";
export type { PatchProposalView } from "./diff-view.tsx";

export { EventRow } from "./event-row.tsx";
export type { EventRowProps } from "./event-row.tsx";

export { ToolResultPanel } from "./tool-result-panel.tsx";
export type { ToolPanels } from "./tool-result-panel.tsx";

export {
  describeWorkingTree,
  summariseCall,
  summariseToolResult,
} from "./tool-results.ts";
export type {
  GitStatusOutput,
  SummarisableToolResult,
  WorkingTreeReport,
} from "./tool-results.ts";
