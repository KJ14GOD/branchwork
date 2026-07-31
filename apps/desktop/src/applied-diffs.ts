import type { SessionEvent } from "@novus/contracts";
import type { PatchProposalView } from "@novus/ui";

/**
 * The diff behind each file the session actually changed.
 *
 * The changed-files panel used to report that a file changed and stop there,
 * which is the wrong half of the job: choosing between attempts "on the
 * evidence" is this product's whole thesis, and a path with a +/- count is
 * not evidence, it is a claim about evidence.
 *
 * Nothing new is fetched to fix that. An `apply_patch` result carries the
 * `patchId` it applied but not the text; the `propose_*` result that minted
 * that id carries the diff. Both are already in the timeline the panel's
 * parent is holding, so this pairs them by id.
 *
 * Only applied patches count, matching `/sessions/:id/files` and the receipt.
 * A proposal that was denied, or that the model abandoned, describes a change
 * to a file that never happened.
 */

type ProposalKind = NonNullable<PatchProposalView["kind"]>;

type Proposal = { diff: string; intent: string; kind: ProposalKind };

const PROPOSAL_KIND: Partial<Record<string, ProposalKind>> = {
  propose_patch: "edit",
  propose_new_file: "create",
  propose_deletion: "delete",
};

export const appliedDiffsByPath = (
  events: readonly SessionEvent[],
): Map<string, PatchProposalView> => {
  const proposals = new Map<string, Proposal>();
  const applied = new Map<string, PatchProposalView>();

  for (const event of events) {
    if (event.type !== "tool.completed") {
      continue;
    }

    const { result } = event.payload;
    const kind = PROPOSAL_KIND[result.name];

    if (kind && "patchId" in result.output && "diff" in result.output) {
      proposals.set(result.output.patchId, {
        diff: result.output.diff,
        intent: result.output.intent,
        kind,
      });

      continue;
    }

    if (result.name !== "apply_patch") {
      continue;
    }

    const proposal = proposals.get(result.output.patchId);

    if (!proposal) {
      // The proposal is older than this client's window on the log, or the
      // apply names an id nothing proposed. Either way there is no text to
      // show, and inventing one would be worse than the row staying flat.
      continue;
    }

    // Last apply wins: a file edited twice shows the change that is actually
    // in the tree, not the one it superseded.
    applied.set(result.output.path, {
      path: result.output.path,
      intent: proposal.intent,
      status: result.output.status,
      diff: proposal.diff,
      additions: result.output.additions,
      deletions: result.output.deletions,
      kind: proposal.kind,
    });
  }

  return applied;
};
