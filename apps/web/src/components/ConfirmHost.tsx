import { useEffect, useState } from "react";
import { ASK_EVENT, type AskRequest } from "../lib/confirm";
import { t } from "../lib/i18n";
import Modal from "./Modal";

/** Renders the requests made with lib/confirm.ts `ask()`, one at a time. Mounted once by the app shell. */
export default function ConfirmHost() {
  const [queue, setQueue] = useState<AskRequest[]>([]);
  useEffect(() => {
    window.__montralConfirmHost = true;
    const on = (e: Event) => setQueue((q) => [...q, (e as CustomEvent<AskRequest>).detail]);
    window.addEventListener(ASK_EVENT, on);
    return () => { window.removeEventListener(ASK_EVENT, on); window.__montralConfirmHost = false; };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const answer = (ok: boolean) => { current.resolve(ok); setQueue((q) => q.slice(1)); };

  return (
    <Modal key={queue.length} onClose={() => answer(false)} labelledBy="ask-title" describedBy="ask-body">
      <div className="card ask">
        <h2 id="ask-title">{current.title ?? t("Are you sure?")}</h2>
        <p className="muted" id="ask-body">{current.body}</p>
        <div className="ask-actions">
          {/* the safe choice gets focus first, so Enter alone never destroys anything */}
          <button type="button" className="btn" autoFocus onClick={() => answer(false)}>{t("Cancel")}</button>
          <button type="button" className={`btn ${current.danger === false ? "primary" : "danger"}`} onClick={() => answer(true)}>{current.confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}
