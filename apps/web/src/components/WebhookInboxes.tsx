import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { api, ApiError, type HookInbox, type HookEvent, type HookResponse, type HookResponseContentType } from "../lib/api";

const CONTENT_TYPES: HookResponseContentType[] = ["text/plain", "application/json", "application/xml", "text/xml", "text/csv"];
const BODYLESS = new Set([204, 205, 304]);
const DEFAULT_RESPONSE: HookResponse = { status: 200, contentType: "text/plain", body: "", headers: [], delayMs: 0 };

/** The response a sender would see, as plain HTTP text; the fixed headers are added by the server and listed so nothing is a surprise. */
function previewResponse(r: HookResponse): string {
  const lines = [`HTTP/1.1 ${r.status}`];
  for (const h of r.headers) if (h.name.trim()) lines.push(`${h.name.trim()}: ${h.value}`);
  if (r.status >= 300 && r.status <= 399 && r.location) lines.push(`location: ${r.location}`);
  if (!BODYLESS.has(r.status)) lines.push(`content-type: ${r.contentType}; charset=utf-8`);
  lines.push("cache-control: private, no-store", "referrer-policy: no-referrer", "x-content-type-options: nosniff", "x-robots-tag: noindex, nofollow", "content-security-policy: default-src 'none'; sandbox; frame-ancestors 'none'");
  return lines.join("\n") + "\n\n" + (BODYLESS.has(r.status) ? "" : r.body);
}

/** Per-inbox receiver response (managers only; the API answers 403 to others and the editor says so). */
function ResponseEditor({ inbox }: { inbox: string }) {
  const [draft, setDraft] = useState<HookResponse>(DEFAULT_RESPONSE);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    let live = true;
    api.hookResponse(inbox).then((r) => {
      if (!live) return;
      setConfigured(!!r.response);
      setDraft(r.response ? { ...DEFAULT_RESPONSE, ...r.response } : DEFAULT_RESPONSE);
    }).catch((e) => { if (live) { setConfigured(false); setError((e as Error).message); } });
    return () => { live = false; };
  }, [inbox]);
  const set = (patch: Partial<HookResponse>) => { setSaved(""); setDraft((d) => ({ ...d, ...patch })); };
  const setHeader = (i: number, patch: Partial<{ name: string; value: string }>) => set({ headers: draft.headers.map((h, n) => (n === i ? { ...h, ...patch } : h)) });
  const redirect = draft.status >= 300 && draft.status <= 399;
  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setSaved("");
    try {
      const body: HookResponse = {
        ...draft,
        body: BODYLESS.has(draft.status) ? "" : draft.body,
        headers: draft.headers.filter((h) => h.name.trim() || h.value.trim()).map((h) => ({ name: h.name.trim(), value: h.value.trim() })),
        location: redirect && draft.location?.trim() ? draft.location.trim() : undefined,
      };
      const r = await api.setHookResponse(inbox, body);
      setDraft({ ...DEFAULT_RESPONSE, ...r.response });
      setConfigured(true);
      setSaved(t("Response saved. New requests get it right away."));
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setError(""); setSaved("");
    try {
      await api.resetHookResponse(inbox);
      setDraft(DEFAULT_RESPONSE);
      setConfigured(false);
      setSaved(t("Back to the default response: 202 with {\"received\":true}."));
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  };
  const ids = { status: `hr-status-${inbox}`, type: `hr-type-${inbox}`, body: `hr-body-${inbox}`, delay: `hr-delay-${inbox}`, loc: `hr-loc-${inbox}`, preview: `hr-preview-${inbox}` };
  return <section className="card sect hook-response" style={{ marginTop: 24 }} aria-labelledby={`hr-title-${inbox}`}>
    <div className="ph">
      <div><h2 id={`hr-title-${inbox}`}>{t("Receiver response")}</h2>
        <p className="muted">{configured ? t("This inbox answers captured requests with the response below.") : t("This inbox answers 202 with {\"received\":true}. Set a status, body and headers to mock the service your sender expects.")}</p></div>
    </div>
    <form onSubmit={save} style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label className="fld" htmlFor={ids.status} style={{ width: 140 }}>{t("Status code")}
          <input id={ids.status} className="in" type="number" min={200} max={599} step={1} required value={draft.status}
            onChange={(e) => set({ status: Number(e.target.value) })} />
        </label>
        <label className="fld" htmlFor={ids.type} style={{ minWidth: 200 }}>{t("Content type")}
          <select id={ids.type} className="in" value={draft.contentType} disabled={BODYLESS.has(draft.status)} onChange={(e) => set({ contentType: e.target.value as HookResponseContentType })}>
            {CONTENT_TYPES.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
          </select>
        </label>
        <label className="fld" htmlFor={ids.delay} style={{ width: 180 }}>{t("Delay (ms, up to 10000)")}
          <input id={ids.delay} className="in" type="number" min={0} max={10000} step={100} value={draft.delayMs}
            onChange={(e) => set({ delayMs: Number(e.target.value) })} />
        </label>
      </div>
      {redirect && <label className="fld" htmlFor={ids.loc}>{t("Redirect location (http or https URL)")}
        <input id={ids.loc} className="in" type="url" maxLength={2048} value={draft.location ?? ""} placeholder="https://example.com/next" onChange={(e) => set({ location: e.target.value })} />
      </label>}
      <label className="fld" htmlFor={ids.body}>{t("Response body (up to 64 KiB)")}
        <textarea id={ids.body} className="in mono" style={{ height: 120, padding: 12 }} disabled={BODYLESS.has(draft.status)} value={BODYLESS.has(draft.status) ? "" : draft.body}
          onChange={(e) => set({ body: e.target.value })} placeholder='{"ok":true}' />
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>{t("Response headers")}</legend>
        {draft.headers.map((h, i) => <div key={i} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="in" aria-label={`${t("Response header name")} ${i + 1}`} maxLength={64} value={h.name} placeholder="x-mock-id" onChange={(e) => setHeader(i, { name: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
          <input className="in" aria-label={`${t("Response header value")} ${i + 1}`} maxLength={1024} value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} style={{ flex: 2, minWidth: 180 }} />
          <button type="button" className="btn sm" aria-label={`${t("Remove response header")} ${i + 1}`} onClick={() => set({ headers: draft.headers.filter((_, n) => n !== i) })}>{t("Remove")}</button>
        </div>)}
        <div><button type="button" className="btn sm" disabled={draft.headers.length >= 20} onClick={() => set({ headers: [...draft.headers, { name: "", value: "" }] })}>{t("+ Response header")}</button></div>
        <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t("Up to 20 headers. Cookies, CORS, caching, security-policy and connection headers cannot be set, and the privacy headers below are always sent. HTML responses are not supported.")}</p>
      </fieldset>
      {draft.methods && <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t("Per-method overrides set through the API are kept when you save.")} ({Object.keys(draft.methods).join(", ")})</p>}
      <div>
        <b id={ids.preview}>{t("Preview")}</b>
        <pre className="code2" role="region" aria-labelledby={ids.preview} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 280, overflow: "auto" }} tabIndex={0}>{previewResponse(draft)}</pre>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {saved && <p className="muted" role="status">{saved}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" disabled={busy || configured === null}>{busy ? t("Saving…") : t("Save response")}</button>
        {configured && <button type="button" className="btn" disabled={busy} onClick={reset}>{t("Use default response")}</button>}
      </div>
      <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t("Only captured requests get this response. Invalid links (404), oversized (413), malformed (422) and rate-limited (429) requests keep their fixed answers, and replay never uses it.")}</p>
    </form>
  </section>;
}

export default function WebhookInboxes() {
  const [inboxes, setInboxes] = useState<HookInbox[] | null>(null);
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [method, setMethod] = useState("");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  // Each fetch is tagged; a response for an earlier inbox or filter is dropped
  // so a slow request can never show another inbox's payloads.
  const fetchSeq = useRef(0);
  async function load() {
    const list = (await api.hookInboxes()).inboxes;
    setInboxes(list);
  }
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);
  const fetchEvents = async (before?: string): Promise<void> => {
    if (!selected) return;
    const seq = ++fetchSeq.current;
    try {
      const d = await api.hookEvents(selected, { before, method, q: applied });
      if (seq !== fetchSeq.current) return;
      setEvents((prev) => before ? [...prev, ...d.events] : d.events);
      setNext(d.next);
    } catch (e) {
      // A superseded request must not report errors on the inbox now shown.
      if (seq !== fetchSeq.current) return;
      // The older page's cursor event was evicted by retention: start over.
      if (before && e instanceof ApiError && e.status === 410) { setNext(null); return fetchEvents(); }
      throw e;
    }
  };
  const report = (e: unknown) => setError((e as Error).message);
  useEffect(() => {
    if (!selected) { fetchSeq.current++; setEvents([]); setNext(null); return; }
    setEvents([]); setNext(null);
    fetchEvents().catch(report);
  }, [selected, method, applied]);
  const refreshEvents = () => fetchEvents();
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
      if (selected === id) { setSelected(""); setEvents([]); setNext(null); }
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
    {selected && <ResponseEditor key={selected} inbox={selected} />}
    {selected && <section style={{ marginTop: 24 }}>
      <div className="ph">
        <div><h2>{t("Captured events")}</h2><p className="muted">{t("Only users authorized for this Montral project can inspect event bodies.")}</p></div>
        <button className="btn sm" onClick={() => refreshEvents().catch(report)}>{t("Refresh")}</button>
      </div>
      <form className="hook-filter" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); if (query.trim() === applied) fetchEvents().catch(report); else setApplied(query.trim()); }}>
        <select className="in" aria-label={t("Method")} value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("All methods")}</option>
          {["POST", "PUT", "PATCH"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className="in" type="search" maxLength={200} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search headers and body")} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn sm">{t("Search")}</button>
      </form>
      <div className="card tbl">
        {!events.length && <div className="tr">{method || applied ? t("No events match this filter.") : t("No captured events yet.")}</div>}
        {events.map((e) => <div className="tr" key={e.id} style={{ display: "block", padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <b>{e.method} · {e.content_type || t("Unknown type")}{e.response_status ? <span className="muted" style={{ fontWeight: 400 }}> · {t("answered")} {e.response_status}</span> : null}</b>
            <span className="muted">{new Date(e.created_at).toLocaleString()}</span>
          </div>
          <details style={{ marginTop: 8 }}><summary>{t("Inspect request")}</summary>
            <b>{t("Headers")}</b><pre className="code2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(e.headers, null, 2)}</pre>
            <b>{t("Body")}</b><pre className="code2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.body}</pre>
            <EventActions inbox={selected} event={e} onDeleted={() => setEvents((prev) => prev.filter((x) => x.id !== e.id))} />
          </details>
        </div>)}
      </div>
      {next && <button className="btn sm" style={{ marginTop: 12 }} onClick={() => fetchEvents(next).catch(report)}>{t("Load older events")}</button>}
    </section>}
  </>;
}

type ReplayResult = Awaited<ReturnType<typeof api.replayHookEvent>>;

/** Delete one captured request, or resend it to a development endpoint. */
function EventActions({ inbox, event, onDeleted }: { inbox: string; event: HookEvent; onDeleted: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [error, setError] = useState("");
  const replay = async (e: React.SyntheticEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setResult(null);
    try { setResult(await api.replayHookEvent(inbox, event.id, url.trim())); }
    catch (x) { setError((x as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(t("Delete this captured request? This cannot be undone."))) return;
    setBusy(true); setError("");
    try { await api.deleteHookEvent(inbox, event.id); onDeleted(); }
    catch (x) { setError((x as Error).message); setBusy(false); }
  };
  return <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
    <form className="hook-replay" style={{ display: "flex", gap: 8, flexWrap: "wrap" }} onSubmit={replay}>
      <input className="in" type="url" required maxLength={2048} value={url} onChange={(x) => setUrl(x.target.value)}
        placeholder={t("https://your-dev-endpoint.example/webhook")} aria-label={t("Replay to URL")} style={{ flex: 1, minWidth: 200 }} />
      <button className="btn sm" disabled={busy || !url.trim()}>{busy ? t("Sending…") : t("Replay")}</button>
      <button type="button" className="btn sm" disabled={busy} onClick={remove}>{t("Delete event")}</button>
    </form>
    <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t("Sends this request's method, body and stored headers to the URL. Private and internal addresses are refused, redirects are not followed, and nothing about the replay is stored.")}</p>
    {error && <p className="err" role="alert">{error}</p>}
    {result && <div role="status">
      <b>{t("Response")} {result.status}</b> <span className="muted">· {result.durationMs} ms{result.truncated ? " · " + t("first 4 KiB") : ""}</span>
      <pre className="code2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result.body || t("(empty body)")}</pre>
    </div>}
  </div>;
}
