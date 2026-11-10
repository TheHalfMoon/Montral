import { auditChanges, recordAuditEvent, type Query } from "./audit";
import { DOMAIN_RECHECK, verifyDomainToken, type TxtResolver } from "./custom-domain";

/**
 * Verified SSO email domains keep proving control of their TXT record, with the same policy as status page custom
 * domains (DOMAIN_RECHECK in custom-domain.ts): checked every 6 hours, every 30 minutes while failing, and withdrawn once
 * the record has been missing or wrong for 24 hours over at least three checks, or DNS has been unreachable for 7
 * days. A withdrawal clears verified_at, which releases the instance-wide claim (the partial unique index only covers
 * verified rows), so another workspace that proves control can verify the domain. Withdrawn domains sign nobody in;
 * the owner restores the record and presses Verify again. Each withdrawal is in the workspace audit log.
 */

export type SsoRecheckSummary = { checked: number; matched: number; failed: number; withdrawn: number };

/** DNS over HTTPS for Workers, which have no resolver API; Node uses the system resolver (custom-domain.ts). */
export const dohTxt: TxtResolver = async (name) => {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw Object.assign(new Error("lookup failed"), { code: "ESERVFAIL" });
  const json = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
  if (json.Status === 3) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  if (json.Status !== 0) throw Object.assign(new Error("lookup failed"), { code: "ESERVFAIL" });
  return (json.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => [...a.data!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")));
};

export async function recheckSsoDomains(
  query: Query,
  options: { now?: Date; resolver?: TxtResolver; policy?: Partial<Record<keyof typeof DOMAIN_RECHECK, number>>; shouldContinue?: () => boolean; domainIds?: string[] } = {},
): Promise<SsoRecheckSummary> {
  const p = { ...DOMAIN_RECHECK, ...options.policy };
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const summary: SsoRecheckSummary = { checked: 0, matched: 0, failed: 0, withdrawn: 0 };
  const one = async (row: { id: string; domain: string; token: string }) => {
    const outcome = await verifyDomainToken(row.domain, row.token, options.resolver);
    if (outcome.ok) {
      summary.matched++;
      await query(
        `UPDATE sso_domain SET failing_since = NULL, failures = 0, check_error = NULL WHERE id = $1::uuid AND token = $2::text AND verified_at IS NOT NULL`,
        [row.id, row.token],
      );
      return;
    }
    summary.failed++;
    // the right-hand sides read the row as it was before this UPDATE (see recheckCustomDomains)
    const rows = await query<{ withdrawn: boolean; organization_id: string }>(
      `UPDATE sso_domain AS d SET
         failures = CASE WHEN s.fresh THEN 1 ELSE d.failures + 1 END,
         failing_since = CASE WHEN s.fresh THEN $3::timestamptz ELSE d.failing_since END,
         check_error = $2::text,
         verified_at = CASE WHEN NOT s.fresh AND (
             ($2::text <> 'lookup_failed' AND d.failing_since <= $3::timestamptz - make_interval(secs => $4::double precision) AND d.failures + 1 >= $5::int)
             OR ($2::text = 'lookup_failed' AND d.failing_since <= $3::timestamptz - make_interval(secs => $6::double precision)))
           THEN NULL ELSE d.verified_at END
       FROM (SELECT id, (failing_since IS NULL OR check_error IS NULL OR (check_error = 'lookup_failed') <> ($2::text = 'lookup_failed')) AS fresh
             FROM sso_domain WHERE id = $1::uuid) AS s, sso_connection c
       WHERE d.id = s.id AND c.id = d.connection_id AND d.token = $7::text AND d.verified_at IS NOT NULL
       RETURNING c.organization_id, d.verified_at IS NULL AS withdrawn`,
      [row.id, outcome.reason, now.toISOString(), p.absentMs / 1000, p.minFailures, p.unresolvableMs / 1000, row.token],
    );
    if (rows[0]?.withdrawn) {
      summary.withdrawn++;
      await recordAuditEvent(query, {
        orgId: rows[0].organization_id, projectId: null, actor: { type: "system", id: null, label: "SSO domain re-check" },
        action: "sso.domain_withdrawn", targetType: "sso_domain", targetId: row.id,
        changes: auditChanges({ verified: false }, { domain: row.domain, reason: outcome.reason }), ip: null,
      }).catch(() => console.error("audit event could not be recorded; private diagnostics suppressed"));
    }
  };
  while (Date.now() - startedAt < p.budgetMs && (options.shouldContinue?.() ?? true)) {
    const due = await query<{ id: string; domain: string; token: string }>(
      `UPDATE sso_domain SET checked_at = $1::timestamptz
       WHERE id IN (
         SELECT id FROM sso_domain
         WHERE verified_at IS NOT NULL
           AND ($5::text IS NULL OR id::text = ANY (string_to_array($5::text, ',')))
           AND (checked_at IS NULL OR checked_at <= $1::timestamptz - make_interval(secs =>
                 CASE WHEN failing_since IS NULL THEN $2::double precision ELSE $3::double precision END))
         ORDER BY (failing_since IS NULL), checked_at NULLS FIRST, id
         LIMIT $4
         FOR UPDATE SKIP LOCKED)
       RETURNING id::text AS id, domain, token`,
      [now.toISOString(), p.healthyMs / 1000, p.failingMs / 1000, p.batch, options.domainIds ? options.domainIds.join(",") : null],
    );
    summary.checked += due.length;
    for (let i = 0; i < due.length; i += p.parallel) await Promise.all(due.slice(i, i + p.parallel).map(one));
    if (due.length < p.batch) break;
  }
  return summary;
}
