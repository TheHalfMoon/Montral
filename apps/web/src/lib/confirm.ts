/**
 * In-app confirmation for destructive or disruptive actions, in place of the browser's confirm() box: it matches the
 * product, can be translated in full and announces itself as a dialog. `ask` resolves true only when the person chose
 * the confirm button; Escape, Cancel or a click outside resolve false. Rendered by components/ConfirmHost.tsx, which the
 * app shell mounts once. Without a host (a page outside the shell) it falls back to the native box.
 */
export type AskOptions = {
  /** what happens, in one or two sentences; shown as the dialog's text */
  body: string;
  /** the verb on the confirm button: "Delete", "Revoke", "Turn off"… never "OK" */
  confirmLabel: string;
  /** a short heading; defaults to "Are you sure?" */
  title?: string;
  /** red confirm button (default true: everything routed here changes or removes something) */
  danger?: boolean;
};

export type AskRequest = AskOptions & { resolve: (ok: boolean) => void };

declare global {
  interface Window { __montralConfirmHost?: boolean }
}

export const ASK_EVENT = "montral:ask";

export function ask(body: string, confirmLabel: string, options: Omit<AskOptions, "body" | "confirmLabel"> = {}): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (!window.__montralConfirmHost) return Promise.resolve(window.confirm(body));
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<AskRequest>(ASK_EVENT, { detail: { body, confirmLabel, ...options, resolve } }));
  });
}
