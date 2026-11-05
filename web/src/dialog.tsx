// One modal: centred over a dimmed backdrop, portalled to the body. Esc and the backdrop close it, Tab stays inside,
// and focus goes back where it was on close. Not the native <dialog>: its top layer would hide the $ picker's portal.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])";

export function Dialog({ open, onClose, label, className = "", initialFocus, children }: {
  open: boolean; onClose: () => void; label: string; className?: string;
  /** a selector inside the dialog to focus first; else the first focusable element */
  initialFocus?: string; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const close = useRef(onClose); close.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    const el = box.current;
    const first = (initialFocus && el?.querySelector<HTMLElement>(initialFocus)) || el?.querySelector<HTMLElement>(FOCUSABLE) || el;
    first?.focus({ preventScroll: true });
    return () => { const b = back.current; if (b && document.contains(b)) b.focus({ preventScroll: true }); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc closes from anywhere, even when the focused element just left the DOM. Bubbling on document runs after
  // inner handlers (the $ picker stops its own Esc) and before window listeners, which it stops.
  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close.current(); } };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);
  // The page under a modal does not scroll.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const a = items[0], z = items[items.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === a || at === box.current)) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && at === z) { e.preventDefault(); a.focus(); }
  };
  return createPortal(
    <div className="dlg-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close.current(); }}>
      <div ref={box} className={`dlg ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKey}>
        {children}
      </div>
    </div>, document.body,
  );
}
