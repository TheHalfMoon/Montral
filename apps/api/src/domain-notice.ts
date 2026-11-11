import { actionEmail, appUrl, sendEmail } from "./email";
import { isLang, tr, type Lang } from "./mail-i18n";

/**
 * Emails to a workspace's owners and admins about a status page's custom domain (custom-domain.ts):
 *  - `domain.withdrawn`: the re-check withdrew verification, the domain no longer serves the page;
 *  - `domain.failing`: a failing streak reached its second consecutive failed re-check (once per streak), while the
 *    page is still served, so someone can fix the record before it is withdrawn.
 *
 * Delivery uses the alert delivery log (alert_delivery): one row per notice and recipient, with the same states
 * (pending, sending, sent, failed, skipped), attempt budget (MAX_ATTEMPTS, retried after 1 and then 5 minutes) and
 * stuck-row sweep (sweepDeliveries) as incident alerts, so it shows in the workspace's alert log. Each row carries a
 * dedupe key (kind, page, streak start, recipient) under a unique index: queuing the same notice again inserts nothing,
 * so a withdrawal sends one email per admin whatever retries or racing servers do. Incident retries (claimRetries)
 * leave these rows to deliverDomainNotices.
 *
 * Runtime-neutral SQL only (the recheck's query function); nothing here ever throws into the re-check.
 */

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
export type DomainNoticeKind = "domain.withdrawn" | "domain.failing";
type Reason = "missing" | "mismatch" | "lookup_failed";

/** Attempts per notice (the first included), as for incident alerts; retried after 1 minute, then 5. */
export const DOMAIN_NOTICE_ATTEMPTS = 3;
const RETRY_SEC = [60, 300];

/**
 * Turn the notices the re-check left in its outbox (status_page.custom_domain_notice, written in the same UPDATE as the
 * withdrawal or the streak's second failure) into one delivery row per current owner and admin of the page's workspace
 * (members get none), and clear the outbox, in one statement. Idempotent: a notice that was queued before for this
 * streak and person is not queued again. Returns how many rows it created. Throws on database errors (the outbox stays
 * set, so the next round tries again).
 */
export async function enqueueDomainNotices(query: Query, options: { pageIds?: string[]; limit?: number } = {}): Promise<number> {
  const [r] = await query<{ queued: number }>(
    `WITH due AS (
       SELECT id, custom_domain_notice AS kind FROM status_page
       WHERE custom_domain_notice IS NOT NULL AND ($1::text IS NULL OR id::text = ANY(string_to_array($1::text, ',')))
       ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED),
     ins AS (
       INSERT INTO alert_delivery (organization_id, project_id, channel_id, channel_name, channel_type, kind, monitor_name,
                                   ok, status, attempts, target_user_id, status_page_id, dedupe_key)
       SELECT sp.organization_id, sp.project_id, NULL, COALESCE(NULLIF(btrim(u.name), ''), u.email), 'email', due.kind, sp.custom_domain,
              false, 'pending', 0, u.id, sp.id,
              due.kind || ':' || sp.id::text || ':' || to_char(sp.custom_domain_failing_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || ':' || u.id
       FROM due
       JOIN status_page sp ON sp.id = due.id
       JOIN member m ON m.organization_id = sp.organization_id AND m.role IN ('owner', 'admin')
       JOIN "user" u ON u.id = m.user_id
       WHERE sp.custom_domain IS NOT NULL AND sp.custom_domain_failing_since IS NOT NULL
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id),
     cleared AS (
       UPDATE status_page SET custom_domain_notice = NULL FROM due
       WHERE status_page.id = due.id AND status_page.custom_domain_notice = due.kind
       RETURNING status_page.id)
     SELECT (SELECT count(*) FROM ins)::int AS queued, (SELECT count(*) FROM cleared)::int AS cleared`,
    [options.pageIds?.length ? options.pageIds.join(",") : null, options.limit ?? 100],
  );
  return r?.queued ?? 0;
}

type Claimed = { id: string; kind: DomainNoticeKind; organization_id: string; target_user_id: string | null; status_page_id: string | null; monitor_name: string | null; attempts: number };
type Context = {
  title: string | null; domain: string | null; verified: boolean | null; failing: boolean | null; error: Reason | null;
  email: string | null; locale: string | null; role: string | null; owner_locale: string | null;
};

const reasonLine = (lang: Lang, reason: Reason, record: string, withdrawn: boolean) =>
  tr(lang, withdrawn
    ? reason === "lookup_failed" ? "DNS lookups for the TXT record {record} kept failing on every re-check." : reason === "mismatch" ? "The TXT record {record} held a different value on every re-check." : "The TXT record {record} was missing on every re-check."
    : reason === "lookup_failed" ? "DNS lookups for the TXT record {record} failed on the last two re-checks." : reason === "mismatch" ? "The TXT record {record} held a different value on the last two re-checks." : "The TXT record {record} was missing on the last two re-checks.",
  { record });

/** Subject, layout and text of one notice, in the recipient's language. Exported for tests. */
export function domainNoticeMail(kind: DomainNoticeKind, lang: Lang, v: { domain: string; title: string; reason: Reason; url: string }) {
  const L = (k: string, vars?: Record<string, string>) => tr(lang, k, vars);
  const record = `_montral-challenge.${v.domain}`;
  const withdrawn = kind === "domain.withdrawn";
  const subject = withdrawn ? L("Custom domain withdrawn: {domain}", { domain: v.domain }) : L("Custom domain failing its DNS check: {domain}", { domain: v.domain });
  const body = withdrawn
    ? `${reasonLine(lang, v.reason, record, true)}\n\n${L("Montral has withdrawn the domain: {domain} no longer serves the status page {title}. Restore the record, then verify the domain again in the status page settings.", { domain: v.domain, title: v.title })}`
    : `${reasonLine(lang, v.reason, record, false)}\n\n${L(v.reason === "lookup_failed"
        ? "{domain} still serves the status page {title}. If lookups keep failing for 7 days, Montral withdraws the domain and the page is no longer served there."
        : "{domain} still serves the status page {title}. If the record is not restored within 24 hours, Montral withdraws the domain and the page is no longer served there.", { domain: v.domain, title: v.title })}`;
  const { html, text } = actionEmail({
    lang,
    title: withdrawn ? L("{domain} no longer serves your status page", { domain: v.domain }) : L("{domain} is failing its DNS check", { domain: v.domain }),
    body,
    badge: withdrawn ? { label: L("Withdrawn"), tone: "down" } : { label: L("Failing"), tone: "warn" },
    rows: [[L("Domain"), v.domain], [L("Status page"), v.title], [L("TXT record"), record]],
    cta: L("Open status page settings"),
    url: v.url,
    footer: L("You get this because you are an owner or admin of the workspace this status page belongs to."),
  });
  return { subject, html, text };
}

const finish = (query: Query, id: string, r: { status: "sent" | "failed" | "skipped"; message: string | null; retryInSec?: number | null }) => {
  const again = r.status === "failed" && r.retryInSec != null;
  return query(
    `UPDATE alert_delivery SET status = $2::text, ok = $3::boolean, error = $4::text, status_message = $4::text,
       attempts = CASE WHEN $5::boolean THEN attempts ELSE attempts + 1 END,
       next_attempt_at = CASE WHEN $6::double precision IS NULL THEN NULL ELSE now() + make_interval(secs => $6::double precision) END
     WHERE id = $1::uuid AND status = 'sending'`,
    [id, again ? "pending" : r.status, r.status === "sent", r.message, r.status === "skipped", again ? r.retryInSec : null],
  );
};

/**
 * Send the domain notices that are due (fresh, or waiting for a retry), each claimed first (pending -> sending under
 * SKIP LOCKED) so racing servers never send one twice. A notice is skipped instead of sent when it no longer applies:
 * the person is no longer an owner or admin, the page or its domain changed, or (for a failing streak) the record came
 * back or the domain was withdrawn in the meantime. Never throws.
 */
export async function deliverDomainNotices(query: Query, options: { limit?: number; pageIds?: string[] } = {}): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  let claimed: Claimed[];
  try {
    claimed = await query<Claimed>(
      `UPDATE alert_delivery SET status = 'sending', claimed_at = now(), next_attempt_at = NULL
       WHERE id IN (
         SELECT id FROM alert_delivery
         WHERE kind IN ('domain.withdrawn', 'domain.failing') AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           -- nothing is sent for a workspace a platform operator suspended (docs/OPERATOR.md); it stays queued
           AND NOT EXISTS (SELECT 1 FROM workspace_suspension ws WHERE ws.organization_id = alert_delivery.organization_id)
           AND ($2::text IS NULL OR status_page_id::text = ANY(string_to_array($2::text, ',')))
         ORDER BY created_at, id LIMIT $1
         FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, organization_id, target_user_id, status_page_id, monitor_name, attempts`,
      [options.limit ?? 50, options.pageIds?.length ? options.pageIds.join(",") : null],
    );
  } catch {
    console.error("custom domain notices could not be claimed; private diagnostics suppressed");
    return out;
  }
  for (const d of claimed) {
    try {
      const [c] = await query<Context>(
        `SELECT sp.title, sp.custom_domain AS domain, sp.custom_domain_verified_at IS NOT NULL AS verified,
                sp.custom_domain_failing_since IS NOT NULL AS failing, sp.custom_domain_check_error AS error,
                u.email, u.locale, m.role,
                (SELECT ou.locale FROM member om JOIN "user" ou ON ou.id = om.user_id
                  WHERE om.organization_id = sp.organization_id AND om.role = 'owner' ORDER BY om.created_at LIMIT 1) AS owner_locale
         FROM (SELECT 1) AS one
         LEFT JOIN status_page sp ON sp.id = $1::uuid AND sp.organization_id = $3::text
         LEFT JOIN member m ON m.organization_id = sp.organization_id AND m.user_id = $2::text
         LEFT JOIN "user" u ON u.id = m.user_id`,
        [d.status_page_id, d.target_user_id, d.organization_id],
      );
      const skip = !c?.title ? "skipped: the status page was removed"
        : !c.email || (c.role !== "owner" && c.role !== "admin") ? "skipped: the person is no longer an owner or admin of the workspace"
        : c.domain !== d.monitor_name ? "skipped: the status page's custom domain changed before this notice could be sent"
        : d.kind === "domain.withdrawn" && c.verified ? "skipped: the domain was verified again before this notice could be sent"
        : d.kind === "domain.failing" && !c.verified ? "skipped: the domain was withdrawn before this notice could be sent"
        : d.kind === "domain.failing" && !c.failing ? "skipped: the TXT record matched again before this notice could be sent"
        : !c.error ? "skipped: no failed re-check is recorded any more"
        : null;
      if (skip) {
        await finish(query, d.id, { status: "skipped", message: skip });
        out.skipped++;
        continue;
      }
      const lang: Lang = isLang(c.locale) ? c.locale : isLang(c.owner_locale) ? c.owner_locale : "en";
      const mail = domainNoticeMail(d.kind, lang, { domain: c.domain!, title: c.title!, reason: c.error!, url: `${appUrl().replace(/\/+$/, "")}/app/status-pages/${d.status_page_id}` });
      try {
        await sendEmail({ to: c.email!, subject: mail.subject, html: mail.html, text: mail.text }, true);
      } catch {
        // no provider detail (it may echo the address or credentials) reaches the log or the row
        console.error("custom domain notice delivery failed");
        const attempts = d.attempts + 1;
        const retryInSec = attempts < DOMAIN_NOTICE_ATTEMPTS ? RETRY_SEC[attempts - 1] : null;
        const message = retryInSec == null ? `failed: email not accepted (gave up after ${attempts} attempts)` : `failed: email not accepted (attempt ${attempts} of ${DOMAIN_NOTICE_ATTEMPTS}, trying again in ${retryInSec >= 120 ? `${retryInSec / 60} min` : `${retryInSec} s`})`;
        await finish(query, d.id, { status: "failed", message, retryInSec });
        out.failed++;
        continue;
      }
      await finish(query, d.id, { status: "sent", message: null });
      out.sent++;
    } catch {
      // The row stays in `sending`; the delivery sweep hands it back after its lease (no immediate resend: the
      // provider may already have accepted it).
      console.error("custom domain notice interrupted; awaiting delivery sweep");
    }
  }
  return out;
}
