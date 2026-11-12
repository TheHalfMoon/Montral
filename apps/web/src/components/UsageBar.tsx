import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { alertKey, formatResetDate, joinMeters, METER_LABEL, usageAlert, usageBarStorage, type UsageAlert } from "../lib/usage-alerts";

/**
 * Notice bar of the hosted edition: an allowance is at 80 % or more, or used up. Links to Plan & usage and Billing.
 * Never shows on a deployment without plans (`metered: false`), so self-hosted users never see it.
 *
 * It sits above the page, so appearing once usage arrives would push the page down under a click already on its way.
 * Once this tab has shown a notice it remembers it (what the bar displays, no usage figures) and later loads paint it
 * with the page; usage then confirms, updates or clears it. Dismissing hides that exact notice for the session; a new
 * state (e.g. near, then used up) shows again.
 */
export default function UsageBar() {
  const [alert, setAlert] = useState<UsageAlert | null>(() => usageBarStorage().read());
  const [hidden, setHidden] = useState<string | null>(() => usageBarStorage().dismissed());
  // A remembered alert must never imply the current workspace role can open Billing.
  const [canManageBilling, setCanManageBilling] = useState(false);
  useEffect(() => {
    // answered by the shell's early read of /usage (lib/api.ts prefetch), so this costs no request of its own
    const load = () => {
      api.usage().then((u) => {
        const next = usageAlert(u);
        setCanManageBilling(u.metered && u.canManageBilling === true);
        usageBarStorage().write(next);
        setAlert(next);
        if (!next) setHidden(null);
      }).catch(() => {});
    };
    // another workspace: what this tab remembered belonged to the previous one
    const onScope = () => { usageBarStorage().write(null); setAlert(null); setHidden(null); setCanManageBilling(false); load(); };
    load();
    // a quota refusal: read the allowances again
    window.addEventListener("montral:usage", load);
    window.addEventListener("montral:scope", onScope);
    return () => { window.removeEventListener("montral:usage", load); window.removeEventListener("montral:scope", onScope); };
  }, []);
  if (!alert || hidden === alertKey(alert)) return null;
  const lang = document.documentElement.lang || undefined;
  const meters = joinMeters(alert.meters.map((k) => t(METER_LABEL[k])), lang);
  const date = formatResetDate(alert.resetsAt, lang);
  const text = alert.state === "exhausted"
    ? t("Used up for this period: {meters}. It resets on {date} (UTC).")
    : t("Nearly used up for this period: {meters}. It resets on {date} (UTC).");
  return (
    <div className={`usage-bar ${alert.state}`} role="status" data-usage-alert={alert.state}>
      <span className="usage-bar-t">{text.replace("{meters}", meters).replace("{date}", date)}</span>
      <span className="usage-bar-a">
        <a className="btn sm" href="/app/usage">{t("View usage")}</a>
        {canManageBilling && <a className="btn sm primary" href={alert.upgradeUrl}>{t("Upgrade plan")}</a>}
        <button className="icon-btn" aria-label={t("Dismiss")} onClick={() => { const k = alertKey(alert); usageBarStorage().dismiss(k); setHidden(k); }}>×</button>
      </span>
    </div>
  );
}
