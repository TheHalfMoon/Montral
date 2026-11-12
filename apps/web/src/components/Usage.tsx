import { useEffect, useState } from "react";
import { api, type Monitor, type Quota, type Usage as UsageData } from "../lib/api";
import { t } from "../lib/i18n";
import { formatResetDate, meterLevel, resetDate } from "../lib/usage-alerts";

const fmt = (n: number) => n.toLocaleString();
const lang = () => (typeof document !== "undefined" && document.documentElement.lang) || undefined;
const day = (iso: string) => formatResetDate(new Date(iso), lang());

/** One allowance: used / limit, a bar, and what resets when. Amber from 80 %, red once used up. */
function Meter({ label, q, note, upgradeUrl }: { label: string; q: Quota; note: string; upgradeUrl?: string }) {
  const { pct, state } = meterLevel(q);
  return (
    <div className={`card meter${state === "exhausted" ? " exhausted" : ""}`} data-meter-state={state}>
      <div className="meter-h"><span className="k">{label}</span>{state !== "ok" && <span className={`pill ${state === "exhausted" ? "down" : "warn"}`}>{state === "exhausted" ? t("Used up") : `${t("Used")} ${pct}%`}</span>}</div>
      <div><span className="meter-n">{fmt(q.used)}</span><span className="muted mono"> / {fmt(q.limit)}</span></div>
      <div className="track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}%`}><div className={`fill${state === "exhausted" ? " down" : state === "near" ? " warn" : ""}`} style={{ width: `${pct}%` }} /></div>
      <small className="muted">{note} {t("Resets on")} {day(q.periodEnd)}.</small>
      {state === "exhausted" && <small>{t("Used up until the reset.")} {upgradeUrl && <a href={upgradeUrl}>{t("Upgrade your plan")}</a>}</small>}
    </div>
  );
}

/** Plan, allowances and what uses them. Shown only where the deployment has plans; self-hosted never links here. */
export default function Usage() {
  const [u, setU] = useState<UsageData | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  useEffect(() => {
    api.usage().then(setU).catch(() => setU({ metered: false }));
    api.monitors().then(setMonitors).catch(() => {});
  }, []);
  if (!u) return null;
  if (!u.metered) {
    return (
      <>
        <div className="ph"><div><h1>{t("Plan & usage")}</h1></div></div>
        <div className="card sect"><p className="muted">{t("This deployment has no plans or usage limits.")}</p></div>
      </>
    );
  }
  const { plan, credits, emails, webhookEvents, browserSeconds, activeMonitors } = u;
  // the checks each monitor makes in a month at its interval: where the allowance goes
  const perMonth = (m: Monitor) => (m.type === "heartbeat" || m.status === "paused" ? 0 : Math.round((30 * 86400) / Math.max(1, m.intervalSec)));
  const top = [...monitors].map((m) => ({ m, n: perMonth(m) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
  const total = monitors.reduce((s, m) => s + perMonth(m), 0);
  const upgradeUrl = u.canManageBilling === true ? plan?.upgradeUrl : undefined;
  const capPct = plan?.maxActiveMonitors ? Math.min(100, Math.round((activeMonitors / plan.maxActiveMonitors) * 100)) : 0;
  return (
    <>
      <div className="ph"><div><h1>{t("Plan & usage")}</h1><p className="muted">{t("Usage is counted per workspace and resets every billing period.")}</p></div></div>
      <div className="usage-wrap">
        {plan && (
          <section className="card sect plan-card">
            <div>
              <span className="k">{t("Current plan")}</span>
              <h2>{plan.name}</h2>
              <small className="muted">{t("Next reset")} {formatResetDate(resetDate(u), lang())} (UTC)</small>
            </div>
            {u.canManageBilling === true && <div className="plan-actions">
              {plan.manageUrl && <a className="btn" href={plan.manageUrl}>{t("Manage billing")}</a>}
              {plan.upgradeUrl && <a className="btn primary" href={plan.upgradeUrl}>{t("Change plan")}</a>}
            </div>}
          </section>
        )}
        <div className="meters">
          {credits && <Meter label={t("Checks")} q={credits} note={t("Heartbeat monitors do not count.")} upgradeUrl={upgradeUrl} />}
          {plan && (
            <div className="card meter">
              <div className="meter-h"><span className="k">{t("Active monitors")}</span>{capPct >= 100 && <span className="pill warn">{t("Limit reached")}</span>}</div>
              <div><span className="meter-n">{fmt(activeMonitors)}</span>{plan.maxActiveMonitors !== null && <span className="muted mono"> / {fmt(plan.maxActiveMonitors)}</span>}</div>
              {plan.maxActiveMonitors !== null && <div className="track"><div className={`fill${capPct >= 100 ? " warn" : ""}`} style={{ width: `${capPct}%` }} /></div>}
              <small className="muted">{t("Paused monitors do not count and use no checks.")}</small>
            </div>
          )}
          {emails && <Meter label={t("Email notifications")} q={emails} note={t("Alert emails and status page subscriber emails.")} upgradeUrl={upgradeUrl} />}
          {webhookEvents && <Meter label={t("Webhook events")} q={webhookEvents} note={t("Requests captured by webhook inboxes.")} upgradeUrl={upgradeUrl} />}
          {browserSeconds && <Meter label={t("Browser check time")} q={browserSeconds} note={t("Seconds. Each check reserves its journey timeout; unused seconds are returned.")} upgradeUrl={upgradeUrl} />}
        </div>
        {top.length > 0 && (
          <section className="card sect">
            <h3>{t("Monitors that use the most checks")}</h3>
            <p className="muted">{t("Estimated from each monitor's interval. Lengthen the interval of monitors that matter less.")}</p>
            <table className="usage-tbl">
              <thead><tr><th>{t("Monitor")}</th><th>{t("Interval")}</th><th>{t("Checks / month")}</th><th>{t("Share")}</th></tr></thead>
              <tbody>
                {top.map(({ m, n }) => (
                  <tr key={m.id}><td>{m.name}</td><td className="mono">{m.intervalSec >= 60 ? `${Math.round(m.intervalSec / 60)} min` : `${m.intervalSec}s`}</td><td className="mono">{fmt(n)}</td><td className="mono">{total ? ((n / total) * 100).toFixed(1) : "0"}%</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}
