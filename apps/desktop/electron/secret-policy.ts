import { MIN_SECRET_LENGTH } from "@novus/contracts";

/**
 * What must not leave this machine (D-052).
 *
 * Two protections, deliberately different mechanisms covering different
 * failures, kept together because they are one policy and a reader needs both
 * to know what is actually guaranteed.
 *
 * `isSecretPath` — a file probably holds a credential, judged by its name.
 * `redact` — a value Novus was handed must not appear in anything reported.
 *
 * The path half was written for checkpoints — an agent that creates `.env` must not have
 * it swept into a commit — and for a while that was the only place a file's
 * contents could leave this machine. It is not any more: the file browser
 * lists the worktree, reads a file into a pane, and writes one back. A second
 * list would drift from this one, and the drift would be silent and in the
 * direction of disclosure, so there is one list and every surface asks it.
 *
 * What it is: a **pattern list**, and patterns are all it is. It recognises the
 * conventional names — `.env`, an SSH private key, `.npmrc`, a service-account
 * JSON. It cannot recognise a credential somebody put in `notes.txt`, and no
 * list can. Where that matters the answer is redaction of *known values*
 * (D-044), not a cleverer pattern, and the two protections are deliberately
 * different mechanisms covering different failures.
 */

/**
 * Files that hold real credentials often enough that Novus does not show them
 * without being asked. Ordered loosely by how commonly they turn up.
 */
const SECRET_PATTERNS = [
  // Environment files in every dressing: `.env`, `.env.local`, `.env.production`.
  /(^|\/)\.env(\.|$)/i,
  // Package-manager and language-registry credentials.
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.yarnrc\.yml$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.envrc$/i,
  // Git's own credential store, and the credentials files tooling writes.
  // Deliberately not a bare `credentials`: a directory by that name is ordinary
  // source code in plenty of projects, and hiding it would hide a subsystem.
  /(^|\/)\.git-credentials$/i,
  /credentials?\.(json|ya?ml|ini|db)$/i,
  // SSH and signing keys, by name and by extension.
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /\.p8$/i,
  /(^|\/)\.ssh\//i,
  // Cloud service accounts and the shapes their tooling writes.
  /service[-_]?account.*\.json$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)gcloud\//i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)kubeconfig$/i,
  /(^|\/)\.docker\/config\.json$/i,
  // Terraform variable files carry provider credentials as a matter of course.
  /\.tfvars(\.json)?$/i
];

/**
 * Templates. A repository commits these *so that* people can read them, and
 * they hold variable names rather than values — hiding them would hide the one
 * file that says what a project needs.
 *
 * Checked before the patterns above, because `.env.example` matches `.env` and
 * the specific answer has to win.
 */
const TEMPLATE_PATTERNS = [
  /(^|\/)\.env\.(example|sample|template|dist|defaults?)$/i,
  /(^|\/)(example|sample|template)\.env$/i,
  /(^|\/)\.env\.[\w.-]*\.(example|sample|template)$/i
];

/**
 * Where an attached file a person handed the agent is staged inside the
 * worktree (D-153). Relative to the worktree root, always.
 */
export const ATTACHMENT_DIR = ".novus/attachments";

/**
 * True when this path is a staged attachment rather than the mission's work.
 *
 * Two things keep an attachment out of a commit and this is the second one.
 * The first is `.git/info/exclude`, which makes git itself ignore the
 * directory — per clone, never committed, so the project's own `.gitignore`
 * is never touched. This is the belt to that's braces: the checkpoint refuses
 * the path outright, so a missing or hand-edited exclude file cannot put
 * somebody's screenshot into a mission branch and from there into a pull
 * request. The consequence of being wrong here is a person's private file in
 * a public PR, which is worth two independent guards.
 */
export function isAttachmentPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ATTACHMENT_DIR || normalized.startsWith(`${ATTACHMENT_DIR}/`);
}

/**
 * True when this path should not be listed, read, or written by an ordinary
 * file surface.
 *
 * Judged on the path alone, never on contents: a file is protected because of
 * what it is called, which is knowable before anything opens it. A template is
 * not protected, because its whole purpose is to be read — which does mean that
 * somebody who writes a real password into `.env.example` has defeated this,
 * and nothing here can tell. The exemption is by name, like everything else.
 */
export function isSecretPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (TEMPLATE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** What a surface says when it refuses one, in the product's own words. */
export const SECRET_PATH_REFUSAL =
  "That file looks like it holds a credential, so Novus does not open it here. Supply the value in Set up workspace, where it goes to this machine's credential store and nowhere else.";

/**
 * Removes any secret value from text before it can be reported.
 *
 * Values shorter than `MIN_SECRET_LENGTH` are not stored at all — the entry
 * path refuses them by name (D-044) — so this floor is a second line rather
 * than a silent exception: if one ever reached the store from an older build,
 * redacting it would shred every line of output containing that common word
 * without protecting anything, and the honest answer is that Novus does not
 * accept a secret it cannot redact.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
