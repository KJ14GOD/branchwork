import type { ToolCall } from "@novus/contracts";

/**
 * The three permission classes from V1_README.
 *
 * - read: repository search and file reads; allowed automatically.
 * - write: changes inside the selected repository; requires approval.
 * - dangerous: arbitrary commands, network, destructive Git; requires approval.
 */
export type ToolClass = "read" | "write" | "dangerous";

const TOOL_CLASSES: Record<ToolCall["name"], ToolClass> = {
  read_file: "read",
  search_repository: "read",
  // Proposing a patch computes a diff in memory and writes nothing.
  propose_patch: "read",
  // Proposing to create or delete a file writes nothing either — each returns
  // a reviewable proposal, and only apply_patch turns any proposal into a
  // change. Classifying the proposal step write would gate the preview, not
  // the write, and the write is the thing the class protects.
  propose_new_file: "read",
  propose_deletion: "read",
  // Still the only tool in the write class. Creation and deletion did not add
  // a second writer: they added new kinds of proposal, and every kind reaches
  // the working tree through this one gate.
  apply_patch: "write",
  // Executing anything is dangerous by definition: a command can write, delete,
  // or reach the network, and Novus cannot know which from the argument vector.
  run_command: "dangerous",
  // run_tests is dangerous for the same reason and not a milder case of it. A
  // test suite is arbitrary code that the repository chose, so classifying it
  // as read because it is *usually* harmless would be trusting the repository
  // to be benign — exactly the assumption the tool classes exist to avoid.
  run_tests: "dangerous",
  // A build script and a lint or typecheck script are the same thing a test
  // script is: arbitrary code the repository chose. run_diagnostics composes
  // its own argument vector and run_build's is nearly fixed, but what runs is
  // still the repository's code, and these classes judge what runs.
  run_build: "dangerous",
  run_diagnostics: "dangerous",
  // Starts an arbitrary program that then outlives the call. Dangerous for
  // run_command's reason plus one of its own: the process keeps executing
  // after the approval moment has passed. The status/logs/stop actions would
  // be read on their own, but the class is carried by the tool, not the
  // action — and a session that has not opted into running code has no
  // servers to inspect anyway.
  dev_server: "dangerous",
  // Reporting only. These read the repository and change nothing, so they are
  // allowed automatically like the other read tools — the agent should be able
  // to look at what it did without asking permission to look.
  list_directory: "read",
  git_status: "read",
  git_diff: "read",
  git_branches: "read",
  // Network, but read anyway, and the reasoning has to be explicit because
  // "network is dangerous" is the rule everywhere else. Dangerous means the
  // model could reach somewhere new or carry something out: this call takes no
  // arguments, asks one fixed question of the one endpoint the harness already
  // trusts with the entire conversation on every model call, and returns a
  // list of ids. There is no argument vector to abuse and nothing leaves that
  // was not already leaving.
  list_provider_models: "read",
};

export const classifyTool = (name: ToolCall["name"]): ToolClass =>
  TOOL_CLASSES[name];

export type ApprovalDecision =
  | { approved: true; approvedBy: string }
  | { approved: false; deniedBy: string; reason: string };

export type ApprovalRequest = {
  call: ToolCall;
  toolClass: Exclude<ToolClass, "read">;
};

export interface ApprovalGate {
  review(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * The default when a host configures no gate.
 *
 * V1_README requires that a dangerous action is approved or denied — never
 * silently allowed — so the absence of a gate must deny rather than permit.
 */
export class DenyAllApprovalGate implements ApprovalGate {
  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      approved: false,
      deniedBy: "policy",
      reason: `${request.call.name} needs ${request.toolClass} approval, but no approval gate is configured for this session.`,
    };
  }
}

/**
 * Approves a fixed set of tools without asking a human.
 *
 * For tests and headless runs where the operator has pre-authorised the tools
 * up front. A human-facing gate replaces this without touching the runner.
 */
export class AllowListApprovalGate implements ApprovalGate {
  private readonly allowed: ReadonlySet<ToolCall["name"]>;
  private readonly actorId: string;

  constructor(allowed: readonly ToolCall["name"][], actorId = "policy") {
    this.allowed = new Set(allowed);
    this.actorId = actorId;
  }

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.allowed.has(request.call.name)) {
      return { approved: true, approvedBy: this.actorId };
    }

    return {
      approved: false,
      deniedBy: this.actorId,
      reason: `${request.call.name} is not in this session's allow list.`,
    };
  }
}
