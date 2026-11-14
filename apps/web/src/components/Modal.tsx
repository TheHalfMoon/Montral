import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog frame: the dimmed `.modal` backdrop and a `role="dialog"` box around the page's own content (usually a
 * `form.card`). It moves focus into the dialog, keeps Tab inside it, closes on Escape or a click on the backdrop
 * (unless `busy`), and gives focus back to whatever opened it.
 *
 * Keys are handled on the dialog itself, in the bubbling phase: a control inside (a dropdown, a combobox) that uses
 * Escape stops it first, IME composition is never treated as a close, and a dialog stacked on top (another React root,
 * such as the confirmation dialog) handles its own keys without this one reacting.
 */
export default function Modal({ onClose, label, labelledBy, describedBy, busy = false, className = "", backdropClose = true, children }: {
  onClose: () => void;
  /** accessible name when there is no visible heading to point at */
  label?: string;
  /** id of the visible heading that names the dialog */
  labelledBy?: string;
  /** id of the text that explains what the dialog is about (read after the name) */
  describedBy?: string;
  /** while an action runs: Escape and the backdrop do nothing */
  busy?: boolean;
  /** extra classes on the backdrop */
  className?: string;
  /** false for long forms, where a stray click outside would throw away typing (Escape and the close button still work) */
  backdropClose?: boolean;
  children: ReactNode;
}) {
  // captured while rendering, before any autoFocus inside the dialog moves focus away from the opener
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    // no name given: the dialog is named by its own first heading
    if (el && !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
      const h = el.querySelector<HTMLElement>("h1,h2,h3");
      if (h) { h.id ||= `dlg-${Math.random().toString(36).slice(2, 9)}`; el.setAttribute("aria-labelledby", h.id); }
    }
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("[autofocus]") ?? el.querySelector<HTMLElement>("input:not([type=hidden]),textarea,select") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    return () => {
      // back to the control that opened the dialog; if it is gone (a closed menu), to the page's main region
      if (opener && opener !== document.body && document.contains(opener)) opener.focus();
      else document.getElementById("main-content")?.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className={className ? `modal ${className}` : "modal"} onMouseDown={(e) => { if (backdropClose && e.target === e.currentTarget && !busy) onClose(); }}>
      <div
        ref={box}
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
