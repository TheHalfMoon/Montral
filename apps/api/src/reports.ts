import type { Repo } from "@montral/repo";
import { actionEmail, appUrl, sendEmail } from "./email";
import { unmetered, type Entitlements } from "./entitlements";
import { isLang, tr, type Lang } from "./mail-i18n";

/** The first days of a month, when the previous month's report goes out. An account that opts in later waits for the next one. */
export const REPORT_DAYS = 3;

/** YYYY-MM of the month before `now` (UTC). */
export function previousMonth(now: Date) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

const duration = (min: number, lang: Lang) => (min < 60 ? `${min} ${lang === "zh-CN" ? "分钟" : "min"}` : `${Math.floor(min / 60)} ${lang === "zh-CN" ? "小时" : "h"}${min % 60 ? ` ${min % 60} ${lang === "zh-CN" ? "分钟" : "min"}` : ""}`);

/**
 * Emails the owners of every workspace that turned the monthly report on a summary of last month. A workspace is claimed
 * for the month before anything is sent, so overlapping ticks cannot send twice. A failed quota
 * decision reopens the claim before any email is attempted; an attempted email is never retried
 * automatically because provider errors can be ambiguous about whether a message was delivered.
 */
export async function sendMonthlyReports(repo: Repo, now = new Date(), entitlements: Entitlements = unmetered) {
  if (now.getUTCDate() > REPORT_DAYS) return 0;
  const month = previousMonth(now);
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  let sent = 0;
  for (const orgId of await repo.claimMonthlyReports(month, 20)) {
    const retryBeforeSend = async () => {
      try { await repo.releaseMonthlyReportClaim(orgId, month); }
      catch { console.error("monthly report claim release failed"); }
    };
    const prepared = await Promise.all([repo.organization(orgId), repo.ownerContacts(orgId), repo.monthlyReport(orgId, from, to)]).catch(() => null);
    if (!prepared) { console.error("monthly report preparation unavailable"); await retryBeforeSend(); continue; }
    const [org, owners, comps] = prepared;
    if (!org || !owners.length || !comps.length) continue;
    // Render the full recipient batch *before* metering or contacting any provider.
    // A malformed monitor/component or recipient used to throw halfway through the
    // send loop: the org stayed claimed, some mail could be sent, and a quota charge
    // could already have happened. Before the first provider attempt it is safe to
    // release the claim and retry preparation on a later scheduler tick.
    let messages: { to: string; subject: string; fromName: string; html: string; text: string }[];
    try {
      messages = owners.map((o) => {
        if (typeof o.email !== "string" || !o.email.trim()) throw new Error("invalid monthly recipient");
        const lang: Lang = isLang(o.locale) ? o.locale : "en";
        const title = tr(lang, "Monthly report for {month}", { month });
        const mail = actionEmail({
          title,
          body: tr(lang, "Uptime, downtime and incidents of each monitor in {workspace}.", { workspace: org.name }),
          rows: comps.map((c): [string, string] => [
            c.name,
            [c.uptime == null ? tr(lang, "No checks yet") : `${tr(lang, "Uptime")} ${c.uptime}%`, duration(c.downtimeMinutes, lang), `${tr(lang, "Incidents")} ${c.incidents}`].join(" · "),
          ]),
          cta: tr(lang, "Open dashboard"),
          url: `${appUrl()}/app`,
          footer: tr(lang, "You get this because the monthly report is turned on for {workspace}. Turn it off in Settings.", { workspace: org.name }),
          lang,
        });
        return { to: o.email, subject: `${title} · Montral`, fromName: "Montral", ...mail };
      });
    } catch {
      // No email has been attempted and the allowance has not been charged.
      // Do not log component contents, email recipients or underlying DB errors.
      console.error("monthly report message preparation unavailable");
      await retryBeforeSend();
      continue;
    }
    // A monthly digest is optional: a metering outage must never turn it into an unbounded email send.
    // Unlike incident alerts, reports may safely be omitted when the allowance cannot be verified.
    let granted: number;
    try { granted = await entitlements.spendEmails(orgId, messages.length); }
    catch { console.error("monthly report email allowance unavailable"); await retryBeforeSend(); continue; }
    if (!Number.isSafeInteger(granted) || granted < 0 || granted > messages.length) {
      console.error("monthly report email allowance invalid");
      await retryBeforeSend();
      continue;
    }
    // An attempted email is never requeued. Its provider acceptance is ambiguous
    // after timeout; per-recipient durable outbox/reconciliation remains future work.
    for (const message of messages.slice(0, granted)) {
      await sendEmail(message, true)
        .then(() => sent++)
        .catch(() => console.error("monthly report email delivery failed"));
    }
  }
  return sent;
}
