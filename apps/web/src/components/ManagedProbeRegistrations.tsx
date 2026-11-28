import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { operatorActionConfirmed, operatorApi, type ManagedProbeRegistration, type ManagedProbeRegistrationEvent, type ManagedProbeCredentialAuditEvent } from "../lib/operator-api";

type Props = { onFailure: (error: unknown) => string };

/** Metadata-only controls. They never provision credentials or make a registration executable. */
export function ManagedProbeRegistrations({ onFailure }: Props) {
  const [registrations, setRegistrations] = useState<ManagedProbeRegistration[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [region, setRegion] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState<{ id: string; action: "suspend" | "restore" | "revoke" } | null>(null);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [events, setEvents] = useState<ManagedProbeRegistrationEvent[]>([]);
  const [auditError, setAuditError] = useState("");
  const [credentialAuditFor, setCredentialAuditFor] = useState<string | null>(null);
  const [credentialEvents, setCredentialEvents] = useState<ManagedProbeCredentialAuditEvent[]>([]);
  const [credentialAuditError, setCredentialAuditError] = useState("");
  const alive = useRef(true);
  const listSeq = useRef(0);
  const auditSeq = useRef(0);
  const credentialAuditSeq = useRef(0);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;

  async function load(after?: string) {
    const seq = ++listSeq.current;
    setLoading(true); setError("");
    try {
      const page = await operatorApi.managedProbes(50, after);
      if (!alive.current || listSeq.current !== seq) return;
      setRegistrations((old) => after ? [...old, ...page.registrations] : page.registrations);
      setNext(page.nextCursor);
    } catch (e) { if (alive.current && listSeq.current === seq) setError(onFailureRef.current(e)); }
    finally { if (alive.current && listSeq.current === seq) setLoading(false); }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; listSeq.current++; auditSeq.current++; credentialAuditSeq.current++; };
  }, []);

  async function create(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !region.trim() || !displayName.trim() || !endpointUrl.trim()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await operatorApi.registerManagedProbe({ region: region.trim(), displayName: displayName.trim(), endpointUrl: endpointUrl.trim() });
      if (!alive.current) return;
      setRegion(""); setDisplayName(""); setEndpointUrl("");
      await load();
      setMessage("Managed probe metadata registered. No credential was created and monitoring remains disabled.");
    } catch (err) { if (alive.current) setError(onFailureRef.current(err)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function transition(registration: ManagedProbeRegistration) {
    const action = pending;
    if (!action || action.id !== registration.region || confirm !== registration.region || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await operatorApi.transitionManagedProbe(registration.region, action.action);
      if (!alive.current) return;
      setPending(null); setConfirm("");
      await load();
      setMessage(`Managed probe metadata ${action.action === "revoke" ? "revoked" : action.action === "suspend" ? "suspended" : "restored"}. Monitoring remains disabled.`);
    } catch (err) { if (alive.current) setError(onFailureRef.current(err)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function toggleAudit(id: string) {
    if (auditFor === id) { auditSeq.current++; setAuditFor(null); setEvents([]); setAuditError(""); return; }
    const seq = ++auditSeq.current;
    setAuditFor(id); setEvents([]); setAuditError("");
    try {
      const result = await operatorApi.managedProbeAudit(id);
      if (alive.current && auditSeq.current === seq) setEvents(result.events);
    } catch (err) { if (alive.current && auditSeq.current === seq) setAuditError(onFailureRef.current(err)); }
  }

  async function toggleCredentialAudit(id: string) {
    if (credentialAuditFor === id) { credentialAuditSeq.current++; setCredentialAuditFor(null); setCredentialEvents([]); setCredentialAuditError(""); return; }
    const seq = ++credentialAuditSeq.current;
    setCredentialAuditFor(id); setCredentialEvents([]); setCredentialAuditError("");
    try {
      const result = await operatorApi.managedProbeCredentialAudit(id);
      if (alive.current && credentialAuditSeq.current === seq) setCredentialEvents(result.events);
    } catch (err) { if (alive.current && credentialAuditSeq.current === seq) setCredentialAuditError(onFailureRef.current(err)); }
  }

  return <section className="card sect" aria-label="Managed probe registrations">
    <h2>Managed probe registrations</h2>
    <p className="muted">This inventory stores operator-managed metadata only. Registration does not create or deliver credentials, validate endpoint connectivity, enable monitoring, or prove probe software identity. Deployment-configured probes continue to run independently.</p>
    <form onSubmit={(e) => void create(e)} style={{ display: "grid", gap: 10 }}>
      <h3>Register metadata</h3>
      <label className="fld">Region ID
        <input className="in" maxLength={24} autoComplete="off" value={region} onChange={(e) => setRegion(e.target.value)} />
      </label>
      <label className="fld">Display name
        <input className="in" maxLength={60} autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="fld">HTTPS probe endpoint
        <input className="in" maxLength={2048} type="url" autoComplete="url" placeholder="https://probe.example/api/probe/region-id" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
      </label>
      <div><button className="btn" type="submit" disabled={busy || !region.trim() || !displayName.trim() || !endpointUrl.trim()}>{busy ? "Saving..." : "Register metadata"}</button></div>
    </form>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
      <h3 style={{ margin: 0, flex: 1 }}>Registered regions</h3>
      <button className="btn sm" type="button" disabled={busy || loading} onClick={() => void load()}>Refresh</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {loading ? <p role="status">Loading managed probe registrations...</p> : registrations.length === 0 ? <p className="muted">No managed probe metadata is registered.</p> :
      <div style={{ display: "grid", gap: 12 }}>
        {registrations.map((registration) => <article key={registration.region} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div className="kv">
            <div><span>Region</span><b>{registration.displayName} <small className="muted">({registration.region})</small></b></div>
            <div><span>Registration state</span><b>{registration.state}</b></div>
            <div><span>Endpoint</span><b className="mono" style={{ overflowWrap: "anywhere" }}>{registration.endpointUrl}</b></div>
            <div><span>Monitoring</span><b>{registration.executionEnabled ? "Enabled" : "Disabled"}</b></div>
          </div>
          <p className="muted">Updated {new Date(registration.updatedAt).toLocaleString()} by {registration.updatedBy}.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm" type="button" disabled={busy} aria-expanded={auditFor === registration.region} onClick={() => void toggleAudit(registration.region)}>
              {auditFor === registration.region ? "Hide registration audit" : "Registration audit"}
            </button>
            <button className="btn sm" type="button" disabled={busy} aria-expanded={credentialAuditFor === registration.region} onClick={() => void toggleCredentialAudit(registration.region)}>
              {credentialAuditFor === registration.region ? "Hide credential history" : "Credential history"}
            </button>
            {registration.state !== "revoked" && <>
              <button className="btn sm" type="button" disabled={busy} onClick={() => { setPending({ id: registration.region, action: registration.state === "suspended" ? "restore" : "suspend" }); setConfirm(""); }}>
                {registration.state === "suspended" ? "Restore metadata" : "Suspend metadata"}
              </button>
              <button className="btn sm" type="button" disabled={busy} onClick={() => { setPending({ id: registration.region, action: "revoke" }); setConfirm(""); }}>Revoke metadata</button>
            </>}
          </div>
          {auditFor === registration.region && <section aria-label={`Registration audit for ${registration.region}`}>
            <h4>Registration audit history</h4>
            {auditError ? <p role="alert">{auditError}</p> : events.length === 0 ? <p className="muted">No registration events found.</p> :
              <div style={{ overflowX: "auto" }}><table className="usage-tbl">
                <thead><tr><th>When</th><th>Action</th><th>Operator</th></tr></thead>
                <tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.createdAt).toLocaleString()}</td><td>{event.action}</td><td className="mono" style={{ overflowWrap: "anywhere" }}>{event.operatorId}</td></tr>)}</tbody>
              </table></div>}
          </section>}
          {credentialAuditFor === registration.region && <section aria-label={`Credential history for ${registration.region}`}>
            <ManagedProbeCredentialAuditView region={registration.region} events={credentialEvents} error={credentialAuditError} />
          </section>}
          {pending?.id === registration.region && <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            <p className="muted">This changes registration metadata only. It does not enable or stop configured probe checks. Revocation is terminal.</p>
            <label className="fld">Type the exact region ID <strong className="mono">{registration.region}</strong> to confirm
              <input className="in" autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button className="btn" type="button" disabled={busy || !operatorActionConfirmed(registration.region, confirm, "", 0)} onClick={() => void transition(registration)}>
              {pending.action === "revoke" ? "Confirm metadata revocation" : pending.action === "suspend" ? "Confirm metadata suspension" : "Confirm metadata restore"}
            </button>
          </div>}
        </article>)}
        {next && <button className="btn" type="button" disabled={busy || loading} onClick={() => void load(next)}>Load next registrations</button>}
      </div>}
  </section>;
}

export function ManagedProbeCredentialAuditView({ region, events, error }: {
  region: string; events: ManagedProbeCredentialAuditEvent[]; error: string;
}) {
  return <>
    <h4>Credential lifecycle history</h4>
    <p className="muted">This history contains version and event metadata only. It never displays credentials, ciphertext, encryption nonces, or enrollment tokens; history does not mean monitoring is enabled.</p>
    {error ? <p role="alert">{error}</p> : events.length === 0 ? <p className="muted">No credential lifecycle events found for {region}.</p> :
      <div style={{ overflowX: "auto" }}><table className="usage-tbl">
        <thead><tr><th>When</th><th>Action</th><th>Version</th><th>Actor</th></tr></thead>
        <tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.createdAt).toLocaleString()}</td><td>{event.action}</td><td className="mono" style={{ overflowWrap: "anywhere" }}>{event.versionId}</td><td className="mono" style={{ overflowWrap: "anywhere" }}>{event.actorId}</td></tr>)}</tbody>
      </table></div>}
  </>;
}
