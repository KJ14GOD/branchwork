// Builds the speech helper (D-241) beside the compiled main process:
// `dist-electron/novus-speech`, from `native/speech/main.swift`, with the
// Command Line Tools' own swiftc. macOS only, and a Mac without swiftc gets no
// helper rather than no build — the app then says so on Settings → Voice.
// Skipped when the binary is newer than its source, so a routine build costs
// nothing here.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "main.swift");
const outDir = join(here, "..", "..", "dist-electron");
const out = join(outDir, "novus-speech");

if (process.platform !== "darwin") {
  console.warn("[speech] not macOS: no speech helper built; dictation will say so");
  process.exit(0);
}
try {
  execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
} catch {
  console.warn("[speech] swiftc not found (install the Xcode Command Line Tools): no speech helper built");
  process.exit(0);
}
if (existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs) process.exit(0);
mkdirSync(outDir, { recursive: true });
execFileSync(
  "swiftc",
  ["-O", "-swift-version", "5", "-o", out, source, "-framework", "Speech", "-framework", "AVFoundation"],
  { stdio: "inherit" }
);
