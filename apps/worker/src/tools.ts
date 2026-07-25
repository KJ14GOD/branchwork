import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

import {
  ToolResultSchema,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

import { buildUnifiedDiff } from "./diff.ts";

export interface AgentTool {
  readonly name: ToolCall["name"];
  execute(call: ToolCall): Promise<ToolResult>;
}

const isOutside = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);

  return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
};

const isProtectedPath = (repositoryRoot: string, targetPath: string): boolean => {
  const pathFromRoot = relative(repositoryRoot, targetPath);
  const segments = pathFromRoot.split(sep);
  const fileName = basename(targetPath);
  const isEnvironmentFile =
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example");

  return segments.includes(".git") || isEnvironmentFile;
};

const resolveInsideRepository = async (
  repositoryPath: string,
  requestedPath: string,
): Promise<{ repositoryRoot: string; targetPath: string }> => {
  if (isAbsolute(requestedPath)) {
    throw new Error("Tools only accept repository-relative paths.");
  }

  const repositoryRoot = await realpath(repositoryPath);
  const unresolvedPath = resolve(repositoryRoot, requestedPath);

  if (isOutside(repositoryRoot, unresolvedPath)) {
    throw new Error("Tools cannot access paths outside the repository.");
  }

  const targetPath = await realpath(unresolvedPath);

  if (isOutside(repositoryRoot, targetPath)) {
    throw new Error("Tools cannot access paths outside the repository.");
  }

  if (isProtectedPath(repositoryRoot, targetPath)) {
    throw new Error("Tools cannot access protected repository paths.");
  }

  return { repositoryRoot, targetPath };
};

export class ReadFileTool implements AgentTool {
  readonly name = "read_file";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The read_file tool cannot execute ${call.name}.`);
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path,
    );
    const content = await readFile(targetPath, "utf8");

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        path: relative(repositoryRoot, targetPath),
        content,
      },
    });
  }
}

type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

type RipgrepMatch = {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
};

const runRepositorySearch = (
  repositoryRoot: string,
  targetPath: string,
  query: string,
  limit: number,
): Promise<SearchMatch[]> =>
  new Promise((resolveSearch, rejectSearch) => {
    const matches: SearchMatch[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let stoppedAtLimit = false;

    const child = spawn(
      rgPath,
      [
        "--json",
        "--smart-case",
        "--max-filesize",
        "1M",
        "--",
        query,
        relative(repositoryRoot, targetPath) || ".",
      ],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const consumeLine = (line: string): void => {
      if (!line || matches.length >= limit) {
        return;
      }

      const record = JSON.parse(line) as RipgrepMatch;

      if (record.type !== "match") {
        return;
      }

      const path = record.data?.path?.text;
      const lineNumber = record.data?.line_number;
      const text = record.data?.lines?.text;

      if (path && lineNumber && text !== undefined) {
        matches.push({
          path: relative(repositoryRoot, resolve(repositoryRoot, path)),
          line: lineNumber,
          text: text.trimEnd(),
        });
      }

      if (matches.length >= limit) {
        stoppedAtLimit = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        consumeLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      rejectSearch(
        new Error(`Unable to start repository search: ${error.message}`),
      );
    });

    child.on("close", (code) => {
      if (stdoutBuffer) {
        consumeLine(stdoutBuffer);
      }

      if (stoppedAtLimit || code === 0 || code === 1) {
        resolveSearch(matches);
        return;
      }

      rejectSearch(
        new Error(`Repository search failed: ${stderr.trim() || `exit ${code}`}`),
      );
    });
  });

export class SearchRepositoryTool implements AgentTool {
  readonly name = "search_repository";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(
        `The search_repository tool cannot execute ${call.name}.`,
      );
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path ?? ".",
    );

    if (!(await stat(targetPath)).isDirectory()) {
      throw new Error("search_repository path must be a directory.");
    }

    const matches = await runRepositorySearch(
      repositoryRoot,
      targetPath,
      call.input.query,
      call.input.limit ?? 30,
    );

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        query: call.input.query,
        matches,
      },
    });
  }
}

export type PatchProposal = {
  patchId: string;
  path: string;
  intent: string;
  baseContent: string;
  proposedContent: string;
};

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
};

/**
 * Turns model-proposed exact-match edits into a reviewable unified diff.
 *
 * The working tree is never written. Each accepted proposal is retained with
 * the content it was computed against so a later permissioned application step
 * can detect a file that changed after the proposal was made.
 */
export class ProposePatchTool implements AgentTool {
  readonly name = "propose_patch";
  private readonly repositoryPath: string;
  private readonly proposals = new Map<string, PatchProposal>();

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  getProposal(patchId: string): PatchProposal | undefined {
    return this.proposals.get(patchId);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The propose_patch tool cannot execute ${call.name}.`);
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path,
    );

    if (!(await stat(targetPath)).isFile()) {
      throw new Error("propose_patch requires a repository file path.");
    }

    const baseContent = await readFile(targetPath, "utf8");
    let proposedContent = baseContent;

    for (const [index, edit] of call.input.edits.entries()) {
      const occurrences = countOccurrences(proposedContent, edit.oldText);

      if (occurrences === 0) {
        throw new Error(
          `Edit ${index + 1} does not apply: oldText was not found in ${call.input.path}.`,
        );
      }

      if (occurrences > 1) {
        throw new Error(
          `Edit ${index + 1} is ambiguous: oldText matches ${occurrences} locations in ${call.input.path}. Include more surrounding context.`,
        );
      }

      // A replacer function keeps `$&` and friends in newText literal.
      proposedContent = proposedContent.replace(
        edit.oldText,
        () => edit.newText,
      );
    }

    if (proposedContent === baseContent) {
      throw new Error("propose_patch produced no change to the file.");
    }

    const path = relative(repositoryRoot, targetPath);
    const { diff, additions, deletions } = buildUnifiedDiff(
      path,
      baseContent,
      proposedContent,
    );
    const patchId = crypto.randomUUID();

    this.proposals.set(patchId, {
      patchId,
      path,
      intent: call.input.intent,
      baseContent,
      proposedContent,
    });

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        patchId,
        path,
        intent: call.input.intent,
        status: "proposed",
        diff,
        additions,
        deletions,
      },
    });
  }
}
