import type { ToolCall } from "@novus/contracts";

/**
 * What every model provider is told about the nine native tools, in one
 * place.
 *
 * This used to be defined once per provider, as a full second copy of nine
 * JSON schemas — reasonable when there was one provider to write it for, and
 * the wrong shape the moment a second one needs the same nine tools described
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

export const SYSTEM_PROMPT =
  "You are a coding agent working in a local repository. Search the repository to discover relevant files, then read files for exact evidence. Never invent file contents. When a change is needed, call propose_patch to produce a reviewable diff, then call apply_patch with the patchId it returns to write it. After applying a change, call run_tests to confirm it works, and report what the tests actually said rather than asserting success. apply_patch, run_command, and run_tests require human approval and may be denied — if one is, explain what you would have done rather than trying to work around the denial.";

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
    name: "apply_patch",
    description:
      "Apply a patch you previously proposed, writing it to the working tree. Takes the patchId returned by propose_patch. This requires human approval and may be denied. It fails if the file changed since the patch was proposed.",
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
];
