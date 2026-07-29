export { parseUnifiedDiff } from "./diff.ts";
export type { DiffLine, DiffLineKind } from "./diff.ts";

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
