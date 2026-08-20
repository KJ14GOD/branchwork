import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function opaque(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

export const newUserId = () => `usr_${opaque(20)}`;
export const newRepoId = () => `rep_${opaque(20)}`;
export const newWorkstreamId = () => `wst_${opaque(20)}`;
export const newOrgId = () => `org_${opaque(20)}`;
export const newMissionId = () => `msn_${opaque(20)}`;
export const newEventId = () => `evt_${opaque(20)}`;
export const newSessionId = () => `ses_${opaque(20)}`;
export const newStateNonce = () => opaque(32);
export const newSessionToken = () => randomBytes(32).toString("base64url");

// Investor-demo spine (D-034 … D-037).
export const newInvitationId = () => `inv_${opaque(20)}`;
export const newLeaseId = () => `lea_${opaque(20)}`;
export const newControlRequestId = () => `crq_${opaque(20)}`;
export const newHandoffOfferId = () => `hof_${opaque(20)}`;
export const newRunnerId = () => `rnr_${opaque(20)}`;
export const newExecutionId = () => `exe_${opaque(20)}`;
export const newDirectionId = () => `dir_${opaque(20)}`;
export const newCommandId = () => `cmd_${opaque(20)}`;
export const newCheckpointId = () => `ckp_${opaque(20)}`;
export const newFileChangeId = () => `chg_${opaque(20)}`;
export const newCheckId = () => `chk_${opaque(20)}`;

// Workspace runtime (D-040 … D-042).
export const newWorkspaceId = () => `wsp_${opaque(20)}`;

// Harness approvals (D-056).
export const newApprovalId = () => `apr_${opaque(20)}`;

// The decision between approaches (D-075).
export const newDecisionId = () => `dec_${opaque(20)}`;

// Conversation sessions inside a workstream (D-083). `csn_`, because `ses_`
// above has always been the auth session's prefix.
export const newWorkstreamSessionId = () => `csn_${opaque(20)}`;

// The tracked pull request — the row that starts existing when one is
// actually opened (D-075's promise, D-099's delivery).
export const newPullRequestId = () => `pr_${opaque(20)}`;

/** Single-use secrets handed out exactly once: invitation tokens and runner
 *  credentials. Only their SHA-256 hash is ever stored. */
export const newSecretToken = () => randomBytes(32).toString("base64url");
export const newReceiptId = () => `rcp_${opaque(20)}`;

// Durable visual evidence (D-022, D-122).
export const newArtifactId = () => `art_${opaque(20)}`;
export const newAttachmentId = () => `att_${opaque(20)}`;

/** An organization's own label for an extension (D-195). */
export const newExtensionLabelId = () => `lbl_${opaque(20)}`;
