import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The handful of stylesheet rules that are behaviour, not taste.
 *
 * `skills/novus-ui/SKILL.md` says it plainly: the gate does not see pixels,
 * and every layout bug this app has had was found by measuring the running
 * window. That is still true, and this file does not pretend otherwise — a
 * declaration being present does not prove a box is the right size, and these
 * screens were checked on screen at 1280x800 and 1440x900 as well.
 *
 * What it does hold is the small set of declarations whose *absence* is a
 * known, specific failure: a modal that grows past the bottom of the window
 * with its own primary action below the fold, a page that scrolls behind an
 * overlay, and a body that grows instead of scrolling. Each was real, each
 * was deleted at some point by a well-meaning tidy, and none of them makes
 * anything else in the repository fail.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list contains exactly `selector`. */
const declarationsFor = (selector: string): string[] =>
  CSS.split("}")
    .map((chunk) => chunk.split("{"))
    .filter((parts) => parts.length >= 2)
    .filter((parts) =>
      (parts.at(-2) ?? "")
        .split(",")
        .map((one) => one.trim())
        .includes(selector),
    )
    .map((parts) => parts.at(-1) ?? "");

const declares = (selector: string, declaration: string): boolean =>
  declarationsFor(selector).some((block) => block.includes(declaration));

test("the app is a shell, not a document — nothing scrolls the page", () => {
  assert.ok(declarationsFor("html").length > 0, "the rule still exists");
  assert.ok(declares("html", "overflow: hidden"));
  assert.ok(declares("body", "overflow: hidden"));
  assert.ok(declares("#root", "overflow: hidden"));
});

test("an overlay is a viewport, not a scroller", () => {
  // It used to be `overflow-y: auto`, which is what let the panel on it grow
  // taller than the window and simply scroll away.
  assert.ok(declares(".overlay", "overflow: hidden"));
  assert.ok(!declares(".overlay", "overflow-y: auto"));
  assert.ok(declares(".overlay", "position: fixed"));
});

test("a modal is bounded by the window", () => {
  assert.ok(declares(".modal", "max-height: 100%"));
  assert.ok(declares(".modal", "max-width: 100%"));
});

test("a sheet's body is what scrolls, and it can", () => {
  // `min-height: 0` is the whole trick: without it a flex item's automatic
  // minimum is its content's, so the body grows and the sheet grows with it.
  assert.ok(declares(".sheet", "flex-direction: column"));
  assert.ok(declares(".sheet", "min-height: 0"));
  assert.ok(declares(".sheet__body", "overflow-y: auto"));
  assert.ok(declares(".sheet__body", "min-height: 0"));
});

test("the head and the foot do not scroll with it", () => {
  assert.ok(declares(".sheet__head", "flex: none"));
  assert.ok(declares(".sheet__foot", "flex: none"));
});

test("the first screen cannot be made taller by remembering more", () => {
  assert.ok(declares(".inbox", "overflow: hidden"));
  assert.ok(declares(".inbox", "min-height: 0"));
  assert.ok(declares(".inbox__panel", "max-height: 100%"));
});
