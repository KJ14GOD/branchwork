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

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

// `styles.css` @imports the feature files rather than containing them, so a
// rule that lives in `styles/` is invisible to a scan of the entry sheet. Both
// are read here for that reason; the Workroom is the default screen and its
// scroll containment is exactly the class of rule this file exists to hold.
const CSS = `${read("./styles.css")}\n${read("./styles/workroom.css")}`;

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

test("a focused surface scrolls inside the work column, not the column inside it", () => {
  // Same failure the sheet rule above holds, in the place it now matters most:
  // the Workroom is the only host mission screen, and Approaches, the file
  // browser and the raw log all open inside its centre column. Without the
  // containment here the column and the pane both scroll — two vertical rules
  // a few pixels apart, which is the "broken double divider" the Workroom's own
  // stylesheet already records having fixed once.
  assert.ok(declares(".workroom__work--focus", "overflow: hidden"));
  assert.ok(declares(".workroom__work--focus", "min-height: 0"));
  assert.ok(declares(".focus", "min-height: 0"));
  // The pane scrolls, not the container around it: every surface that opens in
  // here already carries its own `overflow` and its own `min-height: 0`,
  // because each was a grid column of a shell that gave it a definite height.
  assert.ok(declares(".focus__body", "overflow: hidden"));
  assert.ok(declares(".focus__body", "min-height: 0"));
  assert.ok(declares(".focus__body > *", "min-height: 0"));
  // The bar names the pane and carries the way out; it must not scroll away.
  assert.ok(declares(".focus__bar", "flex: none"));
});

test("the first screen cannot be made taller by remembering more", () => {
  assert.ok(declares(".inbox", "overflow: hidden"));
  assert.ok(declares(".inbox", "min-height: 0"));
  assert.ok(declares(".inbox__panel", "max-height: 100%"));
});
