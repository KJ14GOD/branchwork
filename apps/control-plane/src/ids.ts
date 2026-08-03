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
export const newProcessId = () => `prc_${opaque(20)}`;

/** Single-use secrets handed out exactly once: invitation tokens and runner
 *  credentials. Only their SHA-256 hash is ever stored. */
export const newSecretToken = () => randomBytes(32).toString("base64url");
