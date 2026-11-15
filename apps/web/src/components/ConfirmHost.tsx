import { useEffect, useRef, useState } from "react";
import { ASK_EVENT, type AskRequest } from "../lib/confirm";
import { t } from "../lib/i18n";
import Modal from "./Modal";

/** Renders the requests made with lib/confirm.ts `ask()`, one at a time. Mounted once by the app shell. */
export default function ConfirmHost() {
  const [queue, setQueue] = useState<AskRequest[]>([]);
  const pending = useRef<AskRequest[]>([]);
  useEffect(() => {
    window.__montralConfirmHost = true;
    const on = (e: Event) => {
      pending.current.push((e as CustomEvent<AskRequest>).detail);
      setQueue([...pending.current]);
    };
    window.addEventListener(ASK_EVENT, on);
    return () => {
      window.__montralConfirmHost = false;
      window.removeEventListener(ASK_EVENT, on);
      for (const request of pending.current.splice(0)) request.resolve(false);
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const answer = (ok: boolean) => {
    if (pending.current[0] !== current) return;
    pending.current.shift();
    current.resolve(ok);
    setQueue([...pending.current]);
  };

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
