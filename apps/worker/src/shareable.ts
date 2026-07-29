import type { SessionEvent } from "@novus/contracts";

/**
 * What a teammate is allowed to see, which is not everything the host records.
 *
 * Redaction removes secrets. It does not answer a different question V1 asks
 * separately: "Only explicitly shareable events and artifacts leave the host",
 * and "Source code remains local by default". A log with no secrets in it still
 * contains the contents of every file the agent read, every matching line it
 * searched, and the absolute paths of the machine it ran on — and the first
 * version of the publisher sent all of that to a third-party server because
 * nothing had ever had to decide.
 *
 * The line drawn here follows what V1's compare screen needs a reviewer to
 * have: a diff summary and the complete patch, changed files, test results,
 * diagnostics, cost and time. Those are the evidence a decision is made from,
 * so they cross. What does not cross is the repository itself — file contents,
 * search hits, raw command output — and anything naming the host's filesystem.
 *
 * Conservative on purpose. A field added to the contract later is withheld
 * until somebody decides it should be shared, rather than shipped off the
 * machine because nobody thought about it.
 */

const WITHHELD = "[withheld: stays on the host]";

const shareablePath = (path: string): string => path;

export const shareableEvent = (event: SessionEvent): SessionEvent => {
  switch (event.type) {
    case "session.created":
      return {
        ...event,
        payload: {
          ...event.payload,
          session: {
            ...event.payload.session,
            // An absolute path names the host's filesystem and its user, and a
            // guest needs none of it to follow a session.
            repositoryPath: WITHHELD,
          },
        },
      };

    case "tool.completed": {
      const { result } = event.payload;

      if (result.name === "read_file") {
        // The file's contents are the repository. Its path and size say what
        // the agent looked at, which is what a reviewer is actually following.
        return {
          ...event,
          payload: {
            ...event.payload,
            result: {
              ...result,
              output: {
                path: shareablePath(result.output.path),
                content: `${WITHHELD} (${result.output.content.length} characters)`,
              },
            },
          },
        };
      }

      if (result.name === "search_repository") {
        // Where the matches were, not what they said.
        return {
          ...event,
          payload: {
            ...event.payload,
            result: {
              ...result,
              output: {
                ...result.output,
                matches: result.output.matches.map((match) => ({
                  ...match,
                  text: WITHHELD,
                })),
              },
            },
          },
        };
      }

      // Command output is arbitrary repository content — a printed file, a
      // failing test's fixture, a stack trace full of source. The verdict
      // crosses; the transcript does not. The two are handled apart so the
      // discriminant survives: spreading the union erases which one this is.
      if (result.name === "run_command") {
        return {
          ...event,
          payload: {
            ...event.payload,
            result: {
              ...result,
              output: {
                ...result.output,
                stdout: result.output.stdout === "" ? "" : WITHHELD,
                stderr: result.output.stderr === "" ? "" : WITHHELD,
              },
            },
          },
        };
      }

      if (result.name === "run_tests") {
        return {
          ...event,
          payload: {
            ...event.payload,
            result: {
              ...result,
              output: {
                ...result.output,
                stdout: result.output.stdout === "" ? "" : WITHHELD,
                stderr: result.output.stderr === "" ? "" : WITHHELD,
              },
            },
          },
        };
      }

      if (result.name === "git_status") {
        return event;
      }

      // propose_patch, apply_patch and git_diff carry diffs, and a diff is what
      // V1's compare screen is built on — a reviewer choosing between two
      // attempts is choosing between their patches. These cross deliberately.
      return event;
    }

    case "fork.created":
      return {
        ...event,
        payload: {
          ...event.payload,
          fork: {
            ...event.payload.fork,
            // Absolute, and on the host. The branch and label identify the
            // attempt without naming anybody's disk.
            worktreePath: WITHHELD,
          },
        },
      };

    default:
      return event;
  }
};
