import type { SessionEvent } from "@novus/contracts";

/**
 * The redaction boundary is on the way OUT of the worker, not on the way in.
 *
 * V1_README puts the host machine at the centre of the trust model: the host
 * "stores the complete privileged event log", and "only explicitly shareable
 * events and artifacts leave the host". Those are two different copies of the
 * same run, and only the second one has to be clean.
 *
 * So this module is never called by the event store. Redacting on append would
 * corrupt the record the host is entitled to: the operator watching their own
 * terminal, the receipt that is built by reading events back, and any later
 * replay would all see a marker where the run actually saw a value — and the
 * evidence of what happened would be gone for the one participant who is
 * allowed to have it. Worse, it would be gone irreversibly, because the store
 * is the only copy.
 *
 * The single caller is the SSE writer in `event-server.ts`, which is the one
 * place an event is serialised for a client. Anything else that ever ships
 * events off this process — the session service upload, an export, a bug
 * report — has to call through here too, and that is the invariant to check
 * when adding one, not this file.
 *
 * What this does not catch, stated here so nobody reads the word "redaction"
 * as a guarantee:
 *
 * - A secret that is neither a literal the worker's own environment holds, nor
 *   a recognised key shape, nor named like a secret. `STRIPE=pk_live_…` in a
 *   file that is not a dotenv passes straight through, and there is a test that
 *   says so.
 * - An encoded secret. `base64 .env`, a gzip, a heredoc — the bytes no longer
 *   contain the string, so nothing here matches them.
 * - A secret split by truncation. `run_command` caps each stream at 32k, and a
 *   literal cut in half is no longer the literal being matched.
 * - The model's own paraphrase. "the key ends in 4f2a" is not a match.
 *
 * The line this holds is the accidental leak — a command that printed a key,
 * a config file that got read out. It is not a defence against an agent, or a
 * guest, that is deliberately trying to exfiltrate one. The approval gate in
 * front of `run_command` remains the control that matters there.
 */

export type RedactionKind =
  | "known-secret"
  | "api-key"
  | "private-key"
  | "env-value"
  | "env-file";

/**
 * One stable, greppable marker per reason. A field is never dropped and never
 * blanked: a reviewer reading a shared timeline can see that redaction ran,
 * where it ran, and which rule fired.
 */
const MARKER_PREFIX = "[redacted:";

export const redactionMarker = (kind: RedactionKind): string =>
  `${MARKER_PREFIX}${kind}]`;

const SECRET_NAME_WORDS = new Set([
  "apikey",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "key",
  "keys",
  "passphrase",
  "passwd",
  "password",
  "pwd",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

/**
 * Word-wise rather than substring: `AUTHOR` and `KEYWORD` are not secrets, but
 * `apiKey`, `API_KEY` and `x-auth-token` all are. Splitting on camel-case
 * boundaries and separators catches every casing the same way.
 */
export const looksLikeSecretName = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SECRET_NAME_WORDS.has(word.toLowerCase()));

// Below this, a literal value is too common a word to substitute globally:
// replacing every occurrence of a four-character value would mangle unrelated
// output while protecting something that was never much of a secret.
const MIN_KNOWN_SECRET_LENGTH = 8;

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The worker's own environment, narrowed to the values that look like secrets.
 *
 * This is the "command output matching known secrets" rule, and it is the only
 * one that needs no pattern to be right: whatever shape the provider key has,
 * if the exact string the harness authenticates with turns up in a command's
 * stdout, it does not leave.
 */
const ENVIRONMENT_EXCEPTIONS = new Set(["SSH_AUTH_SOCK"]);

const knownSecretsFrom = (
  environment: Readonly<Record<string, string | undefined>>,
): string[] => {
  const values = new Set<string>();

  for (const [name, value] of Object.entries(environment)) {
    // Same exception the child-environment scrub already makes: SSH_AUTH_SOCK
    // reads as a secret name but holds a socket path, and registering that path
    // as a literal means every mention of it anywhere in any output gets
    // replaced — including the messages explaining an SSH failure.
    if (
      value === undefined ||
      ENVIRONMENT_EXCEPTIONS.has(name) ||
      !looksLikeSecretName(name)
    ) {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed.length >= MIN_KNOWN_SECRET_LENGTH) {
      values.add(trimmed);
    }
  }

  // Longest first, so a key that contains a shorter key is not left half
  // replaced with the tail still readable.
  return [...values].sort((left, right) => right.length - left.length);
};

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

// Shapes that are self-identifying: nothing but a credential looks like this,
// so they can be matched without any surrounding context.
const API_KEY_PATTERNS: readonly RegExp[] = [
  // Anthropic (sk-ant-…) and the wider sk- family.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // JWT: three base64url segments. Bearer tokens and session cookies alike.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// The scheme is kept so the shape of the request stays reviewable.
const AUTHORIZATION_VALUE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g;

// `NAME=value` in a shell command, a Dockerfile, a CI file, or source.
//
// `+` and `-` are in the prefix class because a unified diff is the artifact
// this most needs to cover. Without them every added and removed line was
// skipped while the identical text as context was redacted — so an agent adding
// a credential to a config file, the exact accident this rule exists for,
// produced a diff that shipped the secret to every viewer.
const ASSIGNMENT =
  /(^|[\s'"`(;&|{[,+-])([A-Za-z_][A-Za-z0-9_]{0,63})(\s*=\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s'"`;&|)\]},]+)/g;

// `name: value` in JSON, YAML, or an HTTP header. The unquoted form runs to the
// end of the line rather than the first space, because `Authorization: Bearer x`
// puts the part worth hiding after a space.
//
// The operator is `[^\S\n]` rather than `\s` on purpose. With `\s` the spacing
// after the colon could cross a line ending, so a harmless parent key —
// `environment:` — matched with its own indented child as the value, decided
// the parent was not a secret name, and returned the whole block unredacted.
// Every block-style YAML secret went through: docker-compose passwords, CI
// `env:` blocks, Kubernetes `data:`. It also fired the other way, swallowing
// the line after any heading that happened to end in a colon.
const FIELD =
  /(^|[\s{,[`'"+-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\2([^\S\n]*:[^\S\n]*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\n,}\]]+)/g;

// Where a `name:` is structure rather than English. A field takes the rest of
// its line, so firing on prose — "could not find the key: config.ts is missing"
// — would silently swallow the sentence that explains a failure. A name that
// opens a line, sits inside a JSON or quoted context, or carries a separator or
// a camel-case hump is a field; a bare word mid-sentence is not.
const FIELD_SHAPED_NAME = /[_.-]|[a-z][A-Z]/;
const FIELD_DELIMITERS = new Set(["", "\n", "{", ",", "[", '"', "'", "`"]);

// A source reference, not a field. `keys.ts:12:5 - error TS2322: Type 'string'
// is not assignable…` is a compiler diagnostic about a file whose name happens
// to contain a secret word, and taking the rest of that line deleted the error
// while protecting nothing. It bites `grep`, `node --test` locations and
// root-level `tsc` output — anywhere a filename appears without a directory,
// since a `/` before the name already stops the rule from matching at all.
//
// Both halves have to hold, and that is what keeps this from being a hole. The
// name has to look like a file — `keys.ts`, never a bare `key` — and the value
// has to open with a line number. `password: 12:30` is still a password, and a
// `digits:letters` credential is still a credential, because neither of those
// names is a filename. Anything the exemption lets past is re-examined from the
// colon onward rather than skipped, so a real field later on the same line is
// still redacted.
const SOURCE_FILE_NAME = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}$/;
const SOURCE_LOCATION_VALUE = /^\d+:/;

/**
 * The `name: value` pass, run as an explicit scan rather than a `replace`.
 *
 * The scan is what makes declining safe. A field takes the rest of its line, so
 * a `replace` callback that returned the match untouched also handed back every
 * character up to the newline — and the regex resumed *after* it. Every rule
 * that decides "this is not a secret" therefore blinded the pass to whatever
 * followed on that line. Resuming at the colon instead means a rule can decline
 * a name without covering for the one behind it.
 */
const redactFields = (text: string): string => {
  // A fresh instance: `lastIndex` is written below, and sharing that across
  // calls would make the result depend on the previous string.
  const pattern = new RegExp(FIELD.source, FIELD.flags);
  let result = "";
  let copiedTo = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1]!;
    const quote = match[2]!;
    const name = match[3]!;
    const operator = match[4]!;
    const matched = match[5]!;
    const offset = match.index;

    // Just past the colon, before whatever spacing followed it — the spacing
    // is a prefix the next candidate needs.
    const afterOperator =
      offset +
      prefix.length +
      quote.length * 2 +
      name.length +
      operator.indexOf(":") +
      1;

    const decline = (): void => {
      result += text.slice(copiedTo, afterOperator);
      copiedTo = afterOperator;
      pattern.lastIndex = afterOperator;
    };

    if (!looksLikeSecretName(name)) {
      decline();
      continue;
    }

    // A compiler or grep line: a filename, then a source location.
    if (
      SOURCE_FILE_NAME.test(name) &&
      SOURCE_LOCATION_VALUE.test(matched.trimStart())
    ) {
      decline();
      continue;
    }

    const lineStart = text.lastIndexOf("\n", offset) + 1;
    // A diff marker or a YAML sequence dash is still the start of the line
    // as far as structure goes. Without this, `+  password: hunter2` and
    // `- password: hunter2` were treated as prose while `api_key:` in the
    // same position was redacted — and `password`, `secret`, `token` are
    // exactly the bare names that appear that way.
    const opensTheLine =
      text.slice(lineStart, offset + prefix.length).replace(/^[+\-\s]*/, "") ===
      "";

    if (
      !opensTheLine &&
      quote === "" &&
      !FIELD_DELIMITERS.has(prefix) &&
      !FIELD_SHAPED_NAME.test(name)
    ) {
      decline();
      continue;
    }

    // A narrower rule already fired here — an Authorization scheme, say.
    // Overwriting its marker with this one would lose the reason and, since
    // this pattern is greedier, eat the bracket that closed it.
    if (matched.includes(MARKER_PREFIX)) {
      decline();
      continue;
    }

    let value = matched;
    let tail = "";

    // An unquoted value stops at the quote that opened the argument it sits
    // in, so `-H "x-api-key: …"` keeps its closing quote.
    if (quote === "" && (prefix === '"' || prefix === "'" || prefix === "`")) {
      const closed = value.indexOf(prefix);

      if (closed >= 0) {
        tail = value.slice(closed);
        value = value.slice(0, closed);
      }
    }

    // Trailing whitespace belongs to the line, not the value.
    const trimmed = value.trimEnd();
    tail = `${value.slice(trimmed.length)}${tail}`;

    if (trimmed === "") {
      decline();
      continue;
    }

    result += text.slice(copiedTo, offset);
    result += `${prefix}${quote}${name}${quote}${operator}${redactionMarker("env-value")}${tail}`;
    copiedTo = offset + match[0]!.length;
  }

  return result + text.slice(copiedTo);
};

// A dotenv file named anywhere in the command vector: `cat .env`, `sort .env.local`,
// `bash -c 'source .env'`.
const DOTENV_REFERENCE = /(?:^|[\s'"=<(/])\.env\b/;

const DOTENV_ASSIGNMENT =
  /^(\s*)((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

/**
 * Every assignment in the text, regardless of name.
 *
 * Reserved for output the command itself said was a dotenv file. There the
 * convention is that the whole file is credentials, and a name-based rule would
 * pass `STRIPE=…` straight through for want of the word "key".
 */
const redactDotenvAssignments = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const match = DOTENV_ASSIGNMENT.exec(line);

      if (!match || match[5]!.trim() === "") {
        return line;
      }

      return `${match[1]!}${match[2]!}${match[3]!}${match[4]!}${redactionMarker("env-file")}`;
    })
    .join("\n");

// Identity and discriminator fields. Redacting one would either break the
// contract's discriminated union or sever an event from the run it belongs to,
// and none of them carries user data.
const STRUCTURAL_KEYS = new Set([
  "actorId",
  "approvedBy",
  "deniedBy",
  "eventId",
  "id",
  "name",
  "occurredAt",
  "patchId",
  "runId",
  "sequence",
  "sessionId",
  "status",
  "toolCallId",
  "type",
]);

export type Redactor = {
  redactText: (text: string) => string;
  redactEvent: (event: SessionEvent) => SessionEvent;
};

export type RedactorOptions = {
  /** Defaults to `process.env`. The worker's own secrets are matched literally. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** User-configured secret patterns, in addition to the built-in shapes. */
  patterns?: readonly RegExp[];
  /**
   * Literals to redact that no environment variable holds.
   *
   * The worker's access token is minted in-process unless the host pinned one,
   * so scanning the environment would find it in exactly the configuration
   * where it is least sensitive and miss it in the default one.
   */
  knownSecrets?: readonly string[];
};

/**
 * Reads `NOVUS_REDACT_PATTERNS`: one regular expression per line.
 *
 * An unparseable pattern throws rather than being skipped. A redactor that
 * quietly drops a rule the operator asked for is worse than one that refuses to
 * start, because the first failure is invisible until the secret is already
 * shared.
 */
const configuredPatterns = (
  environment: Readonly<Record<string, string | undefined>>,
): RegExp[] =>
  (environment.NOVUS_REDACT_PATTERNS ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((source) => {
      try {
        return new RegExp(source, "g");
      } catch (error) {
        throw new Error(
          `NOVUS_REDACT_PATTERNS contains an invalid regular expression (${source}): ${(error as Error).message}`,
        );
      }
    });

export const createRedactor = (options: RedactorOptions = {}): Redactor => {
  const environment = options.environment ?? process.env;
  const known = [
    ...knownSecretsFrom(environment),
    ...(options.knownSecrets ?? []).filter(
      (secret) => secret.trim().length >= MIN_KNOWN_SECRET_LENGTH,
    ),
  ];
  const knownPattern =
    known.length === 0
      ? undefined
      : new RegExp(known.map(escapeForRegExp).join("|"), "g");

  const userPatterns = [
    ...configuredPatterns(environment),
    ...(options.patterns ?? []).map(
      (pattern) =>
        new RegExp(
          pattern.source,
          pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
        ),
    ),
  ];

  const redactText = (text: string): string => {
    let result = text;

    // Literal values first: they are certain, and matching them before the
    // heuristics keeps a known key from being partly rewritten by a pattern
    // and then no longer recognisable as itself.
    if (knownPattern) {
      result = result.replace(knownPattern, redactionMarker("known-secret"));
    }

    for (const pattern of userPatterns) {
      result = result.replace(pattern, redactionMarker("known-secret"));
    }

    result = result.replace(PRIVATE_KEY_BLOCK, redactionMarker("private-key"));

    for (const pattern of API_KEY_PATTERNS) {
      result = result.replace(pattern, redactionMarker("api-key"));
    }

    result = result.replace(
      AUTHORIZATION_VALUE,
      (_match, scheme: string) => `${scheme} ${redactionMarker("api-key")}`,
    );

    result = result.replace(
      ASSIGNMENT,
      (
        match,
        prefix: string,
        name: string,
        operator: string,
        value: string,
      ) => {
        if (!looksLikeSecretName(name)) {
          return match;
        }

        // The guard the field rule already carries, for the same reason. A
        // narrower rule fired here first — the dotenv pass, most often, since
        // it runs before any of this — and rewriting its marker loses the
        // reason it names. It also mangles the marker: this value class stops
        // at the closing bracket, so `API_KEY=[redacted:env-file]` came back as
        // `API_KEY=[redacted:env-value]]`.
        if (value.includes(MARKER_PREFIX)) {
          return match;
        }

        return `${prefix}${name}${operator}${redactionMarker("env-value")}`;
      },
    );

    result = redactFields(result);

    return result;
  };

  const redactUnknown = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      return key !== undefined && STRUCTURAL_KEYS.has(key)
        ? value
        : redactText(value);
    }

    if (Array.isArray(value)) {
      return value.map((entry) => redactUnknown(entry));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};

      // Key order is preserved so an unredacted event serialises byte for byte
      // as it did before.
      for (const [name, entry] of Object.entries(value)) {
        result[name] = redactUnknown(entry, name);
      }

      return result;
    }

    return value;
  };

  const redactEvent = (event: SessionEvent): SessionEvent => {
    let source = event;

    // The one rule that needs context: only the command itself knows whether
    // its stdout is a dotenv file, and by the time the text is a string in a
    // generic walk that is no longer visible.
    if (event.type === "tool.completed") {
      const result = event.payload.result;
      // The only place this module reaches for a named field instead of
      // walking whatever it is given, and so the only place a contract change
      // could hand it something that is not there. ToolResultSchema guarantees
      // `command` for these two tools today, so this cannot throw yet — but the
      // throw would land in the event store's listener loop, which has no
      // try/catch, propagate out of append, and end the run. Redaction must
      // never be able to do that, so it is read defensively rather than on the
      // strength of a schema in another package.
      if (result.name === "run_command" || result.name === "run_tests") {
        const command = result.output?.command;

        if (typeof command === "string" && DOTENV_REFERENCE.test(command)) {
          source = {
            ...event,
            payload: {
              ...event.payload,
              result: {
                ...result,
                output: {
                  ...result.output,
                  stdout: redactDotenvAssignments(result.output.stdout),
                  stderr: redactDotenvAssignments(result.output.stderr),
                },
              },
            },
          } as SessionEvent;
        }
      }
    }

    // Only string leaves change, and structural keys are left alone, so the
    // result still satisfies the same contract schema the input did.
    return redactUnknown(source) as SessionEvent;
  };

  return { redactText, redactEvent };
};
