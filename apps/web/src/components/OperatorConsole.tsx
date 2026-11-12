import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  operatorApi, operatorActionConfirmed, OperatorRequestError,
  type OperatorRegion, type OperatorWorkspace, type OperatorWorkspaceDetail, type SuspensionReason,
} from "../lib/operator-api";

const REASONS: SuspensionReason[] = ["operator", "abuse", "payment", "legal"];

/** Unlinked platform console: all requests are protected by session + fresh second-factor checks on the server. */
export default function OperatorConsole() {
  const [access, setAccess] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [rows, setRows] = useState<OperatorWorkspace[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [detail, setDetail] = useState<OperatorWorkspaceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const requestSeq = useRef(0);
  // A denied operator session must never be re-opened by an older in-flight success.
  const accessRevoked = useRef(false);
  const [reason, setReason] = useState<SuspensionReason>("operator");
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [regions, setRegions] = useState<OperatorRegion[]>([]);
  const [probeEditing, setProbeEditing] = useState<string | null>(null);
  const [probeConfirm, setProbeConfirm] = useState("");
  const [probeNote, setProbeNote] = useState("");
  const [probesError, setProbesError] = useState("");

  function failure(e: unknown) {
    if (e instanceof OperatorRequestError && e.status === 403) {
      accessRevoked.current = true;
      requestSeq.current++;
      selectedRef.current = null;
      setAccess("denied");
      setRows([]); setNext(null); setDetail(null); setRegions([]);
      return "Operator access is unavailable. Sign in with password and a fresh second factor.";
    }
    return "The operator request failed. Refresh and try again.";
  }

  async function refresh(q: string, cursor?: string) {
    if (accessRevoked.current) return;
    const seq = ++requestSeq.current;
    setBusy(true); setError(""); setFeedback("");
    try {
      const data = await operatorApi.listWorkspaces(q, cursor);
      if (seq !== requestSeq.current || accessRevoked.current) return;
      setAccess("ok"); setRows(data.workspaces); setNext(data.next); setApplied(q);
    } catch (e) {
      if (seq !== requestSeq.current || accessRevoked.current) return;
      setError(failure(e));
      if (!(e instanceof OperatorRequestError && e.status === 403) && access === "loading") setAccess("error");
    } finally { if (seq === requestSeq.current) setBusy(false); }
  }

  async function refreshRegions() {
    if (accessRevoked.current) return;
    try {
      const loaded = await operatorApi.probes();
      if (!accessRevoked.current) { setRegions(loaded.regions); setProbesError(""); }
    } catch (e) { if (!accessRevoked.current) setProbesError(failure(e)); }
  }

  useEffect(() => {
    let alive = true;
    operatorApi.listWorkspaces().then(async (data) => {
      if (!alive || accessRevoked.current) return;
      setRows(data.workspaces); setNext(data.next); setAccess("ok");
      try { const probes = await operatorApi.probes(); if (alive && !accessRevoked.current) setRegions(probes.regions); }
      catch { if (alive && !accessRevoked.current) setProbesError("Probe regions could not be loaded."); }
    }).catch((e) => { if (alive) { setError(failure(e)); setAccess(e instanceof OperatorRequestError && e.status === 403 ? "denied" : "error"); } });
    return () => { alive = false; requestSeq.current++; };
  }, []);

  async function selectWorkspace(id: string) {
    if (accessRevoked.current) return;
    selectedRef.current = id;
    setDetail(null); setDetailLoading(true); setError(""); setFeedback(""); setConfirmation(""); setNote("");
    try {
      const data = await operatorApi.workspace(id);
      if (selectedRef.current === id && !accessRevoked.current) setDetail(data);
    } catch (e) { if (selectedRef.current === id && !accessRevoked.current) setError(failure(e)); }
    finally { if (selectedRef.current === id && !accessRevoked.current) setDetailLoading(false); }
  }

  async function changeWorkspace(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (accessRevoked.current || !detail || busy || !operatorActionConfirmed(detail.slug, confirmation, note, 500)) return;
    const id = detail.id;
    setBusy(true); setError(""); setFeedback("");
    try {
      if (detail.suspended) await operatorApi.unsuspend(id);
      else await operatorApi.suspend(id, reason, note);
      if (accessRevoked.current) return;
      setConfirmation(""); setNote("");
      const fresh = await operatorApi.workspace(id);
      if (selectedRef.current === id && !accessRevoked.current) setDetail(fresh);
      setRows((old) => old.map((w) => w.id === id ? { ...w, suspended: fresh.suspended } : w));
      setFeedback(fresh.suspended ? "Workspace suspension recorded." : "Workspace suspension lifted.");
    } catch (err) { setError(failure(err)); }
    finally { setBusy(false); }
  }

  async function changeRegion(region: OperatorRegion) {
    if (accessRevoked.current || busy || !operatorActionConfirmed(region.id, probeConfirm, probeNote, 200)) return;
    setBusy(true); setError(""); setFeedback("");
    try {
      if (region.drained) await operatorApi.undrain(region.id);
      else await operatorApi.drain(region.id, probeNote);
      if (accessRevoked.current) return;
      setProbeEditing(null); setProbeConfirm(""); setProbeNote("");
      await refreshRegions();
      setFeedback(region.drained ? "Probe region undrained." : "Probe region drained.");
    } catch (err) { setError(failure(err)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="ph"><div>
      <h1>Platform operations</h1>
      <p className="muted">Restricted operator console. Requires a recent password and second-factor sign-in. Actions are audited by the server.</p>
    </div></div>
    {access !== "ok" ? <section className="card sect" role="status">
      <h3>{access === "loading" ? "Checking operator access" : access === "denied" ? "Operator access denied" : "Console unavailable"}</h3>
      <p className="muted">{access === "loading" ? "Verifying your session." : "This page does not grant access to customer information. The server verifies operator permissions on every request."}</p>
    </section> : <div className="set-wrap">
      <section className="card sect" aria-label="Workspace search">
        <h2>Workspaces</h2>
        <form onSubmit={(e) => { e.preventDefault(); selectedRef.current = null; setDetail(null); void refresh(search); }}
          style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
          <label className="fld" style={{ flex: "1 1 260px" }}>Search workspaces
            <input className="in" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, slug, ID or member email" autoComplete="off" />
          </label>
          <button className="btn" disabled={busy} type="submit">Search</button>
          <button className="btn" disabled={busy} type="button" onClick={() => void refresh(applied)}>Refresh</button>
        </form>
        {rows.length === 0 ? <p className="muted">{busy ? "Loading workspaces..." : "No workspaces match."}</p> :
          <div style={{ display: "grid", gap: 8 }}>
            {rows.map((w) => <button key={w.id} type="button" className="btn"
              aria-pressed={detail?.id === w.id} disabled={busy} onClick={() => void selectWorkspace(w.id)}
              style={{ textAlign: "left", display: "flex", gap: 12, justifyContent: "space-between", flexWrap: "wrap" }}>
              <span>{w.name} <small className="muted">({w.slug})</small></span>
              <span>{w.suspended ? "Suspended" : "Active"} · {w.monitorCount} monitors</span>
            </button>)}
          </div>}
        {next && <button className="btn" type="button" disabled={busy} onClick={() => {
          selectedRef.current = null; setDetail(null); void refresh(applied, next);
        }}>Next 25 workspaces</button>}
      </section>

      {detailLoading && <p role="status">Loading workspace details...</p>}
      {detail && <section className="card sect" aria-label="Selected workspace">
        <h2>{detail.name}</h2>
        <div className="kv">
          <div><span>Workspace ID</span><b className="mono">{detail.id}</b></div>
          <div><span>Owner email</span><b>{detail.ownerEmail ?? "Unknown"}</b></div>
          <div><span>Members</span><b>{detail.memberCount}</b></div>
          <div><span>Plan</span><b>{detail.plan ?? "Not configured"}</b></div>
          <div><span>State</span><b>{detail.suspended ? "Suspended" : "Active"}</b></div>
        </div>
        {detail.suspension && <p className="muted">Suspended {new Date(detail.suspension.suspendedAt).toLocaleString()}. Reason: {detail.suspension.reason}. {detail.suspension.note ? "An operator note is recorded." : ""}</p>}
        <form onSubmit={(e) => void changeWorkspace(e)} style={{ display: "grid", gap: 12 }}>
          <h3>{detail.suspended ? "Lift suspension" : "Suspend workspace"}</h3>
          {!detail.suspended && <>
            <label className="fld">Reason
              <select className="in" value={reason} onChange={(e) => setReason(e.target.value as SuspensionReason)}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="fld">Private operator note (optional, 500 characters maximum)
              <textarea className="in" maxLength={500} rows={2} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </>}
          <label className="fld">Type the exact workspace slug <strong className="mono">{detail.slug}</strong> to confirm
            <input className="in" value={confirmation} autoComplete="off" spellCheck={false} onChange={(e) => setConfirmation(e.target.value)} />
          </label>
          <div><button type="submit" className="btn" disabled={busy || !operatorActionConfirmed(detail.slug, confirmation, note, 500)}>
            {busy ? "Recording..." : detail.suspended ? "Lift suspension" : "Suspend workspace"}
          </button></div>
        </form>
      </section>}

      <section className="card sect" aria-label="Probe region controls">
        <h2>Probe regions</h2>
        <p className="muted">Draining stops new probe requests after the configured cache delay; it does not cancel already-running checks. The local region cannot be drained.</p>
        <button className="btn" type="button" disabled={busy} onClick={() => void refreshRegions()}>Refresh regions</button>
        {probesError && <p role="status">{probesError}</p>}
        {regions.length === 0 && <p className="muted">No external probe regions configured.</p>}
        {regions.map((r) => <div key={r.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span><strong>{r.name}</strong> <small className="muted">({r.id}) · {r.status} · {r.monitors} monitors</small></span>
            {(r.configured || r.drained) && <button type="button" className="btn sm" disabled={busy}
              onClick={() => { setProbeEditing(probeEditing === r.id ? null : r.id); setProbeConfirm(""); setProbeNote(""); }}>
              {r.drained ? "Undrain" : "Drain"}
            </button>}
          </div>
          {probeEditing === r.id && <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {!r.drained && <label className="fld">Private drain note (optional)
              <input className="in" maxLength={200} autoComplete="off" value={probeNote} onChange={(e) => setProbeNote(e.target.value)} />
            </label>}
            <label className="fld">Type region ID <strong className="mono">{r.id}</strong> to confirm
              <input className="in" autoComplete="off" spellCheck={false} value={probeConfirm} onChange={(e) => setProbeConfirm(e.target.value)} />
            </label>
            <div><button type="button" className="btn" disabled={busy || !operatorActionConfirmed(r.id, probeConfirm, probeNote, 200)}
              onClick={() => void changeRegion(r)}>{r.drained ? "Confirm undrain" : "Confirm drain"}</button></div>
          </div>}
        </div>)}
      </section>
    </div>}
    {error && <p className="err" role="alert">{error}</p>}
    {feedback && <p className="state-ok" role="status">{feedback}</p>}
  </>;
}
