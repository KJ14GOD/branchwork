import type { ToolCall } from "@novus/contracts";

/**
 * What every model provider is told about the native tools, in one place.
 *
 * This used to be defined once per provider, as a full second copy of every
 * JSON schema — reasonable when there was one provider to write it for, and
 * the wrong shape the moment a second one needs the same tools described
 * the same way. Two adapters that drifted on a tool's description, or on the
 * system prompt that tells a model how to use them, would make any
 * comparison between the providers meaningless before either one wrote a
 * line of code.
 *
 * The shape here is JSON Schema, which both providers' own tool-calling
 * formats already speak: Anthropic's `input_schema` and OpenAI's
 * `function.parameters` are each just this object with a different field
 * name wrapped around it. Nothing about *how* a provider is called — message
 * shape, streaming, usage reporting — belongs here; only what is identical
 * content regardless of which provider is asked.
 */

export type ToolDescription = {
  name: ToolCall["name"];
  description: string;
  /** JSON Schema for the tool's input, unwrapped from any provider's envelope. */
  parameters: Record<string, unknown>;
};

// The two citation rules exist because a live run fabricated both kinds of
// claim, confidently: it cited server.mjs:274 for a line that lives at 295
// (read_file returns no line numbers, so every :NNN it wrote was an estimate
// dressed as a citation), and it declared a valid provider model id "not a
// real model id — would 400" from stale outside knowledge. Nothing failed
// visibly either time; the summary just said things the run had never
// verified. Shared across providers because the failure is the model's
// behavior, not a property of one API.
export const SYSTEM_PROMPT =
  "You are a coding agent working in a local repository. Search the repository to discover relevant files, then read files for exact evidence. Never invent file contents. Cite line numbers only when a tool result actually showed them: search results carry line numbers, plain file reads do not, and an estimated line number presented as a citation is an invention. When a conclusion depends on knowledge from outside this repository — a provider's model names, a library's behavior, version facts — say it is unverified instead of stating it as fact. When a change is needed, call propose_patch to produce a reviewable diff — or propose_new_file to create a file, or propose_deletion to remove one — then call apply_patch with the patchId it returns to write it. After applying a change, call run_tests to confirm it works, and run_diagnostics or run_build when the question is types, lint, or whether the project still compiles; report what they actually said rather than asserting success. apply_patch, run_command, run_tests, run_build, run_diagnostics, and dev_server require human approval and may be denied — if one is, explain what you would have done rather than trying to work around the denial.";

export const TOOL_DESCRIPTIONS: readonly ToolDescription[] = [
  {
    name: "search_repository",
    description:
      "Search text across files in the selected repository. Returns repository-relative paths, line numbers, and matching lines. Use this to discover relevant files before reading them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text or regular expression to search for.",
        },
        path: {
          type: "string",
          description:
            "Optional repository-relative directory to search. Defaults to the entire repository.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of matching lines. Defaults to 30.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the selected repository using a repository-relative path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative path to the file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_patch",
    description:
      "Propose an edit to one file in the selected repository. Novus computes and returns a unified diff preview. This does not modify the working tree — the change is only a proposal awaiting human review. Read the file first so every oldText is exact.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative path to the file to edit.",
        },
        intent: {
          type: "string",
          description: "One sentence describing what this change accomplishes.",
        },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "Exact-match replacements, applied in order.",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description:
                  "Exact existing text to replace. It must appear exactly once in the file; include surrounding lines when needed to make it unique.",
              },
              newText: {
                type: "string",
                description:
                  "Replacement text. Use an empty string to delete the matched text.",
              },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "intent", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_new_file",
    description:
      "Propose writing a file's complete content — creating it, or replacing an existing one when you pass overwrite: true. Novus returns a patchId and a reviewable diff; nothing is written until apply_patch is called with that patchId. Use this whenever you have the whole file text, including a full rewrite of an existing file; use propose_patch instead when you are changing part of a file and can quote the exact text you are replacing. Parent directories are created on apply.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository-relative path. It must not already exist unless overwrite is true.",
        },
        intent: {
          type: "string",
          description: "One sentence describing why this file should exist.",
        },
        content: {
          type: "string",
          description: "The complete content the file should have.",
        },
        overwrite: {
          type: "boolean",
          description:
            "Set true to replace a file that already exists. Omit it when creating a new file; an existing path is refused without it, so a mistyped path cannot silently flatten something.",
        },
      },
      required: ["path", "intent", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_deletion",
    description:
      "Propose deleting one existing file. Novus returns a patchId and a diff showing the removal; the file is only deleted when apply_patch is called with that patchId, and the apply fails if the file changed after this proposal. Directories are refused — propose their files individually.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative path of the file to delete.",
        },
        intent: {
          type: "string",
          description: "One sentence describing why this file should go.",
        },
      },
      required: ["path", "intent"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a proposal you previously made — an edit from propose_patch, a new file from propose_new_file, or a deletion from propose_deletion — writing it to the working tree. Takes the patchId the proposal returned. This requires human approval and may be denied. It fails if the file changed since the proposal was made.",
    parameters: {
      type: "object",
      properties: {
        patchId: {
          type: "string",
          description: "The patchId returned by a previous propose_patch call.",
        },
      },
      required: ["patchId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a program inside the selected repository and return its exit code, stdout, and stderr. The command runs without a shell, so pipes, redirection, globs, and operators like && are not interpreted — pass the program name and each argument separately. Requires human approval and may be denied.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Program name resolved on PATH, such as 'node' or 'git'. Not a path and not a shell line.",
        },
        args: {
          type: "array",
          maxItems: 64,
          items: { type: "string" },
          description:
            "Arguments, one array element each. For example ['status', '--short'].",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 600000,
          description: "Kill the command after this long. Defaults to 120000.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "run_tests",
    description:
      "Run the repository's own test suite and report whether it passed. Use this to verify a change you applied actually works, before claiming it does. Requires human approval and may be denied.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          maxItems: 32,
          items: { type: "string" },
          description:
            "Optional extra arguments passed to the test script, such as a filename to narrow the run.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 600000,
          description: "Kill the run after this long. Defaults to 120000.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "run_build",
    description:
      "Run the repository's own build script and report whether it succeeded. Use this when the question is 'does the project still compile/bundle' — it requires a \"build\" script in package.json and runs exactly that, so the verdict is the project's own. Requires human approval and may be denied.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          maxItems: 32,
          items: { type: "string" },
          description: "Optional extra arguments passed to the build script.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 600000,
          description: "Kill the build after this long. Defaults to 120000.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "run_diagnostics",
    description:
      "Typecheck or lint the project and get back a structured list of problems — file, line, severity, message, rule — instead of raw checker output. Prefer this over run_command for 'are there type errors' and 'does lint pass': it finds the project's own typecheck/lint script (falling back to an installed tsc or eslint), and its diagnostics are parsed for you. Requires human approval and may be denied.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["typecheck", "lint"],
          description:
            "Which checker to run: 'typecheck' for the type system, 'lint' for style and correctness rules.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 600000,
          description: "Kill the checker after this long. Defaults to 120000.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "dev_server",
    description:
      "Manage long-running development servers. Unlike run_command, a process started here is supposed to keep running after the call returns — use it for dev servers and watchers, never for one-shot commands. action 'start' needs command (a program name on PATH, no shell, no pipes) and args, and returns a serverId, the port (also given to the process as the PORT environment variable), and whether the port is answering yet. 'status' lists this session's servers, 'logs' returns one server's recent output, 'stop' terminates one by serverId. Servers die with the session's worker; they do not survive it. Requires human approval and may be denied.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "status", "logs"],
          description:
            "What to do. 'start' requires command; 'stop' and 'logs' require serverId; 'status' takes nothing else.",
        },
        command: {
          type: "string",
          description:
            "start only: program name resolved on PATH, such as 'node' or 'npx'. Not a path and not a shell line.",
        },
        args: {
          type: "array",
          maxItems: 64,
          items: { type: "string" },
          description: "start only: arguments, one array element each.",
        },
        port: {
          type: "integer",
          minimum: 1024,
          maximum: 65535,
          description:
            "start only: a specific port to hold for this server. Omit to have a free one allocated — the chosen port is passed to the process as PORT either way.",
        },
        readyTimeoutMs: {
          type: "integer",
          minimum: 500,
          maximum: 60000,
          description:
            "start only: how long to wait for the port to answer before reporting the server as still starting. Defaults to 5000.",
        },
        serverId: {
          type: "string",
          description:
            "stop and logs only: the serverId a previous start returned.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    description:
      "List the entries of a directory inside the selected repository. Use this to orient yourself before searching or reading.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository-relative directory. Defaults to the repository root.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description:
      "Show which files in the repository have been modified, staged, or left untracked. Use this to see what your own changes touched.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description:
      "Show the current diff of the repository. Unstaged by default. Use this to read back exactly what your patches changed before you claim they are correct.",
    parameters: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "Diff staged changes instead of unstaged ones.",
        },
        path: {
          type: "string",
          description: "Optional repository-relative path to narrow the diff.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "git_branches",
    description:
      "List the repository's branches and worktrees: every local branch with its tip commit and upstream, which branch is checked out (or that HEAD is detached), and every linked worktree. Read-only — it cannot create or switch branches. Use it to orient before reasoning about where commits will land.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_provider_models",
    description:
      "List the model ids the configured provider currently serves. Use this before claiming that a model id found in the repository is invalid, outdated, or a typo — ids newer than your training data are real.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

/**
 * What a malformed tool call should be told, beyond which field was wrong.
 *
 * A Zod issue on its own reads "input.edits: expected array, received
 * undefined" — true, and not enough to act on. A live run met exactly that:
 * the model wanted to replace a whole file, reached for propose_patch,
 * omitted the edits it had no intention of writing, and repeated the same
 * malformed call until the consecutive-failure budget ended the run. It was
 * never told what the call should have looked like, only that it was wrong.
 *
 * Restating the tool's own accepted input closes that loop with the thing
 * the model already understands, since this is the same schema it was
 * offered the tool with.
 */
export const expectedInputFor = (name: string): string => {
  const tool = TOOL_DESCRIPTIONS.find((candidate) => candidate.name === name);

  if (!tool) {
    return `No tool named ${name} exists. Call one of: ${TOOL_DESCRIPTIONS.map((candidate) => candidate.name).join(", ")}.`;
  }

  const parameters = tool.parameters as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  const required = new Set(parameters.required ?? []);
  const fields = Object.entries(parameters.properties ?? {}).map(
    ([field, shape]) =>
      `${field}${required.has(field) ? "" : "?"}: ${shape.type ?? "unknown"}`,
  );

  return `${name} accepts { ${fields.join(", ")} }. ${tool.description}`;
};
