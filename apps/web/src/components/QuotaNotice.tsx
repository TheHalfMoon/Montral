import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { formatResetDate, quotaRefusal } from "../lib/usage-alerts";

export type QuotaRefusal = NonNullable<ReturnType<typeof quotaRefusal>>;

/** The sentence for a quota refusal, translated, with its reset date filled in. */
export const quotaText = (r: QuotaRefusal) => t(r.message).replace("{date}", formatResetDate(r.resetsAt, document.documentElement.lang || undefined));

/** Members still get the reset date, never instructions to take an action they cannot perform. */
const MEMBER_MESSAGE: Record<QuotaRefusal["code"], string> = {
  credits_exhausted: "There are not enough checks left this period for this check. The allowance resets on {date}.",
  browser_quota_exhausted: "There is not enough browser check time left this period for this check. It resets on {date}.",
  webhook_quota_exhausted: "This workspace's webhook events for this period are used up. New requests are refused until {date}.",
};

/** Quota refusals are available to ordinary members too, but billing actions require owner/admin membership. */
export default function QuotaNotice({ refusal }: { refusal: QuotaRefusal }) {
  const [canManageBilling, setCanManageBilling] = useState(false);
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      api.usage().then((u) => {
        if (generation === current) setCanManageBilling(u.metered && u.canManageBilling === true);
      }).catch(() => { if (generation === current) setCanManageBilling(false); });
    };
    const onScope = () => { setCanManageBilling(false); refresh(); };
    refresh();
    window.addEventListener("montral:scope", onScope);
    return () => { generation++; window.removeEventListener("montral:scope", onScope); };
  }, []);
  const memberText = t(MEMBER_MESSAGE[refusal.code])
    .replace("{date}", formatResetDate(refusal.resetsAt, document.documentElement.lang || undefined));
  return (
    <div className="quota-msg err" role="alert" data-quota-code={refusal.code}>
      <span>{canManageBilling ? quotaText(refusal) : memberText}</span>
      <span><a href="/app/usage">{t("View usage")}</a>
        {canManageBilling && <> {" · "}<a href={refusal.upgradeUrl}>{t("Upgrade plan")}</a></>}
      </span>
    </div>
  );
}
