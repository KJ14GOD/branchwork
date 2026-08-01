import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { Modal } from "./modal.tsx";
import {
  dismissesModal,
  engageModal,
  isTopmostModal,
  nextFocus,
  popModal,
  pushModal,
  type Focusable,
} from "./modal-behaviour.ts";

/**
 * The modal: what it does to the window, and what it may never do.
 *
 * The panel this replaced had no bound at all — it grew with its content, the
 * page scrolled behind it, Escape did nothing, and closing it left focus on
 * nothing in particular. Every test below is one of those four.
 */

const focusable = (name: string, log: string[]): Focusable => ({
  focus: () => log.push(name),
});

test("Escape closes the modal", () => {
  assert.equal(dismissesModal({ key: "Escape" }), true);
  assert.equal(dismissesModal({ key: "Enter" }), false);
  assert.equal(dismissesModal({ key: "Esc" }), false);
});

test("Escape a nested control already handled is not a second close", () => {
  assert.equal(
    dismissesModal({ key: "Escape", defaultPrevented: true }),
    false,
    "dismissing a select must not also throw away the form behind it",
  );
});

test("opening locks the document and closing unlocks it", () => {
  const html = { style: { overflow: "" } };
  const release = engageModal({ returnFocusTo: null, scrollLock: html });

  assert.equal(html.style.overflow, "hidden");

  release();

  assert.equal(html.style.overflow, "");
});

test("closing restores the lock that was there, not a hardcoded one", () => {
  // A second modal over the first must not unlock the page on its way out.
  const html = { style: { overflow: "hidden" } };
  const release = engageModal({ returnFocusTo: null, scrollLock: html });

  release();

  assert.equal(html.style.overflow, "hidden");
});

test("focus returns to the control that opened it", () => {
  const log: string[] = [];
  const opener = focusable("the + button", log);
  const release = engageModal({
    returnFocusTo: opener,
    scrollLock: { style: { overflow: "" } },
  });

  assert.deepEqual(log, [], "nothing is focused merely by opening");

  release();

  assert.deepEqual(log, ["the + button"]);
});

test("a modal opened from nothing focusable closes without throwing", () => {
  const release = engageModal({
    returnFocusTo: null,
    scrollLock: { style: { overflow: "" } },
  });

  release();
});

test("one Escape closes one modal, not every mounted one", () => {
  // Escape is handled on the document — a dialog-scoped handler goes quiet
  // once focus leaves the dialog, which is what a submit button disabling
  // itself does. That makes "which modal did this keystroke mean" a real
  // question with two mounted.
  const first = Symbol("first");
  const second = Symbol("second");

  pushModal(first);
  assert.equal(isTopmostModal(first), true);

  pushModal(second);
  assert.equal(isTopmostModal(first), false);
  assert.equal(isTopmostModal(second), true);

  popModal(second);
  assert.equal(isTopmostModal(first), true);

  popModal(first);
  assert.equal(isTopmostModal(first), false);
});

test("Tab wraps inside the dialog rather than escaping it", () => {
  const log: string[] = [];
  const first = focusable("first", log);
  const middle = focusable("middle", log);
  const last = focusable("last", log);
  const ring = [first, middle, last];

  // Mid-ring the browser is already right, and the handler leaves it alone.
  assert.equal(nextFocus(ring, first, false), null);
  assert.equal(nextFocus(ring, middle, true), null);

  // Both ends wrap, so focus never lands behind the overlay.
  assert.equal(nextFocus(ring, last, false), first);
  assert.equal(nextFocus(ring, first, true), last);

  // Focus on the dialog itself: either end is reachable from there.
  assert.equal(nextFocus(ring, null, false), first);
  assert.equal(nextFocus(ring, null, true), last);

  assert.equal(nextFocus([], null, false), null);
});

test("the title and the footer sit outside the scrolling body", () => {
  const markup = renderToStaticMarkup(
    <Modal
      title="Open a repository"
      subtitle="One repository at a time."
      footer={<button type="button">Open</button>}
      onClose={() => {}}
    >
      <p>Fields</p>
    </Modal>,
  );

  const head = markup.indexOf('class="sheet__head"');
  const body = markup.indexOf('class="sheet__body"');
  const foot = markup.indexOf('class="sheet__foot"');

  assert.ok(head !== -1 && body !== -1 && foot !== -1);
  assert.ok(
    head < body && body < foot,
    "head, then body, then foot — the primary action cannot be scrolled away",
  );
  assert.ok(markup.indexOf("Open a repository") < body);
  assert.ok(markup.indexOf("Fields") > body);
  assert.ok(markup.indexOf(">Open<") > foot);
});

test("a modal announces itself as one", () => {
  const markup = renderToStaticMarkup(
    <Modal title="Missions" onClose={() => {}}>
      <p>Nothing yet</p>
    </Modal>,
  );

  assert.ok(markup.includes('role="dialog"'));
  assert.ok(markup.includes('aria-modal="true"'));
  assert.ok(markup.includes('aria-label="Missions"'));
  assert.ok(markup.includes('class="overlay"'));
  assert.ok(markup.includes("sheet modal"));
});

test("a modal with a submit handler is a real form", () => {
  const markup = renderToStaticMarkup(
    <Modal title="Open" onClose={() => {}} onSubmit={() => {}}>
      <input />
    </Modal>,
  );

  assert.ok(markup.includes("<form"));

  const plain = renderToStaticMarkup(
    <Modal title="Open" onClose={() => {}}>
      <input />
    </Modal>,
  );

  assert.ok(!plain.includes("<form"));
});
