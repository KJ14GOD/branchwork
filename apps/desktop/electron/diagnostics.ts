import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What the machine keeps about its own failures (D-250): the main process's
 * log, rotated so it never grows without bound, and a count of the crash
 * reports Electron's crash reporter wrote beside it. Nothing here is sent
 * anywhere; the About page says where the files are and opens the folder.
 * The log is a line per event in the order they happened, timestamped, and
 * is written synchronously so a crash that follows a line still keeps it.
 */

export interface DiagnosticsSummary {
  logsPath: string;
  crashReportsPath: string;
  crashReports: number;
  logBytes: number;
}

export interface DiagnosticsDeps {
  logsPath: string;
  crashReportsPath: string;
  /** The log rotates past this size; the previous logs are kept up to `keep`. */
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
}

export const LOG_NAME = "main.log";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/** The rotated names in order: main.log, main.1.log, main.2.log, … */
export function rotatedName(index: number): string {
  return index === 0 ? LOG_NAME : `main.${index}.log`;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Every crash report under a folder, whatever subfolders the reporter made. */
export function countCrashReports(root: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".dmp")) count += 1;
    }
  };
  try {
    walk(root);
  } catch {
    /* a folder that vanished mid-walk counts what was seen */
  }
  return count;
}

export interface Diagnostics {
  readonly logFile: string;
  record(line: string): void;
  summary(): DiagnosticsSummary;
}

export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = deps.keep ?? DEFAULT_KEEP;
  const now = deps.now ?? (() => new Date());
  const logFile = join(deps.logsPath, LOG_NAME);

  const rotate = () => {
    rmSync(join(deps.logsPath, rotatedName(keep)), { force: true });
    for (let index = keep - 1; index >= 0; index -= 1) {
      const from = join(deps.logsPath, rotatedName(index));
      if (existsSync(from)) renameSync(from, join(deps.logsPath, rotatedName(index + 1)));
    }
  };

  return {
    logFile,
    record: (line) => {
      try {
        mkdirSync(deps.logsPath, { recursive: true });
        if (sizeOf(logFile) >= maxBytes) rotate();
        appendFileSync(logFile, `${now().toISOString()} ${line.replace(/\r?\n/g, "\n    ")}\n`);
      } catch {
        /* a log that cannot be written must never take the app with it */
      }
    },
    summary: () => {
      let logBytes = 0;
      for (let index = 0; index <= keep; index += 1) logBytes += sizeOf(join(deps.logsPath, rotatedName(index)));
      return {
        logsPath: deps.logsPath,
        crashReportsPath: deps.crashReportsPath,
        crashReports: countCrashReports(deps.crashReportsPath),
        logBytes
      };
    }
  };
}
