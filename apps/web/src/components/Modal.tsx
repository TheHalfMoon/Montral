import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog frame: the dimmed `.modal` backdrop and a `role="dialog"` box around the page's own content (usually a
 * `form.card`). It moves focus into the dialog, keeps Tab inside it, closes on Escape or a click on the backdrop
 * (unless `busy`), and gives focus back to whatever opened it.
 */
export default function Modal({ onClose, label, labelledBy, busy = false, className = "", backdropClose = true, children }: {
  onClose: () => void;
  /** false for long forms, where a stray click outside would throw away typing (Escape and the close button still work) */
  backdropClose?: boolean;
  /** extra classes on the backdrop */
  className?: string;
  /** accessible name when there is no visible heading to point at */
  label?: string;
  /** id of the visible heading that names the dialog */
  labelledBy?: string;
  /** while an action runs: Escape and the backdrop do nothing */
  busy?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = useRef(busy);
  blocked.current = busy;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    // no name given: the dialog is named by its own first heading
    if (el && !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
      const h = el.querySelector<HTMLElement>("h1,h2,h3");
      if (h) { h.id ||= `dlg-${Math.random().toString(36).slice(2, 9)}`; el.setAttribute("aria-labelledby", h.id); }
    }
    if (el) {
      const first = el.querySelector<HTMLElement>("[autofocus]") ?? el.querySelector<HTMLElement>("input:not([type=hidden]),textarea,select") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!box.current) return;
      if (e.key === "Escape") {
        if (!blocked.current) { e.stopPropagation(); close.current(); }
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div className={className ? `modal ${className}` : "modal"} onMouseDown={(e) => { if (backdropClose && e.target === e.currentTarget && !blocked.current) close.current(); }}>
      <div ref={box} className="modal-box" role="dialog" aria-modal="true" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
