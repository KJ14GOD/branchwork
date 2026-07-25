import { isAbsolute, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";

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

    if (isAbsolute(call.input.path)) {
      throw new Error("read_file only accepts repository-relative paths.");
    }

    const repositoryRoot = await realpath(this.repositoryPath);
    const unresolvedPath = resolve(repositoryRoot, call.input.path);

    if (isOutside(repositoryRoot, unresolvedPath)) {
      throw new Error("read_file cannot access files outside the repository.");
    }

    const requestedPath = await realpath(unresolvedPath);

    if (isOutside(repositoryRoot, requestedPath)) {
      throw new Error("read_file cannot access files outside the repository.");
    }

    const content = await readFile(requestedPath, "utf8");

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        path: relative(repositoryRoot, requestedPath),
        content,
      },
    });
  }
}
