import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { api, ApiError, type AuditEvent } from "../lib/api";

/** Action prefixes offered in the filter; any other prefix can be typed. */
const ACTIONS = [
  "monitor", "status_page", "status_page.share_link", "status_page.domain", "channel", "incident", "maintenance", "project",
  "member", "api_key", "workspace", "hook_inbox", "hook_event",
];
const TARGET_TYPES = ["monitor", "status_page", "status_page_share_link", "channel", "incident", "maintenance", "project", "member", "invitation", "api_key", "workspace", "hook_inbox", "hook_event"];

type Filters = { action: string; actorId: string; targetType: string; targetId: string; from: string; to: string };
const EMPTY: Filters = { action: "", actorId: "", targetType: "", targetId: "", from: "", to: "" };

/** The filters as query parameters; dates are whole local days (to includes its day). */
export function auditQuery(f: Filters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.action.trim()) q.set("action", f.action.trim());
  if (f.actorId.trim()) q.set("actorId", f.actorId.trim());
  if (f.targetType) q.set("targetType", f.targetType);
  if (f.targetId.trim()) q.set("targetId", f.targetId.trim());
  if (f.from) q.set("from", new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) {
    const end = new Date(`${f.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    q.set("to", end.toISOString());
  }
  return q;
}

const actorText = (e: AuditEvent) => (e.actorType === "system" ? t("System") : e.actorLabel || e.actorId || "—");
const actorKind = (e: AuditEvent) => (e.actorType === "api_key" ? t("API key") : e.actorType === "system" ? "" : t("User"));
const changesText = (e: AuditEvent) => {
  if (!e.changes) return "";
  const values = e.changes.values ?? {};
  const shown = e.changes.fields.map((f) => (f in values ? `${f}: ${String(values[f])}` : f));
  for (const [k, v] of Object.entries(values)) if (!e.changes.fields.includes(k)) shown.push(`${k}: ${String(v)}`);
  return shown.join(", ");
};

/** Workspace audit log for owners and admins: who changed what, when and from where. */
export default function AuditLog() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [forbidden, setForbidden] = useState(false);

  const load = async (filters: Filters, cursor: string | null) => {
    setBusy(true);
    setErr("");
    try {
      const q = auditQuery(filters);
      if (cursor) q.set("cursor", cursor);
      const page = await api.auditEvents(q.toString());
      setEvents((prev) => (cursor && prev ? [...prev, ...page.events] : page.events));
      setNext(page.next);
    } catch (x) {
      if (x instanceof ApiError && x.status === 403) setForbidden(true);
      else setErr((x as Error).message);
      if (!cursor) setEvents([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(EMPTY, null); }, []);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const exportHref = (format: "csv" | "jsonl") => {
    const q = auditQuery(applied);
    q.set("format", format);
    return `/api/audit-events/export?${q.toString()}`;
  };

  if (forbidden) {
    return (
      <>
        <div className="ph"><div><h1>{t("Audit log")}</h1></div></div>
        <div className="card sect"><p className="muted" role="status">{t("Only workspace owners and admins can view the audit log.")}</p></div>
      </>
    );
  }
  return (
    <>
      <div className="ph">
        <div><h1>{t("Audit log")}</h1><p className="muted">{t("Who changed what in this workspace, and when. Secret values such as passwords, tokens and webhook URLs are never recorded.")}</p></div>
        <div className="audit-exp">
          <a className="btn" href={exportHref("csv")} download>{t("Export CSV")}</a>
          <a className="btn" href={exportHref("jsonl")} download>{t("Export JSON Lines")}</a>
        </div>
      </div>
      <form className="card audit-flt" aria-label={t("Filter audit events")} onSubmit={(e) => { e.preventDefault(); setApplied(draft); load(draft, null); }}>
        <label className="fld">{t("Action")}
          <input className="in" list="audit-actions" value={draft.action} onChange={set("action")} placeholder="monitor" pattern="[a-z_.]{1,64}" />
          <datalist id="audit-actions">{ACTIONS.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
        <label className="fld">{t("Target type")}
          <select className="in" value={draft.targetType} onChange={set("targetType")}>
            <option value="">{t("Any")}</option>
            {TARGET_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="fld">{t("Target ID")}<input className="in" value={draft.targetId} onChange={set("targetId")} maxLength={200} /></label>
        <label className="fld">{t("Actor ID")}<input className="in" value={draft.actorId} onChange={set("actorId")} maxLength={200} /></label>
        <label className="fld">{t("From")}<input className="in" type="date" value={draft.from} onChange={set("from")} /></label>
        <label className="fld">{t("To")}<input className="in" type="date" value={draft.to} onChange={set("to")} /></label>
        <div className="audit-flt-b">
          <button className="btn primary" disabled={busy}>{t("Apply filters")}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(EMPTY); setApplied(EMPTY); load(EMPTY, null); }}>{t("Clear")}</button>
        </div>
      </form>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="card audit-wrap">
        <table className="audit-tbl">
          <caption className="audit-cap">{t("Audit events, newest first")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("Time")}</th>
              <th scope="col">{t("Actor")}</th>
              <th scope="col">{t("Action")}</th>
              <th scope="col">{t("Target")}</th>
              <th scope="col">{t("Changes")}</th>
              <th scope="col">{t("IP address")}</th>
            </tr>
          </thead>
          <tbody aria-busy={busy}>
            {events === null && <tr><td colSpan={6} className="muted">{t("Loading…")}</td></tr>}
            {events?.length === 0 && !busy && <tr><td colSpan={6} className="muted">{t("No audit events match these filters.")}</td></tr>}
            {events?.map((e) => (
              <tr key={e.id}>
                <td><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time></td>
                <td><span className="audit-actor">{actorText(e)}</span>{actorKind(e) && <small className="muted"> {actorKind(e)}</small>}</td>
                <td><code className="mono">{e.action}</code></td>
                <td><span>{e.targetType}</span>{e.targetId && <small className="mono muted audit-id"> {e.targetId}</small>}</td>
                <td className="audit-ch">{changesText(e) || <span className="muted">—</span>}</td>
                <td className="mono muted">{e.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next && (
        <div className="audit-more">
          <button className="btn" disabled={busy} onClick={() => load(applied, next)}>{busy ? t("Loading…") : t("Load older events")}</button>
        </div>
      )}
    </>
  );
}
