import { z } from "zod";
import type { Db } from "./db.ts";
import { laneRepository } from "./workstreams.ts";
import { ProviderTransientError, RepoTokenMissingError, UnknownRepositoryError, type RepoActor } from "./repo-provider.ts";

/**
 * OWNER: the credential a runner needs to put a GitHub repository on the
 * machine it runs on.
 *
 * ARCHITECTURE.md#secret-placement already says where this token lives: the
 * repository access token is handed per operation, held by the **runner
 * supervisor**. The host desktop *is* the runner supervisor (D-032, D-035),
 * and since D-223 the credential is the runner owner's own OAuth token — the
 * same one their own `git` would present — handed to the authenticated runner
 * they enrolled. This is not cloud execution: it is the existing local runner
 * working on a repository it fetched.
 *
 * Three properties this module exists to keep:
 *
 *  - Only a runner credential can obtain one. A user session cannot, and the
 *    renderer never sees it (D-035, ARCHITECTURE.md#authentication).
 *  - A runner never names the workstream it is asking about; the credential
 *    resolves it. Naming someone else's is refused rather than answered.
 *  - Nothing durable remembers the token: no row, no event, no log line. It is
 *    short-lived, repository-scoped, and spent on one fetch.
 */

/** Optional and echoed, exactly like runner registration: a runner may state
 *  which lane it believes it is in, and is refused when it is wrong. */
export const CloneCredentialRequestSchema = z.object({
  workstreamId: z.string().startsWith("wst_").optional()
});

export interface CloneCredential {
  /** The plain remote. It never carries a credential in its authority, because
   *  a URL with a secret in it ends up in `.git/config` and stays there. */
  remoteUrl: string;
  username: string;
  token: string;
  expiresAt: string;
}

/**
 * A repository provider that can mint a short-lived, repository-scoped
 * credential. Declared here and detected structurally rather than widened into
 * `RepositoryProvider`: the deterministic fake and the unconfigured provider
 * have no repository to fetch, and must refuse by name rather than pretend.
 */
export interface CloneCredentialMinter {
  mintCloneCredential(actor: RepoActor, providerRepoId: string): Promise<CloneCredential>;
}

export function canMintCloneCredential(provider: unknown): provider is CloneCredentialMinter {
  return typeof (provider as CloneCredentialMinter | null)?.mintCloneCredential === "function";
}

/**
 * The write-scoped sibling (D-099): a provider that can mint a push
 * credential — one repository, `contents: write`, one operation. Detected
 * structurally like the clone minter, and deliberately a separate verb: a
 * push is a different grant from a read, and nothing widens the read to get
 * one.
 */
export interface PushCredentialMinter {
  mintPushCredential(actor: RepoActor, providerRepoId: string): Promise<CloneCredential>;
}

export function canMintPushCredential(provider: unknown): provider is PushCredentialMinter {
  return typeof (provider as PushCredentialMinter | null)?.mintPushCredential === "function";
}

/**
 * Mints the push credential for the repository behind one workstream — the
 * same scope-from-credential rule as the clone half: the workstream is the
 * caller's own, so repository scope follows from runner scope. Same
 * no-row, no-event, no-log-line property: used and forgotten.
 */
export async function issuePushCredential(
  db: Db,
  provider: unknown,
  args: { orgId: string; workstreamId: string },
  actor: RepoActor
): Promise<CloneCredential> {
  const lane = await laneRepository(db, args.workstreamId);
  // Another organization's lane is indistinguishable from a missing one:
  // repository scope follows from runner scope, never from a request body.
  if (!lane || lane.repoOrgId !== args.orgId) {
    throw new CloneCredentialError(404, "not_found", "No such workstream for this runner.");
  }
  if (lane.provider !== "github") {
    throw new CloneCredentialError(
      409,
      "push_not_needed",
      "This repository is a folder on a machine; there is no host to push it to."
    );
  }
  if (!canMintPushCredential(provider)) {
    throw new CloneCredentialError(
      503,
      "push_unavailable",
      "Repository access isn't configured for this organization yet, so nothing can be pushed."
    );
  }
  try {
    return await provider.mintPushCredential(actor, lane.providerRepoId);
  } catch (error) {
    if (error instanceof RepoTokenMissingError) {
      throw new CloneCredentialError(403, "repo_token_missing", error.message);
    }
    if (error instanceof UnknownRepositoryError) {
      throw new CloneCredentialError(404, "unknown_repository", error.message);
    }
    if (error instanceof ProviderTransientError) {
      throw new CloneCredentialError(502, "provider_unavailable", "GitHub could not issue repository access just now.");
    }
    throw error;
  }
}

/** A refusal with a name and a status, so the runner learns what happened and
 *  the room can say it in words. */
export class CloneCredentialError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CloneCredentialError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Mints the credential for the repository behind one workstream. The
 * workstream is the caller's own — resolved from its runner credential — so
 * repository scope follows from runner scope and cannot be widened by a
 * request body.
 */
export async function issueCloneCredential(
  db: Db,
  provider: unknown,
  args: { orgId: string; workstreamId: string },
  // The runner owner's own credential performs the fetch (D-223): the person
  // who enrolled the machine, whose git this already is.
  actor: RepoActor
): Promise<CloneCredential> {
  const lane = await laneRepository(db, args.workstreamId);
  // Another organization's lane is indistinguishable from a missing one:
  // repository scope follows from runner scope, never from a request body.
  if (!lane || lane.repoOrgId !== args.orgId) {
    throw new CloneCredentialError(404, "not_found", "No such workstream for this runner.");
  }
  if (lane.provider !== "github") {
    // A local repository is already on the machine that registered it; there is
    // nothing to fetch and no credential that would mean anything.
    throw new CloneCredentialError(
      409,
      "clone_not_needed",
      "This repository is already on the machine that registered it."
    );
  }
  if (!canMintCloneCredential(provider)) {
    throw new CloneCredentialError(
      503,
      "clone_unavailable",
      "Repository access isn't configured for this organization yet, so nothing can be fetched."
    );
  }

  try {
    return await provider.mintCloneCredential(actor, lane.providerRepoId);
  } catch (error) {
    if (error instanceof RepoTokenMissingError) {
      throw new CloneCredentialError(403, "repo_token_missing", error.message);
    }
    if (error instanceof UnknownRepositoryError) {
      throw new CloneCredentialError(404, "unknown_repository", error.message);
    }
    if (error instanceof ProviderTransientError) {
      throw new CloneCredentialError(502, "provider_unavailable", "GitHub could not issue repository access just now.");
    }
    throw error;
  }
}
