import { zValidator } from "@hono/zod-validator";
import type { IncidentUpdate, IncidentWithUpdates } from "@montral/repo";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { actionEmail, appUrl, sendEmail } from "../email";
import { langFromHeader, tr } from "../mail-i18n";
import type { AppEnv } from "../env";
import type { Plan } from "../entitlements";
import { currentSession } from "../auth";
import {
  accessCookie, hashPagePassword, hasAccessGrant, MAX_ACTIVE_SHARE_LINKS, newShareToken, redeemShareToken,
  SHARE_LINK_DEFAULT_HOURS, SHARE_LINK_MAX_HOURS, verifyPagePassword,
} from "../status-access";
import type { StatusPage } from "@montral/repo";
import { requireManager, uuidParams } from "../middleware";
import { clientIp } from "../ratelimit";
import { sharedCache, waitUntilOf } from "../sharedcache";
import { buildIcs, buildLlmsTxt, buildRss, FEED_LIMIT, ICS_LIMIT } from "../status-feeds";
import {
  appHosts, challengeName, customDomainOrigin, newDomainToken, purgeCustomDomains, statusPageDomain, verifyDomainToken,
} from "../custom-domain";
import { isWorkers } from "../netguard";

// optional link to the owner's own website; "" clears it
const externalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === "" || /^https?:\/\//i.test(v) && URL.canParse(v), "Must be an http(s) URL")
  .transform((v) => v || null)
  .nullable()
  .optional();
/** Whether the plan lets a status page hide Montral's branding. Editions without plans (null) allow it. */
const brandingAllowed = (plan: Plan | null) => plan?.hideBranding !== false;
const pageBody = z.object({
  title: z.string().min(1).max(120),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  showLatency: z.boolean().optional(),
  externalUrl,
  hideBranding: z.boolean().optional(),
  // uptime bars: green from `uptimeOkPct`, amber from `uptimeWarnPct`, red below
  uptimeOkPct: z.number().min(1).max(100).optional(),
  uptimeWarnPct: z.number().min(1).max(100).optional(),
  // public MCP tools may serve this page
  mcpEnabled: z.boolean().optional(),
  // "members": only signed-in members of the workspace see the page and its feeds;
  // "password": members, plus anyone who unlocks it with the page password or a share link
  visibility: z.enum(["public", "members", "password"]).optional(),
  // sets (or replaces) the page password; never returned. Replacing it signs every outside visitor out.
  password: z.string().min(8).max(200).optional(),
  // hours before maintenance starts that subscribers are reminded; 0 = never
  maintenanceReminderHours: z.number().int().min(0).max(168).optional(),
  monitorIds: z.array(z.string().uuid()).optional(),
  // ordered, optionally grouped; takes precedence over monitorIds
  components: z.array(z.object({ monitorId: z.string().uuid(), groupName: z.string().trim().min(1).max(60).optional() })).max(200).optional(),
});
/** The two uptime thresholds must leave room for amber between them; checked against what the page will hold afterwards. */
const thresholdsProblem = (c: Context<AppEnv>, ok: number, warn: number) =>
  warn < ok ? null : c.json({ error: "The amber threshold must be below the green one" }, 400);
const toComponents = (v: { monitorIds?: string[]; components?: { monitorId: string; groupName?: string }[] }) =>
  v.components ?? (v.monitorIds ?? []).map((monitorId) => ({ monitorId }));

/**
 * What the management API returns for a page: the password hash never leaves the server. A page with a custom domain
 * also carries the TXT record that verifies it (not a secret: it is meant to be published in DNS).
 */
const toClient = ({ accessPasswordHash, ...page }: StatusPage) => ({
  ...page,
  hasPassword: !!accessPasswordHash,
  customDomainRecord: page.customDomain && page.customDomainToken ? { type: "TXT" as const, name: challengeName(page.customDomain), value: page.customDomainToken } : null,
});

/** Custom domains are routed by the self-hosted Node server only; a Workers deployment has no Host-based router. */
const domainsUnsupported = (c: Context<AppEnv>) =>
  isWorkers()
    ? c.json({ error: "Custom domains need the self-hosted Node server; Cloudflare Workers deployments do not support them", code: "custom_domain_unsupported" }, 400)
    : null;

/** The stored flag counts only while the plan allows it: after a downgrade the page shows Montral again, and the flag is kept. */
async function brandingHidden(c: Context<AppEnv>, page: { hideBranding: boolean; organizationId: string }) {
  if (!page.hideBranding) return false;
  return brandingAllowed(await c.get("entitlements").plan(page.organizationId));
}

/** 402 when the request turns branding off on a plan that does not include that; null otherwise (turning it back on is always fine). */
async function brandingProblem(c: Context<AppEnv>, hide: boolean | undefined) {
  if (!hide) return null;
  const plan = await c.get("entitlements").plan(c.get("orgId"));
  if (brandingAllowed(plan)) return null;
  return c.json({ error: `The ${plan!.name} plan cannot hide the Montral branding`, code: "branding_not_allowed", plan: plan!.id, upgradeUrl: plan!.upgradeUrl }, 402);
}

/** Subscriber addresses are private personal data. These headers also cover
 * denials, before the manager authorization check runs. */
const subscriberContactPrivacy = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.header("cache-control", "private, no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-robots-tag", "noindex, nofollow");
  await next();
};

/** Management API for status pages (authenticated). */
export const statusPages = new Hono<AppEnv>()
  .use("/:id/subscribers", subscriberContactPrivacy)
  .use("/:id/subscribers/:sid", subscriberContactPrivacy)
  // an edit made through the API shows on the public page at once (on this instance; others catch up within the TTL)
  .use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.ok) {
      purgePublicStatus();
      // a page deleted, made members-only or given another domain must stop being served on its old host at once
      purgeCustomDomains();
    }
  })
  .get("/", async (c) => c.json((await c.get("repo").listStatusPages(c.get("orgId"), c.get("projectId"))).map(toClient)))
  .post(
    "/",
    zValidator("json", z.object({ slug: z.string().regex(/^[a-z0-9-]{3,40}$/) }).and(pageBody.partial({ title: true }).required({ title: true }))),
    async (c) => {
      const repo = c.get("repo");
      const { monitorIds, components, password, ...v } = c.req.valid("json");
      if (v.visibility === "password" && !password) return c.json({ error: "A password-protected page needs a password" }, 400);
      const denied = await brandingProblem(c, v.hideBranding);
      if (denied) return denied;
      const bad = thresholdsProblem(c, v.uptimeOkPct ?? 99.9, v.uptimeWarnPct ?? 98);
      if (bad) return bad;
      if (await repo.slugTaken(v.slug)) return c.json({ error: "That slug is already taken" }, 409);
      const page = await repo.createStatusPage(c.get("orgId"), c.get("projectId"), { ...v, ...(password ? { accessPasswordHash: await hashPagePassword(password) } : {}) });
      await repo.setPageComponents(page.id, c.get("orgId"), toComponents({ monitorIds, components }), c.get("projectScope"));
      return c.json(toClient(page), 201);
    },
  )
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const comps = await repo.pageComponents(page.id);
    const plan = await c.get("entitlements").plan(c.get("orgId"));
    // what the editor needs to know about the plan: may this page hide the brand, and where to upgrade if not
    const branding = { allowed: brandingAllowed(plan), upgradeUrl: brandingAllowed(plan) ? undefined : plan?.upgradeUrl };
    return c.json({ ...toClient(page), monitorIds: comps.map((x) => x.monitorId), components: comps, branding });
  })
  .patch("/:id", uuidParams, requireManager, zValidator("json", pageBody.partial()), async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const { monitorIds, components, password, ...v } = c.req.valid("json");
    if ((v.visibility ?? page.visibility) === "password" && !password && !page.accessPasswordHash) {
      return c.json({ error: "A password-protected page needs a password" }, 400);
    }
    // a page that already hides the brand can still be edited after a downgrade; only turning it on is refused
    const denied = await brandingProblem(c, v.hideBranding && !page.hideBranding ? true : undefined);
    if (denied) return denied;
    const bad = thresholdsProblem(c, v.uptimeOkPct ?? page.uptimeOkPct, v.uptimeWarnPct ?? page.uptimeWarnPct);
    if (bad) return bad;
    // A new password, or any change of visibility, signs out everyone outside the workspace: an old unlock cookie
    // must not come back to life when a page returns to password mode, and anyone who subscribed while the page was
    // public is not a current subscriber of the protected page.
    const visibilityChanged = v.visibility !== undefined && v.visibility !== page.visibility;
    await repo.updateStatusPage(page.id, {
      ...v,
      ...(password ? { accessPasswordHash: await hashPagePassword(password) } : {}),
      ...(password || visibilityChanged ? { accessVersion: page.accessVersion + 1 } : {}),
    });
    if (monitorIds || components) await repo.setPageComponents(page.id, c.get("orgId"), toComponents({ monitorIds, components }), c.get("projectScope"));
    return c.json({ ok: true });
  })
  // Sign out everyone outside the workspace: existing password and share-link cookies stop working; links still work.
  .post("/:id/access/revoke", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    await repo.updateStatusPage(page.id, { accessVersion: page.accessVersion + 1 });
    return c.json({ ok: true });
  })
  .get("/:id/share-links", uuidParams, requireManager, async (c) => {
    const page = await c.get("repo").getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const links = await c.get("database").query<{ id: string; label: string | null; created_at: Date; expires_at: Date; revoked_at: Date | null; last_used_at: Date | null }>(
      "SELECT id, label, created_at, expires_at, revoked_at, last_used_at FROM status_page_share_link WHERE status_page_id = $1 ORDER BY created_at DESC LIMIT 200",
      [page.id],
    );
    return c.json(links.map((l) => ({ id: l.id, label: l.label, createdAt: l.created_at, expiresAt: l.expires_at, revokedAt: l.revoked_at, lastUsedAt: l.last_used_at })));
  })
  // A share link opens a non-public page for whoever holds it, until it expires or is revoked. Its URL is shown once.
  .post(
    "/:id/share-links",
    uuidParams,
    requireManager,
    zValidator("json", z.object({ label: z.string().trim().max(80).optional(), expiresInHours: z.number().int().min(1).max(SHARE_LINK_MAX_HOURS).optional() }).strict()),
    async (c) => {
      const page = await c.get("repo").getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!page) return c.json({ error: "Not found" }, 404);
      if (page.visibility === "public") return c.json({ error: "A public page needs no share link" }, 400);
      const { label, expiresInHours } = c.req.valid("json");
      const db = c.get("database");
      const { token, hash } = await newShareToken();
      const expiresAt = new Date(Date.now() + (expiresInHours ?? SHARE_LINK_DEFAULT_HOURS) * 3_600_000);
      // the database function locks the page row before counting, so concurrent requests cannot exceed the cap
      const rows = await db.query<{ id: string | null }>(
        "SELECT montral_create_share_link($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz, $6::int) AS id",
        [page.id, hash, label || null, c.get("userId"), expiresAt.toISOString(), MAX_ACTIVE_SHARE_LINKS],
      );
      if (!rows[0]?.id) return c.json({ error: `A page can have at most ${MAX_ACTIVE_SHARE_LINKS} active share links` }, 409);
      const origin = appUrl() || new URL(c.req.url).origin;
      c.header("cache-control", "no-store");
      return c.json({ id: rows[0].id, label: label || null, expiresAt, url: `${origin}/api/public/status/_/access?t=${token}`, warning: "This link is shown only once. Anyone who has it can open the page until it expires or is revoked." }, 201);
    },
  )
  .delete("/:id/share-links/:sid", uuidParams, requireManager, async (c) => {
    const page = await c.get("repo").getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const rows = await c.get("database").query<{ id: string }>(
      "UPDATE status_page_share_link SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND status_page_id = $2 RETURNING id",
      [c.req.param("sid"), page.id],
    );
    return rows[0] ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  })
  // Set (or replace) the page's custom domain. Always starts unverified with a fresh TXT value, so moving a domain or
  // setting it again needs DNS proof again. Naming a domain another page holds is allowed: DNS decides, and the domain
  // moves only when this page proves its own TXT record (see /verify).
  .put("/:id/domain", uuidParams, requireManager, zValidator("json", z.object({ domain: z.string().max(300) }).strict()), async (c) => {
    const unsupported = domainsUnsupported(c);
    if (unsupported) return unsupported;
    const page = await c.get("repo").getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const checked = statusPageDomain(c.req.valid("json").domain, appHosts(c.env));
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    const db = c.get("database");
    // No first-come lock: DNS decides. Anyone may set a name; whoever proves the TXT record for their own token holds it,
    // so a domain that changes hands can be claimed by its new owner without the former page's cooperation.
    const token = newDomainToken();
    await db.query(
      "UPDATE status_page SET custom_domain = $2, custom_domain_token = $3, custom_domain_verified_at = NULL WHERE id = $1",
      [page.id, checked.domain, token],
    );
    return c.json({ customDomain: checked.domain, customDomainVerifiedAt: null, customDomainRecord: { type: "TXT", name: challengeName(checked.domain), value: token } });
  })
  .delete("/:id/domain", uuidParams, requireManager, async (c) => {
    const page = await c.get("repo").getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    await c.get("database").query(
      "UPDATE status_page SET custom_domain = NULL, custom_domain_token = NULL, custom_domain_verified_at = NULL WHERE id = $1",
      [page.id],
    );
    return c.body(null, 204);
  })
  // Look up the TXT record now and, on an exact match, mark the domain verified. The update is conditional on the
  // domain and token read here, so a concurrent change of domain cannot be verified by the old record.
  .post("/:id/domain/verify", uuidParams, requireManager, async (c) => {
    const unsupported = domainsUnsupported(c);
    if (unsupported) return unsupported;
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    if (!page.customDomain || !page.customDomainToken) return c.json({ error: "Set a custom domain first" }, 400);
    // each check is an outbound DNS query
    if (!(await repo.withinLimit(`cd-verify:${page.id}`, 30, 3600))) return c.json({ error: "Too many attempts, try again later" }, 429);
    const record = { type: "TXT" as const, name: challengeName(page.customDomain), value: page.customDomainToken };
    const outcome = await verifyDomainToken(page.customDomain, page.customDomainToken);
    if (!outcome.ok) {
      const error = outcome.reason === "lookup_failed"
        ? "The DNS lookup failed. Try again in a few minutes."
        : outcome.reason === "missing"
          ? `No TXT record found at ${record.name} yet. DNS changes can take a while to appear.`
          : `The TXT record at ${record.name} does not match. Its value must be exactly the one shown.`;
      return c.json({ verified: false, reason: outcome.reason, error, record }, 422);
    }
    let rows: { verified_at: Date }[];
    try {
      // The TXT record just proved control of the domain for this page's token: release it from any other page first
      // (a domain that changed hands, or one its DNS owner moved). A concurrent verification can still lose the race on
      // the partial unique index and answers 409 below; trying again settles it.
      await c.get("database").query(
        "UPDATE status_page SET custom_domain_verified_at = NULL WHERE custom_domain = $1 AND id <> $2 AND custom_domain_verified_at IS NOT NULL",
        [page.customDomain, page.id],
      );
      rows = await c.get("database").query<{ verified_at: Date }>(
        `UPDATE status_page SET custom_domain_verified_at = coalesce(custom_domain_verified_at, now())
         WHERE id = $1 AND custom_domain = $2 AND custom_domain_token = $3 RETURNING custom_domain_verified_at AS verified_at`,
        [page.id, page.customDomain, page.customDomainToken],
      );
    } catch (e) {
      // the partial unique index: another page verified the same domain first
      const err = e as { code?: string; cause?: { code?: string } };
      if (err.code === "23505" || err.cause?.code === "23505") return c.json({ error: "That domain is already in use by another status page", code: "custom_domain_taken" }, 409);
      throw e;
    }
    if (!rows[0]) return c.json({ error: "The domain changed while it was being verified. Try again." }, 409);
    return c.json({ verified: true, customDomain: page.customDomain, customDomainVerifiedAt: rows[0].verified_at, record });
  })
  .get("/:id/subscribers", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    return c.json(await repo.listSubscribers(page.id));
  })
  .delete("/:id/subscribers/:sid", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    await repo.deleteSubscriber(page.id, c.req.param("sid"));
    return c.body(null, 204);
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (page) await repo.deleteStatusPage(page.id);
    return c.body(null, 204);
  });

/**
 * Automatic (authorless) "investigating" updates carry raw check errors and thresholds — hostnames, IPs, ports,
 * response snippets. Those are for the owner's dashboard and alerts only; public pages and RSS get a generic line.
 */
export function publicBody(u: IncidentUpdate) {
  return u.authorId == null && u.status === "investigating" ? "Automated checks detected a problem. We are investigating." : u.body;
}

/**
 * Public shape of an incident: no assignee, no organization, sanitised update bodies. Internal updates are dropped here
 * as well as in the query, so no new read path can leak one. The root cause and postmortem are shown only once the incident
 * is resolved and a person has published them; resolving alone (automatic recovery included) never makes them public.
 */
export const toPublic = (i: IncidentWithUpdates) => ({
  id: i.id, number: i.number, title: i.title, status: i.status, severity: i.severity, startedAt: i.startedAt, resolvedAt: i.resolvedAt,
  ...(i.resolvedAt && i.postmortemPublishedAt ? { rootCause: i.rootCause, postmortem: i.postmortem } : {}),
  updates: i.updates.filter((u) => u.visibility === "public").map((u) => ({ id: u.id, body: publicBody(u), status: u.status, createdAt: u.createdAt })),
});

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const MAX_SUBSCRIBERS = 5000;
const HISTORY_PAGE = 15;
// Public pages are read far more often than they change, and each read aggregates 90 days of rollups: serve a short-lived copy.
// A page edit or an incident update shows up within this long (the data centre's copy is not cleared by an edit). Only found pages are kept.
// Tests read a page right after changing it, so they run without the cache.
const PUBLIC_TTL_MS = typeof process !== "undefined" && process.env?.VITEST ? 0 : 30_000;
const boardCache = sharedCache<unknown>("status-board", PUBLIC_TTL_MS);
const historyCache = sharedCache<unknown>("status-history", PUBLIC_TTL_MS);

/**
 * Drops this instance's copies of the public board and history, so a change made through the API (an incident update, a
 * postmortem published or taken down) shows on the next read here. Other instances and the data centre's shared copy
 * catch up within PUBLIC_TTL_MS; the responses themselves carry no shared-cache lifetime beyond that.
 */
export function purgePublicStatus() {
  boardCache.clear();
  historyCache.clear();
}

type Overall = "operational" | "degraded" | "outage" | "unknown";
const LABELS: Record<Overall, { en: string; zh: string }> = {
  operational: { en: "All systems operational", zh: "所有系统运行正常" },
  degraded: { en: "Partial degradation", zh: "部分服务降级" },
  outage: { en: "Major outage", zh: "服务中断" },
  unknown: { en: "Status unknown", zh: "状态未知" },
};
const COLORS: Record<Overall, string> = { operational: "#16a34a", degraded: "#d97706", outage: "#dc2626", unknown: "#64748b" };
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Rough text width for the badge: CJK glyphs are about twice as wide as latin ones. */
const textWidth = (v: string) => [...v].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 12 : 6.4), 0);
const overallOf = (statuses: string[]): Overall => (statuses.includes("down") ? "outage" : statuses.includes("degraded") ? "degraded" : statuses.includes("unknown") ? "unknown" : "operational");
const langOf = (c: { req: { query(k: string): string | undefined; header(k: string): string | undefined } }): "en" | "zh" => {
  const q = c.req.query("lang") ?? c.req.header("accept-language") ?? "";
  return /^zh/i.test(q) ? "zh" : "en";
};

/** The public MCP tools add `via=mcp`; a page whose owner turned that off refuses them (the page itself stays public). */
async function mcpDenied(c: Context<AppEnv>, slug: string) {
  if (c.req.query("via") !== "mcp") return null;
  const page = await c.get("repo").statusPageBySlug(slug);
  return page && !page.mcpEnabled ? c.json({ error: "The owner of this status page turned off MCP access" }, 403) : null;
}

/**
 * The address feeds name as the page's home: its verified custom domain when it is served there (not for a
 * members-only page, which custom domains never serve), otherwise /status/<slug> on the main origin.
 */
function pageHome(c: Context<AppEnv>, page: StatusPage, origin: string) {
  return page.customDomain && page.customDomainVerifiedAt && page.visibility !== "members" && !isWorkers()
    ? `${customDomainOrigin(page.customDomain, c.env.WEB_ORIGIN)}/`
    : `${origin}/status/${page.slug}`;
}

async function rssFeed(c: Context<AppEnv>) {
  const repo = c.get("repo");
  const page = await repo.statusPageBySlug(c.req.param("slug")!);
  if (!page) return c.json({ error: "Not found" }, 404);
  const [incidents, maintenance] = await Promise.all([repo.pageIncidents(page, { limit: FEED_LIMIT }), repo.pageMaintenance(page, { limit: FEED_LIMIT })]);
  const origin = appUrl() || new URL(c.req.url).origin;
  const xml = buildRss({ title: page.title, link: pageHome(c, page, origin), incidents: incidents.map(toPublic), maintenance });
  return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" });
}

/** Failed unlocks a page tolerates per hour before refusing all unlocks (share links and members are unaffected). */
const UNLOCK_PAGE_FAILURES = 100;

/** A members-only page is readable only through a browser session of a current member of its workspace. */
async function memberOfPageWorkspace(c: Context<AppEnv>, organizationId: string): Promise<boolean> {
  const session = await currentSession(c.get("auth"), c.req.raw.headers);
  return !!session && (await c.get("repo").isMember(session.user.id, organizationId));
}

/**
 * All slug routes, including subscriptions, badges and machine-readable feeds, share this boundary. A members-only
 * page and any edition access policy make every response private; a refused visitor gets the same 404 as for a page
 * that does not exist.
 */
async function statusAccess(c: Context<AppEnv>, next: () => Promise<void>) {
  const policy = c.get("entitlements").statusPageAccess;
  const slug = c.req.param("slug");
  if (!slug || slug === "_") return next();
  const page = await c.get("repo").statusPageBySlug(slug);
  const membersOnly = page?.visibility === "members" || page?.visibility === "password";
  if (!policy && !membersOnly) return next();
  // No shared response is safe for a restricted page, including not-found/errors.
  c.set("statusResponsePrivate", true);
  c.header("cache-control", "private, no-store");
  if (!page) return c.json({ error: "Not found" }, 404);
  if (membersOnly) {
    let allowed: boolean;
    try { allowed = (await memberOfPageWorkspace(c, page.organizationId)) || (await hasAccessGrant(c, page)); }
    catch {
      console.error("status page access check unavailable");
      return c.json({ error: "Unavailable" }, 503);
    }
    if (!allowed) {
      c.header("x-robots-tag", "noindex, nofollow");
      // A password page announces itself so the visitor can unlock it (its title and content stay hidden); a
      // members-only page is indistinguishable from one that does not exist.
      return page.visibility === "password"
        ? c.json({ error: "This status page is password protected", locked: true }, 401)
        : c.json({ error: "Not found" }, 404);
    }
  }
  if (policy) {
    let access: Awaited<ReturnType<typeof policy>>;
    try { access = await policy(page, c.req.raw); }
    catch {
      console.error("status page access policy unavailable");
      return c.json({ error: "Unavailable" }, 503);
    }
    if (access?.allowed !== true) return c.json({ error: "Not found" }, 404);
  }
  // Always bypass external caches: a formerly public page may change access, and a visitor's session decides.
  await next();
  c.header("cache-control", "private, no-store");
  c.header("vary", "Cookie, Authorization");
  if (membersOnly) c.header("x-robots-tag", "noindex, nofollow");
}

/** Subscription and one-click unsubscribe URLs are bearer tokens in query
 * strings. Their response headers (including redirects and error paths) must
 * prevent same-origin browser Referer propagation and intermediary caching.
 * This does not replace redaction of incoming URLs in hosted reverse-proxy logs.
 */
const subscriptionTokenPrivacy = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  c.header("cache-control", "private, no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-robots-tag", "noindex, nofollow");
  await next();
};

/** Read only the small form/protocol body, not an unbounded public stream. */
const UNSUBSCRIBE_BODY_LIMIT = 1024;
const UNSUBSCRIBE_READ_TIMEOUT_MS = 10_000;
export class UnsubscribeBodyTimeoutError extends Error {
  constructor() { super("Unsubscribe request body read timeout"); }
}
/** Fixed total read window, not an idle timeout reset by byte-drip senders.
 * The optional override is only for synthetic tests; mounted HTTP is 10s. */
export async function unsubscribeOneClick(request: Request, timeoutMs = UNSUBSCRIBE_READ_TIMEOUT_MS): Promise<boolean | null> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > UNSUBSCRIBE_BODY_LIMIT) {
    void request.body?.cancel().catch(() => {});
    return null;
  }
  if (!request.body) return false;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let consumed = 0;
  let text = "";
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UnsubscribeBodyTimeoutError()), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { completed = true; break; }
      if (value.byteLength > UNSUBSCRIBE_BODY_LIMIT - consumed) return null;
      consumed += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return (text + decoder.decode()).includes("List-Unsubscribe=One-Click");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Do not await a hostile stream's never-settling cancel promise.
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A public subscription accepts at most 200 component UUIDs and an email.
 * Bound the upload before Hono's JSON validator parses it or any mail/SQL
 * side effect occurs. Reading a clone preserves the validated original body.
 */
const SUBSCRIBE_BODY_MAX_BYTES = 12 * 1024;
const SUBSCRIBE_BODY_TIMEOUT_MS = 10_000;
export class SubscribeBodyTimeoutError extends Error {
  constructor() { super("Subscribe request body read timeout"); }
}
export async function subscriptionBodyOversize(request: Request, timeoutMs = SUBSCRIBE_BODY_TIMEOUT_MS): Promise<boolean> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > SUBSCRIBE_BODY_MAX_BYTES) {
    void request.body?.cancel().catch(() => {});
    return true;
  }
  if (!request.body) return false;
  const reader = request.clone().body!.getReader();
  let consumed = 0;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubscribeBodyTimeoutError()), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { completed = true; return false; }
      if (value.byteLength > SUBSCRIBE_BODY_MAX_BYTES - consumed) return true;
      consumed += value.byteLength;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!completed) {
      // Refusals must not block on never-settling tee cancellation.
      void reader.cancel().catch(() => {});
      void request.body?.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
const subscriptionBodyGuard = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  try {
    if (await subscriptionBodyOversize(c.req.raw)) return c.json({ error: "Payload too large" }, 413);
  } catch (error) {
    if (error instanceof SubscribeBodyTimeoutError) {
      return c.json({ error: error.message }, 408);
    }
    throw error;
  }
  await next();
};

export const publicStatus = new Hono<AppEnv>()
  .use("/_/confirm", subscriptionTokenPrivacy)
  .use("/_/unsubscribe", subscriptionTokenPrivacy)
  .use("/:slug/subscribe", subscriptionTokenPrivacy)
  .use("/:slug", statusAccess)
  .use("/:slug/*", statusAccess)
  // one-line state for embeds; small and cacheable
  .get("/:slug/summary", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404, { "cache-control": "public, max-age=60" });
    const board = await repo.statusBoard(page);
    const overall = overallOf(board.components.map((x) => x.status));
    return c.json(
      { slug: page.slug, title: page.title, overall, label: LABELS[overall][langOf(c)], url: `${appUrl()}/status/${page.slug}`, updatedAt: new Date().toISOString() },
      200,
      { "cache-control": "public, max-age=30" },
    );
  })
  // shields-style SVG for READMEs and <img> tags
  .get("/:slug/badge.svg", async (c) => {
    const repo = c.get("repo");
    const lang = langOf(c);
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    const overall: Overall | null = page ? overallOf((await repo.statusBoard(page)).components.map((x) => x.status)) : null;
    const left = lang === "zh" ? "状态" : "status";
    const right = overall ? LABELS[overall][lang] : lang === "zh" ? "未知" : "unknown";
    const color = overall ? COLORS[overall] : "#9ca3af";
    const lw = Math.round(textWidth(left) + 20);
    const rw = Math.round(textWidth(right) + 20);
    const w = lw + rw;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${esc(left)}: ${esc(right)}"><title>${esc(left)}: ${esc(right)}</title><clipPath id="r"><rect width="${w}" height="22" rx="4"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="22" fill="#555"/><rect x="${lw}" width="${rw}" height="22" fill="${color}"/></g><g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif,PingFang SC,Microsoft YaHei" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="15">${esc(left)}</text><text x="${lw + rw / 2}" y="15">${esc(right)}</text></g></svg>`;
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=60" });
  })
  // incident history, newest first, cursor = startedAt of the last item of the previous page
  .get("/:slug/incidents", async (c) => {
    const before = c.req.query("before");
    const cursor = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
    const slug = c.req.param("slug");
    const refused = await mcpDenied(c, slug);
    if (refused) return refused;
    const body = await historyCache.cached(
      `${slug}|${cursor?.toISOString() ?? ""}`,
      async () => {
        const repo = c.get("repo");
        const page = await repo.statusPageBySlug(slug);
        if (!page) return undefined;
        const rows = await repo.pageIncidents(page, { limit: HISTORY_PAGE + 1, before: cursor });
        const items = rows.slice(0, HISTORY_PAGE).map(toPublic);
        return { items, next: rows.length > HISTORY_PAGE ? items[items.length - 1].startedAt : null };
      },
      waitUntilOf(c),
      { bypass: c.get("statusResponsePrivate") },
    );
    return body ? c.json(body) : c.json({ error: "Not found" }, 404);
  })
  // incidents and maintenance together, newest first; /rss stays as the original address of the same feed
  .get("/:slug/rss.xml", (c) => rssFeed(c))
  .get("/:slug/rss", (c) => rssFeed(c))
  // scheduled maintenance as a calendar subscription
  .get("/:slug/maintenance.ics", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const windows = await repo.pageMaintenance(page, { since: new Date(Date.now() - 30 * 864e5), limit: ICS_LIMIT });
    const origin = appUrl() || new URL(c.req.url).origin;
    const body = buildIcs({ title: page.title, link: pageHome(c, page, origin), host: new URL(origin).host, windows });
    return c.body(body, 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=300" });
  })
  // short, factual page summary for language models and other crawlers
  .get("/:slug/llms.txt", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const [board, windows] = await Promise.all([repo.statusBoard(page), repo.pageMaintenance(page, { since: new Date(), limit: 10 })]);
    const origin = appUrl() || new URL(c.req.url).origin;
    const body = buildLlmsTxt({
      title: page.title,
      link: pageHome(c, page, origin),
      api: `${origin}/api/public/status/${page.slug}`,
      overall: LABELS[overallOf(board.components.map((x) => x.status))].en,
      components: board.components,
      incidents: board.incidents,
      maintenance: windows,
      mcp: page.mcpEnabled ? `${origin}/api/mcp/public` : null,
    });
    return c.body(body, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
  })
  // upcoming and recent maintenance as JSON (the public MCP tools read this)
  .get("/:slug/maintenance", async (c) => {
    const slug = c.req.param("slug");
    const refused = await mcpDenied(c, slug);
    if (refused) return refused;
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(slug);
    if (!page) return c.json({ error: "Not found" }, 404);
    const now = Date.now();
    const rows = await repo.pageMaintenance(page, { since: new Date(now - 7 * 864e5), limit: 50 });
    const items = rows.map((w) => ({
      id: w.id,
      name: w.name,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      state: w.startsAt.getTime() > now ? "scheduled" : w.endsAt.getTime() >= now ? "active" : "completed",
    }));
    return c.json({ slug: page.slug, items }, 200, { "cache-control": "public, max-age=60" });
  })
  .post("/:slug/subscribe", subscriptionBodyGuard, zValidator("json", emailSchema.extend({ monitorIds: z.array(z.string().uuid()).max(200).optional() })), async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const { email, monitorIds } = c.req.valid("json");
    // Each request can trigger an outbound email, so cap per client, per address and per page.
    const ip = clientIp(c);
    const ok =
      (!ip || (await repo.withinLimit(`sub:ip:${ip}`, 10, 3600))) &&
      (await repo.withinLimit(`sub:mail:${page.id}:${email}`, 3, 3600)) &&
      // one address across all pages, so many pages cannot be used to mail it
      (await repo.withinLimit(`sub:mail:${email}`, 5, 3600)) &&
      (await repo.withinLimit(`sub:page:${page.id}`, 200, 3600));
    if (!ok) return c.json({ error: "Too many requests, try again later" }, 429);
    if ((await repo.subscriberCount(page.id)) >= MAX_SUBSCRIBERS) return c.json({ error: "Subscriber limit reached" }, 409);
    // only components that are on the page can be chosen
    const shown = new Set((await repo.pageComponents(page.id)).map((x) => x.monitorId));
    const chosen = [...new Set(monitorIds ?? [])].filter((id) => shown.has(id));
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const row = await repo.addSubscriber({ pageId: page.id, email, token, locale: langFromHeader(c.req.header("accept-language")), monitorIds: chosen, accessVersion: page.accessVersion });
    // Always the same answer, so the endpoint does not reveal who is subscribed. A pending address gets its confirmation
    // again (the first link may be lost); a confirmed one gets nothing, so the form cannot be used to mail a stranger.
    if (row.confirmed) return c.json({ ok: true });
    const lang = row.locale === "zh-CN" ? "zh-CN" : "en";
    const white = await brandingHidden(c, page);
    const footer = tr(lang, white ? "Status updates from {title}." : "Status updates from {title}. Powered by Montral.", { title: page.title });
    const mail = actionEmail({
      title: tr(lang, "Confirm your subscription to {title}", { title: page.title }),
      body: tr(lang, "You will get an email when an incident is opened, updated or resolved. If this wasn’t you, ignore this message and you won’t be subscribed."),
      footer,
      cta: tr(lang, "Confirm subscription"),
      url: `${appUrl()}/api/public/status/_/confirm?token=${row.token}`,
      lang,
      brand: white ? page.title : undefined,
    });
    const subject = tr(lang, "Confirm your subscription to {title}", { title: page.title });
    // Provider exceptions may echo recipient addresses, mail authentication
    // credentials, or the bearer token in the confirmation URL. Never log
    // the raw error or the message; preserve the existing non-enumerating
    // response and keep the subscriber unconfirmed for a later retry.
    await sendEmail({ to: email, subject, fromName: white ? page.title : "Montral", ...mail }, true)
      .catch(() => console.error("subscription email failed; provider diagnostics suppressed"));
    return c.json({ ok: true });
  })
  // Confirming stays a GET so the link in the mail works in one click; it only ever sets a flag, so repeating it (or a mail
  // scanner opening it) changes nothing further. Unsubscribing is different: GET shows a page, and only a POST acts.
  // Unlock a password page. Every failure (wrong password, unknown slug, a page that is not password-protected, a
  // malformed body) is the same 401, and an unknown page still pays for one PBKDF2 verification, so the answer does not
  // reveal which slugs exist. Limited per client and per page.
  .post("/_/unlock", subscriptionTokenPrivacy, subscriptionBodyGuard, async (c) => {
    const repo = c.get("repo");
    const refused = () => c.json({ error: "Incorrect password" }, 401);
    // Only the web app's own form may unlock: a cross-site form post (text/plain, foreign Origin) would plant an
    // attacker-chosen page grant in the visitor's browser.
    // A page served on its verified custom domain posts from that origin: accepted for that page only.
    const origin = c.req.header("origin");
    const forbidden = () => c.json({ error: "Unlock requests must come from this site" }, 403);
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return forbidden();
    const mainOrigin = !origin || origin === c.env.WEB_ORIGIN || origin === new URL(c.req.url).origin;
    const body = (await c.req.json().catch(() => null)) as { slug?: unknown; password?: unknown } | null;
    const slug = typeof body?.slug === "string" && /^[a-z0-9-]{3,40}$/.test(body.slug) ? body.slug : null;
    const password = typeof body?.password === "string" && body.password.length <= 200 ? body.password : null;
    if (!mainOrigin) {
      const domainPage = slug && !isWorkers() ? await repo.statusPageBySlug(slug) : null;
      const allowed = !!domainPage?.customDomain && !!domainPage.customDomainVerifiedAt &&
        origin === customDomainOrigin(domainPage.customDomain, c.env.WEB_ORIGIN);
      if (!allowed) return forbidden();
    }
    if (!slug || !password) return refused();
    const ip = clientIp(c);
    // Per client: every attempt counts. Per page: an attempt takes a slot atomically before the (slow) password check
    // and gives it back on success, so only failures stay counted (visitors who know the password are not locked out
    // by frequent correct unlocks) and concurrent guesses cannot all pass a count that is read before they finish.
    const pageKey = `sp-unlock:fail:${slug}`;
    const ok = (!ip || (await repo.withinLimit(`sp-unlock:ip:${ip}`, 20, 900))) &&
      (!ip || (await repo.withinLimit(`sp-unlock:ip:${ip}:${slug}`, 8, 900))) &&
      (await repo.withinLimit(pageKey, UNLOCK_PAGE_FAILURES, 3600));
    if (!ok) return c.json({ error: "Too many attempts, try again later" }, 429);
    const page = await repo.statusPageBySlug(slug);
    const target = page?.visibility === "password" ? page : null;
    if (!(await verifyPagePassword(password, target?.accessPasswordHash ?? null)) || !target) return refused();
    await c.get("database").query("UPDATE rate_limit SET count = greatest(count - 1, 0) WHERE key = $1", [pageKey]);
    c.header("set-cookie", await accessCookie(c.env, target, null, new Date(Date.now() + 12 * 3_600_000)));
    return c.body(null, 204);
  })
  // A share link: trade the token for an access cookie and land on the page, with the token gone from the address bar.
  .get("/_/access", subscriptionTokenPrivacy, async (c) => {
    const repo = c.get("repo");
    const ip = clientIp(c);
    if (ip && !(await repo.withinLimit(`sp-link:ip:${ip}`, 30, 900))) return c.json({ error: "Too many attempts, try again later" }, 429);
    const grant = await redeemShareToken(c.get("database"), c.req.query("t") ?? "");
    const page = grant ? await repo.statusPageBySlug(grant.slug) : null;
    if (!grant || !page || page.visibility === "public") {
      return c.text("This link is invalid, has expired or was revoked. Ask the page owner for a new one.", 404);
    }
    c.header("set-cookie", await accessCookie(c.env, page, grant.linkId, grant.expiresAt));
    return c.redirect(`/status/${page.slug}`, 303);
  })
  .get("/_/confirm", async (c) => {
    const slug = await c.get("repo").confirmSubscriber(c.req.query("token") ?? "");
    return c.redirect(slug ? `${appUrl()}/status/${slug}?subscribed=1` : `${appUrl()}/`);
  })
  .get("/_/unsubscribe", (c) => {
    const token = c.req.query("token") ?? "";
    const zh = langOf(c) === "zh";
    const t = zh
      ? { title: "取消订阅", text: "确认不再收到此状态页的邮件通知？", button: "取消订阅" }
      : { title: "Unsubscribe", text: "Stop receiving email updates from this status page?", button: "Unsubscribe" };
    const html = `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${t.title}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f4;color:#0e1411}main{max-width:360px;padding:24px;text-align:center}button{font:inherit;font-weight:600;padding:10px 20px;border:0;border-radius:8px;background:#0e1411;color:#fff;cursor:pointer}</style></head><body><main><h1 style="font-size:20px">${t.title}</h1><p>${t.text}</p><form method="post" action="?token=${encodeURIComponent(token)}"><button type="submit">${t.button}</button></form></main></body></html>`;
    return c.html(html, 200);
  })
  // POST acts: from the page's button (answered with a redirect) and from a mail client's one-click unsubscribe (RFC 8058, answered with 200)
  .post("/_/unsubscribe", async (c) => {
    // Mail clients send a tiny RFC 8058 body. Do not buffer an arbitrary
    // unauthenticated stream or act on a token before checking its size.
    let oneClick: boolean | null;
    try {
      oneClick = await unsubscribeOneClick(c.req.raw);
    } catch (error) {
      if (error instanceof UnsubscribeBodyTimeoutError) {
        return c.json({ error: "Unsubscribe request body read timeout" }, 408);
      }
      throw error;
    }
    if (oneClick === null) return c.json({ error: "Payload too large" }, 413);
    const slug = await c.get("repo").removeSubscriber(c.req.query("token") ?? "");
    if (oneClick) return c.text("OK");
    return c.redirect(slug ? `${appUrl()}/status/${slug}?unsubscribed=1` : `${appUrl()}/`, 303);
  })
  .get("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const refused = await mcpDenied(c, slug);
    if (refused) return refused;
    const body = await boardCache.cached(
      slug,
      async () => {
        const repo = c.get("repo");
        const page = await repo.statusPageBySlug(slug);
        if (!page) return undefined;
        const board = await repo.statusBoard(page);
        return {
          page: { slug: page.slug, title: page.title, theme: page.theme, showLatency: page.showLatency, externalUrl: page.externalUrl, hideBranding: await brandingHidden(c, page), uptimeOkPct: page.uptimeOkPct, uptimeWarnPct: page.uptimeWarnPct },
          overall: overallOf(board.components.map((x) => x.status)),
          bucket: board.bucket,
          components: board.components,
          incidents: board.incidents.map(toPublic),
        };
      },
      waitUntilOf(c),
      { bypass: c.get("statusResponsePrivate") },
    );
    return body ? c.json(body) : c.json({ error: "Not found" }, 404);
  });
