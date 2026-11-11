import { useEffect, useState } from "react";
import { api, type Usage } from "../lib/api";
import { t } from "../lib/i18n";
import { alertKey, formatResetDate, METER_LABEL, usageAlert } from "../lib/usage-alerts";

const KEY = "montral_usage_bar_hidden";

/**
 * Notice bar of the hosted edition: an allowance is at 80 % or more, or used up. Links to Plan & usage and Billing.
 * Never shows on a deployment without plans (`metered: false`), so self-hosted users never see it. Dismissing hides
 * this exact notice for the browser session; a new state (e.g. near → used up) shows again.
 */
export default function UsageBar() {
  const [u, setU] = useState<Usage | null>(null);
  const [hidden, setHidden] = useState<string | null>(() => { try { return sessionStorage.getItem(KEY); } catch { return null; } });
  useEffect(() => {
    const load = () => { api.usage().then(setU).catch(() => {}); };
    load();
    // a quota refusal or another workspace: read the allowances again
    window.addEventListener("montral:usage", load);
    window.addEventListener("montral:scope", load);
    return () => { window.removeEventListener("montral:usage", load); window.removeEventListener("montral:scope", load); };
  }, []);
  const alert = usageAlert(u);
  if (!alert || hidden === alertKey(alert)) return null;
  const lang = document.documentElement.lang || undefined;
  const meters = alert.meters.map((k) => t(METER_LABEL[k])).join(", ");
  const date = formatResetDate(alert.resetsAt, lang);
  const text = alert.state === "exhausted"
    ? t("Used up for this month: {meters}. It resets on {date} (UTC).")
    : t("Nearly used up for this month: {meters}. It resets on {date} (UTC).");
  return (
    <div className={`usage-bar ${alert.state}`} role="status" data-usage-alert={alert.state}>
      <span className="usage-bar-t">{text.replace("{meters}", meters).replace("{date}", date)}</span>
      <span className="usage-bar-a">
        <a className="btn sm" href="/app/usage">{t("View usage")}</a>
        <a className="btn sm primary" href={alert.upgradeUrl}>{t("Upgrade plan")}</a>
        <button className="icon-btn" aria-label={t("Dismiss")} onClick={() => { const k = alertKey(alert); try { sessionStorage.setItem(KEY, k); } catch {} setHidden(k); }}>×</button>
      </span>
    </div>
  );
}
