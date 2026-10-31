import { useEffect, useState } from "react";
import { api, ApiError, type MonthlyReviewCandidate, type MonthlyReconciliationSummary } from "../lib/api";

const monthPattern = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const evidencePattern = /^[A-Za-z0-9._:/-]{8,160}$/;

/** Always review the prior UTC calendar month; don't infer locale/time zone. */
export function defaultReviewMonth(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 7);
}

export function validReviewRequest(month: string, selected: MonthlyReviewCandidate | null, reference: string, acknowledged: boolean): boolean {
  return monthPattern.test(month) && !!selected && evidencePattern.test(reference) && acknowledged;
}

/** Deliberately not linked from production navigation. Its API remains
 * inaccessible unless a separate server-side owner-only flag is explicitly
 * enabled. This UI never displays email addresses, provider references, raw
 * evidence digests or report bodies. */
export default function MailReview() {
  const [month, setMonth] = useState(() => defaultReviewMonth());
  const [pending, setPending] = useState<MonthlyReviewCandidate[]>([]);
  const [summary, setSummary] = useState<MonthlyReconciliationSummary | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [decision, setDecision] = useState<"unresolved" | "provider_accepted">("unresolved");
  const [reference, setReference] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const candidate = pending.find((r) => r.recipientUserId === selected) ?? null;

  async function refresh(m: string, alive?: () => boolean) {
    if (!monthPattern.test(m)) { setError("Enter a valid month in YYYY-MM format."); return; }
    setLoading(true);
    setError("");
    setFeedback("");
    try {
      const [s, data] = await Promise.all([api.reconciliationSummary(m), api.reconciliationPending(m)]);
      if (alive && !alive()) return;
      setAvailable(true);
      setSummary(s);
      setPending(data.items);
      setSelected((previous) => data.items.some((r) => r.recipientUserId === previous) ? previous : "");
    } catch (e) {
      if (alive && !alive()) return;
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        setAvailable(false);
        setSummary(null);
        setPending([]);
      } else setError("Unable to load the review queue. Please try again.");
    } finally { if (!alive || alive()) setLoading(false); }
  }

  useEffect(() => {
    let alive = true;
    void refresh(month, () => alive);
    return () => { alive = false; };
    // The component is mounted anew on workspace changes by the app router.
    // Month changes only take effect via explicit Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !validReviewRequest(month, candidate, reference, acknowledged)) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const result = await api.reconcileMonthlyReport({
        month, recipientUserId: candidate!.recipientUserId,
        decision, evidenceRef: reference,
        acknowledgment: "I_verified_external_provider_evidence",
      });
      // Erase raw provider reference promptly; don't persist it in session or logs.
      setReference("");
      setAcknowledged(false);
      if (result.applied) {
        setSelected("");
        await refresh(month);
        setFeedback("Review recorded. No email was resent.");
      } else {
        await refresh(month);
        setFeedback("No review was recorded. This attempt may be in progress or already decided.");
      }
    } catch {
      setReference("");
      setAcknowledged(false);
      setError("The review could not be saved. Refresh the queue before trying again.");
    } finally { setBusy(false); }
  }

  return <>
    <div className="ph"><div><h1>Monthly mail review</h1><p className="muted">Internal operator tool · Staged, no automatic retries</p></div></div>
    <div className="set-wrap">
      {!available ? (
        <section className="card sect" role="status">
          <h3>Review tool unavailable</h3>
          <p className="muted">This feature is disabled or your session does not have workspace-owner access. No delivery records are available.</p>
        </section>
      ) : <>
        <section className="card sect">
          <h3>Review a calendar month</h3>
          <p className="muted">Only owner-authorized, older ambiguous attempts appear. No recipient addresses or message content is shown. Provider acceptance is not checked automatically.</p>
          <label className="fld">Report month (UTC)
            <input className="in" type="month" value={month} onChange={(e) => {
              setMonth(e.target.value); setSelected(""); setPending([]); setSummary(null);
              setReference(""); setAcknowledged(false); setFeedback("");
            }} />
          </label>
          <div><button type="button" className="btn" disabled={loading || busy || !monthPattern.test(month)} onClick={() => void refresh(month)}>{loading ? "Loading…" : "Refresh queue"}</button></div>
          {summary && <div className="kv" aria-label="Monthly delivery review totals">
            <div><span>Awaiting review</span><b>{summary.pending}</b></div>
            <div><span>Unresolved after review</span><b>{summary.unresolved}</b></div>
            <div><span>Owner-attested accepted</span><b>{summary.confirmed}</b></div>
          </div>}
        </section>
        <section className="card sect">
          <h3>Eligible attempts {pending.length > 0 ? `(${pending.length} shown)` : ""}</h3>
          <p className="muted">This list is limited to 50 records per month, with a 30-minute safety window. Identifiers are internal and are not email addresses. If more work remains, refresh after reviewing these entries.</p>
          {pending.length === 0 ? <p className="muted">{loading ? "Loading…" : "No eligible attempts loaded."}</p> :
            <div style={{ display: "grid", gap: 10 }} role="radiogroup" aria-label="Choose recipient attempt">
              {pending.map((r) => <label key={r.recipientUserId} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
                <input type="radio" name="selected-monthly-recipient" checked={selected === r.recipientUserId}
                  onChange={() => { setSelected(r.recipientUserId); setReference(""); setAcknowledged(false); setFeedback(""); }} />
                <span><strong className="mono" style={{ overflowWrap: "anywhere" }}>{r.recipientUserId}</strong>
                  <small className="muted" style={{ display: "block" }}>{r.state} · attempted {new Date(r.attemptedAt).toLocaleString()}</small></span>
              </label>)}
            </div>}
        </section>
        {candidate && <form className="card sect" onSubmit={(e) => void submit(e)}>
          <h3>Record a one-time decision</h3>
          <p className="muted">Review the actual external provider records before deciding. A timeout is not proof of delivery. Decisions cannot be edited through this tool and will never resend mail or refund credits.</p>
          <label className="fld">Decision
            <select className="in" value={decision} onChange={(e) => { setDecision(e.target.value as typeof decision); setAcknowledged(false); }}>
              <option value="unresolved">Unresolved — delivery cannot be verified</option>
              <option value="provider_accepted">Provider accepted — independently verified</option>
            </select>
          </label>
          <label className="fld">External provider evidence or incident reference
            <input className="in" type="text" value={reference} minLength={8} maxLength={160} autoComplete="off" spellCheck={false}
              placeholder="provider:confirmation-identifier" onChange={(e) => setReference(e.target.value)} required />
          </label>
          <p className="muted">Use an opaque provider ID or incident ticket, never an email address, credential, or message body. The server stores only a SHA-256 digest.</p>
          <label style={{ display: "flex", alignItems: "start", gap: 10 }}>
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>I personally reviewed external provider evidence supporting this decision and understand that no automatic email retry will occur.</span>
          </label>
          <div><button className="btn primary" type="submit" disabled={busy || loading || !validReviewRequest(month, candidate, reference, acknowledged)}>{busy ? "Recording…" : "Record decision once"}</button></div>
        </form>}
        {error && <p className="err" role="alert">{error}</p>}
        {feedback && <p className="state-ok" role="status">{feedback}</p>}
      </>}
    </div>
  </>;
}
