import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { api, type HookInbox, type HookEvent } from "../lib/api";

export default function WebhookInboxes() {
  const [inboxes, setInboxes] = useState<HookInbox[] | null>(null);
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const list = (await api.hookInboxes()).inboxes;
    setInboxes(list);
  }
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    api.hookEvents(selected).then((d) => setEvents(d.events)).catch((e) => setError((e as Error).message));
  }, [selected]);
  const refreshEvents = async () => { if (selected) setEvents((await api.hookEvents(selected)).events); };
  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setFresh("");
    try {
      const r = await api.createHookInbox(name.trim());
      setName("");
      setFresh(location.origin + r.path);
      await load();
      setSelected(r.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!confirm(t("Delete this inbox and all captured events? This cannot be undone."))) return;
    setBusy(true); setError("");
    try {
      await api.deleteHookInbox(id);
      setFresh("");
      if (selected === id) { setSelected(""); setEvents([]); }
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <>
    <div className="ph">
      <div><h1>{t("Webhooks")}</h1><p className="muted">{t("Create an inbox, capture HTTP requests, and inspect their payloads. Seven-day retention; up to 32 KiB per event.")}</p></div>
    </div>
    <form className="card sect" style={{ display: "flex", gap: 12, alignItems: "end", marginBottom: 18 }} onSubmit={create}>
      <label className="fld" style={{ flex: 1 }}>{t("Inbox name")}
        <input className="in" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Payment events")} />
      </label>
      <button className="btn primary" disabled={busy || !name.trim()}>{busy ? t("Creating…") : t("+ New inbox")}</button>
    </form>
    {fresh && <div className="card fresh" role="status" style={{ marginBottom: 18 }}>
      <b>{t("Copy this secret receiver URL now — it will never be shown again.")}</b>
      <p className="muted">{t("Anyone with this URL can send events. Do not put it in screenshots, client-side source code or public logs.")}</p>
      <div className="fresh-r"><code className="mono" style={{ overflowWrap: "anywhere" }}>{fresh}</code>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(fresh)}>{t("Copy")}</button></div>
    </div>}
    {error && <p className="err" role="alert">{error}</p>}
    <div className="card tbl">
      <div className="tr th" style={{ gridTemplateColumns: "2fr 1fr auto" }}><span>{t("Inbox")}</span><span>{t("Created")}</span><span /></div>
      {inboxes === null && <div className="tr">{t("Loading…")}</div>}
      {inboxes?.length === 0 && <div className="tr">{t("No webhook inboxes yet.")}</div>}
      {inboxes?.map((i) => <div className="tr" key={i.id} style={{ gridTemplateColumns: "2fr 1fr auto", background: selected === i.id ? "var(--bg2, transparent)" : undefined }}>
        <button className="btn sm" style={{ justifySelf: "start" }} onClick={() => setSelected(i.id)}>{i.name}</button>
        <span className="muted">{new Date(i.created_at).toLocaleString()}</span>
        <button className="btn sm" disabled={busy} onClick={() => remove(i.id)}>{t("Delete")}</button>
      </div>)}
    </div>
    {selected && <section style={{ marginTop: 24 }}>
      <div className="ph">
        <div><h2>{t("Captured events")}</h2><p className="muted">{t("Only users authorized for this Montral project can inspect event bodies.")}</p></div>
        <button className="btn sm" onClick={() => refreshEvents().catch((e) => setError((e as Error).message))}>{t("Refresh")}</button>
      </div>
      <div className="card tbl">
        {!events.length && <div className="tr">{t("No captured events yet.")}</div>}
        {events.map((e) => <div className="tr" key={e.id} style={{ display: "block", padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <b>{e.method} · {e.content_type || t("Unknown type")}</b>
            <span className="muted">{new Date(e.created_at).toLocaleString()}</span>
          </div>
          <details style={{ marginTop: 8 }}><summary>{t("Inspect request")}</summary>
            <b>{t("Headers")}</b><pre className="code2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(e.headers, null, 2)}</pre>
            <b>{t("Body")}</b><pre className="code2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.body}</pre>
          </details>
        </div>)}
      </div>
    </section>}
  </>;
}
