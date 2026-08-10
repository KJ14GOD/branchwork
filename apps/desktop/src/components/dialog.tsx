import { useEffect, useRef } from "react";

/**
 * The Dialog primitive DESIGN.md's list has always named, finally extracted.
 *
 * Three behaviours every dialog in the product owes a person, in one place
 * rather than copied per surface: **Esc closes it**, **clicking outside closes
 * it**, and focus returns to whatever opened it — on close, and only on close.
 *
 * The mount effect deliberately runs once. Its first version re-ran whenever
 * the caller's `onClose` identity changed, which in a shell that polls is
 * every few seconds — and its cleanup "restored" focus to the opener while the
 * person was mid-word in the dialog. A dialog that steals its own keyboard is
 * worse than no dialog, so the latest close handler is read through a ref and
 * the lifecycle belongs to the mount alone.
 *
 * Composition follows the same rule as everything else: the dialog carries one
 * border, and nothing inside it carries another (prohibited pattern 5).
 */
export function Dialog({
  label,
  onClose,
  children,
  testId
}: {
  /** What assistive tech announces; also what the surface is for. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const restoreTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Back where it came from, so closing a dialog does not dump the
      // keyboard at the top of the document — but quietly (D-106). Closing
      // with Esc is a key press, so the browser calls the restored focus
      // keyboard navigation and draws the ring; on a control that only exists
      // on hover, at the rail's edge, that ring is a white box around a button
      // nobody navigated to. The mark is suppressed until the person actually
      // uses the keyboard again, and the focus itself is untouched.
      const opener = restoreTo.current;
      if (!opener?.focus) return;
      opener.dataset.focusQuiet = "true";
      opener.focus({ preventScroll: true });
      const speak = () => {
        delete opener.dataset.focusQuiet;
        opener.removeEventListener("blur", speak);
        window.removeEventListener("keydown", speak, true);
      };
      opener.addEventListener("blur", speak);
      window.addEventListener("keydown", speak, true);
    };
  }, []);

  return (
    <>
      <div className="scrim" onClick={() => closeRef.current()} data-testid="dialog-scrim" />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        {children}
      </div>
    </>
  );
}
