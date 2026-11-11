import { t } from "../lib/i18n";
import { formatResetDate, quotaRefusal } from "../lib/usage-alerts";

export type QuotaRefusal = NonNullable<ReturnType<typeof quotaRefusal>>;

/** The sentence for a quota refusal, translated, with its reset date filled in. */
export const quotaText = (r: QuotaRefusal) => t(r.message).replace("{date}", formatResetDate(r.resetsAt, document.documentElement.lang || undefined));

/**
 * An allowance used up (HTTP 402/429 with a quota code), explained for people: what ran out, when it resets and where
 * to upgrade, instead of the API's terse message. Only the hosted edition ever answers with these codes.
 */
export default function QuotaNotice({ refusal }: { refusal: QuotaRefusal }) {
  return (
    <div className="quota-msg err" role="alert" data-quota-code={refusal.code}>
      <span>{quotaText(refusal)}</span>
      <span><a href="/app/usage">{t("View usage")}</a> · <a href={refusal.upgradeUrl}>{t("Upgrade plan")}</a></span>
    </div>
  );
}
