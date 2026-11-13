import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { operatorApi, type OperatorPlatformAuditEvent } from "../lib/operator-api";

type Source = "all" | "workspace" | "probe";

/** On-demand only: no operator audit data is loaded before the MFA-gated
 * console has been admitted. No local storage or cache; unmount invalidates
 * in-flight responses when the operator session is revoked. */
export function OperatorPlatformAudit({ onFailure }: { onFailure: (error: unknown) => string }) {
  const [target, setTarget] = useState("");
  const [source, setSource] = useState<Source>("all");
  const [applied, setApplied] = useState<{ target: string; source: Source } | null>(null);
  const [events, setEvents] = useState<OperatorPlatformAuditEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);

  useEffect(() => () => { sequence.current++; }, []);

  async function load(q: string, kind: Source, cursor?: string) {
    const run = ++sequence.current;
    setBusy(true); setError("");
    try {
      const data = await operatorApi.platformAudit(q, kind, cursor);
      if (run !== sequence.current) return;
      setEvents(data.events); setNext(data.next); setApplied({ target: q, source: kind });
    } catch (e) {
      if (run === sequence.current) setError(onFailure(e));
    } finally { if (run === sequence.current) setBusy(false); }
  }

  function submit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    void load(target.trim(), source);
  }

  return <section className="card sect" aria-label="Platform operator audit">
    <h2>Platform audit</h2>
    <p className="muted">Read-only operator actions recorded for workspace suspensions and probe drain controls. Search uses target IDs only; private notes and customer activity are excluded.</p>
    <form onSubmit={submit} style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
      <label className="fld" style={{ flex: "1 1 210px" }}>Target ID or probe region
        <input className="in" value={target} maxLength={100} autoComplete="off"
          onChange={(e) => setTarget(e.target.value)} placeholder="Search target" />
      </label>
      <label className="fld">Action source
        <select className="in" value={source} onChange={(e) => setSource(e.target.value as Source)}>
          <option value="all">All operator actions</option>
          <option value="workspace">Workspace suspensions</option>
          <option value="probe">Probe drains</option>
        </select>
      </label>
      <button className="btn" type="submit" disabled={busy}>Search audit</button>
      <button className="btn" type="button" disabled={busy || !applied}
        onClick={() => { if (applied) void load(applied.target, applied.source); }}>Refresh results</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {busy ? <p role="status">Loading operator actions...</p> :
      applied === null ? <p className="muted">Use Search audit to load actions.</p> :
      events.length === 0 ? <p className="muted">No retained operator actions match this filter.</p> :
      <div style={{ overflowX: "auto" }}>
        <table className="usage-tbl">
          <thead><tr><th>When</th><th>Source</th><th>Target</th><th>Action</th><th>Operator</th><th>Reason</th></tr></thead>
          <tbody>{events.map((event) => <tr key={`${event.source}:${event.id}`}>
            <td>{new Date(event.createdAt).toLocaleString()}</td>
            <td>{event.source}</td>
            <td className="mono" style={{ overflowWrap: "anywhere" }}>{event.target}</td>
            <td>{event.action}</td>
            <td className="mono" style={{ overflowWrap: "anywhere" }}>{event.operatorId ?? "Not recorded"}</td>
            <td>{event.reason ?? "-"}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    {next && applied && <button className="btn" type="button" disabled={busy}
      onClick={() => void load(applied.target, applied.source, next)}>Next 25 actions</button>}
    <p className="muted">This view is limited to existing retained operator events. Workspace operator identities were not recorded historically. No private notes are included.</p>
  </section>;
}
