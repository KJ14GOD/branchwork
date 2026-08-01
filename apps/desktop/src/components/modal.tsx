import { useCallback, useEffect, useRef, type ReactNode } from "react";

import {
  dismissesModal,
  engageModal,
  isTopmostModal,
  nextFocus,
  popModal,
  pushModal,
} from "./modal-behaviour.ts";

/**
 * Everything that can hold focus inside a dialog, in document order.
 *
 * Deliberately narrow — this is a trap, and a trap that scoops up
 * `[tabindex="-1"]` containers would park focus on something a person cannot
 * see they are on.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The one modal in this app.
 *
 * Three parts, and the split is the whole point: **the head and the foot do
 * not scroll, the body does.** The panel this replaced grew with its content
 * — the open-a-repository form appended every remembered mission underneath
 * itself — so a host with a dozen missions got a panel taller than the
 * window with its own Open button somewhere below the bottom edge. A modal
 * that cannot show its primary action is not a modal, and no amount of
 * page-level scrolling fixes it, because the thing that scrolled was the
 * page behind it.
 *
 * `onSubmit` makes the dialog a `<form>`, so a footer button can be a real
 * `type="submit"` and Enter in a field still submits. Without it the dialog
 * is a `<div>`.
 */
export const Modal = ({
  title,
  subtitle,
  children,
  footer,
  onClose,
  onSubmit,
  className,
  bodyClassName,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Pinned under the body. The primary action belongs here. */
  footer?: ReactNode;
  onClose: () => void;
  onSubmit?: (event: React.FormEvent) => void;
  className?: string;
  /** For a body that is a list rather than a form — see `.sheet__body--well`. */
  bodyClassName?: string;
}) => {
  const dialog = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);

  close.current = onClose;

  useEffect(() => {
    const node = dialog.current;
    // Captured before anything below moves focus — this is the control that
    // opened the modal, and it is where focus goes back to on close.
    const release = engageModal({
      returnFocusTo:
        typeof document === "undefined"
          ? null
          : (document.activeElement as HTMLElement | null),
      scrollLock: document.documentElement,
    });

    // Focus enters the dialog rather than staying behind it, or the first
    // keystroke goes to whatever was underneath. `data-autofocus` lets a
    // caller name the field somebody is actually going to type in; the first
    // focusable is the fallback, and the dialog itself is the floor.
    const target =
      node?.querySelector<HTMLElement>("[data-autofocus]") ??
      node?.querySelector<HTMLElement>(FOCUSABLE) ??
      node;

    target?.focus();

    // Escape lives on the document, not on the dialog: focus does not stay
    // inside reliably (a submit button that disables itself mid-request drops
    // it to `<body>`), and a dialog-scoped handler goes quiet the moment it
    // does. The stack keeps one keystroke from closing two modals.
    const id = Symbol("modal");

    pushModal(id);

    const onEscape = (event: KeyboardEvent) => {
      if (isTopmostModal(id) && dismissesModal(event)) {
        event.preventDefault();
        close.current();
      }
    };

    document.addEventListener("keydown", onEscape);

    return () => {
      document.removeEventListener("keydown", onEscape);
      popModal(id);
      release();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      const node = dialog.current;

      if (!node) {
        return;
      }

      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const target = nextFocus(
        focusable,
        document.activeElement as HTMLElement | null,
        event.shiftKey,
      );

      // Null means the browser's own next stop is already inside the dialog.
      if (target) {
        event.preventDefault();
        target.focus();
      }
    },
    [onClose],
  );

  const attach = useCallback((node: HTMLElement | null) => {
    dialog.current = node;
  }, []);

  const inside = (
    <>
      <header className="sheet__head">
        <h2 className="sheet__title">{title}</h2>
        {subtitle ? <p className="sheet__subtitle">{subtitle}</p> : null}
      </header>
      <div
        className={bodyClassName ? `sheet__body ${bodyClassName}` : "sheet__body"}
      >
        {children}
      </div>
      {footer ? <div className="sheet__foot">{footer}</div> : null}
    </>
  );

  const shared = {
    className: className ? `sheet modal ${className}` : "sheet modal",
    role: "dialog",
    "aria-modal": true,
    "aria-label": title,
    tabIndex: -1,
    onKeyDown,
  } as const;

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {onSubmit ? (
        <form {...shared} ref={attach} onSubmit={onSubmit}>
          {inside}
        </form>
      ) : (
        <div {...shared} ref={attach}>
          {inside}
        </div>
      )}
    </div>
  );
};
