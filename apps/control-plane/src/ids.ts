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
