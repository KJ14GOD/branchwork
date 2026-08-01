/**
 * What opening a modal does to the window, written without a DOM.
 *
 * None of this is interesting to look at and all of it is what breaks: the
 * page kept scrolling behind the old open-a-repository panel, Escape did
 * nothing, and closing left focus on `<body>` so the next Tab started from
 * the top of the window rather than from the button you had just pressed.
 *
 * It lives here rather than inline in `modal.tsx` because `node --test` in
 * this repo renders React to a string and has no `document` — a rule that
 * only exists inside an effect is a rule nothing can check. Every function
 * below takes the smallest shape it actually needs (something with `focus`,
 * something with a `style.overflow`), so a test can pass a plain object and
 * the component can pass the real element.
 */

/** Anything focusable. `HTMLElement` satisfies it; so does a stub. */
export type Focusable = { focus: () => void };

/** Anything whose inline overflow can be set — in practice `<html>`. */
export type ScrollLockTarget = { style: { overflow: string } };

/**
 * Whether a key event should close the modal.
 *
 * `defaultPrevented` matters: a nested control that already consumed Escape
 * for itself (a select being dismissed, an inline editor being abandoned)
 * has answered the keystroke, and closing the whole modal on top of that
 * throws away work the person did not ask to discard.
 */
export const dismissesModal = (event: {
  key: string;
  defaultPrevented?: boolean;
}): boolean => event.key === "Escape" && event.defaultPrevented !== true;

/**
 * Locks the document and remembers where focus came from.
 *
 * Returns the undo. Both halves are one function deliberately: they are one
 * decision, and the two bugs they prevent are the two halves of the same
 * "the modal left the window changed" complaint.
 *
 * The stylesheet already clips `html`/`body` (the app is a shell, not a
 * document), so the lock is usually a no-op in the packaged app — it is here
 * so the guarantee belongs to the modal rather than to a rule three thousand
 * lines away that a later pass could relax without ever looking at this.
 */
export const engageModal = ({
  returnFocusTo,
  scrollLock,
}: {
  /** Whatever had focus when the modal opened — the initiating control. */
  returnFocusTo: Focusable | null;
  scrollLock: ScrollLockTarget;
}): (() => void) => {
  const previousOverflow = scrollLock.style.overflow;

  scrollLock.style.overflow = "hidden";

  return () => {
    // Restored to what it was, not to a hardcoded value: a second modal
    // opened over this one would otherwise unlock the page on the way out.
    scrollLock.style.overflow = previousOverflow;
    returnFocusTo?.focus();
  };
};

/**
 * Which modal a keystroke belongs to, when more than one is mounted.
 *
 * Escape is handled on the document rather than on the dialog element,
 * because focus is not reliably inside the dialog: a submit button that
 * disables itself while the request is in flight drops focus to `<body>` on
 * the way, and a dialog-scoped handler then hears nothing — Escape silently
 * stopped working after a failed submit, which is exactly the moment somebody
 * wants it. A document listener needs this stack so two mounted modals do not
 * both close on one keystroke.
 */
const stack: symbol[] = [];

export const pushModal = (id: symbol): void => {
  stack.push(id);
};

export const popModal = (id: symbol): void => {
  const index = stack.lastIndexOf(id);

  if (index !== -1) {
    stack.splice(index, 1);
  }
};

export const isTopmostModal = (id: symbol): boolean => stack.at(-1) === id;

/**
 * Where Tab goes, so focus cannot leave the dialog.
 *
 * Returns null when the browser's own answer is already correct — moving
 * between two elements that are both inside the modal — so the caller only
 * has to preventDefault at the two ends.
 */
export const nextFocus = <T extends Focusable>(
  focusable: readonly T[],
  active: T | null,
  backwards: boolean,
): T | null => {
  if (focusable.length === 0) {
    return null;
  }

  const index = active === null ? -1 : focusable.indexOf(active);

  if (index === -1) {
    // Focus is on the dialog itself, or somewhere outside it. Either end is
    // reachable from there, and Tab should land on the first thing.
    return backwards ? (focusable.at(-1) ?? null) : (focusable[0] ?? null);
  }

  if (backwards && index === 0) {
    return focusable.at(-1) ?? null;
  }

  if (!backwards && index === focusable.length - 1) {
    return focusable[0] ?? null;
  }

  return null;
};
