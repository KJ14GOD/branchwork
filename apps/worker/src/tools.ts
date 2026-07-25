import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

import {
  ToolResultSchema,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

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
