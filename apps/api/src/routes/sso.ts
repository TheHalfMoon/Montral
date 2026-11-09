import { Hono, type Context } from "hono";
import { z } from "zod";
import { audit, auditChanges, type Query } from "../audit";
import { appHosts, newDomainToken, statusPageDomain, verifyDomainToken, type TxtResolver } from "../custom-domain";
import type { AppEnv } from "../env";
import { limitedJsonBody } from "../json-body-budget";
import { isWorkers } from "../netguard";
import { allow } from "../ratelimit";
import { ssoCallbackUrl } from "../sso-auth";
import { discover, normalizeIssuer, SsoError } from "../sso-oidc";
import { encryptSecret } from "../sso-secret";
import { forgetSsoRequirement, instanceConnection, isOwnerRole, providerIdOf } from "../sso-store";

/**
 * Single sign-on settings of the active workspace: one OpenID Connect connection, its email domains (each verified
 * with a DNS TXT record) and the "require SSO" switch. Owner only, from a signed-in session (never an API key or an
 * agent). The client secret is write-only: stored encrypted, never returned, never logged or audited.
 */

const body = z.object({
  issuer: z.string().max(500),
  clientId: z.string().trim().min(1).max(255),
  /** empty or absent on an update: keep the stored one */
  clientSecret: z.string().max(2000).optional(),
  domains: z.array(z.string().max(253)).max(20).default([]),
  defaultRole: z.enum(["member", "admin"]).default("member"),
  requireSso: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).strict();

type ConnectionRow = { id: string; issuer: string; client_id: string; default_role: string; require_sso: boolean; enabled: boolean; created_at: Date | string; updated_at: Date | string };
type DomainRow = { id: string; domain: string; token: string; verified_at: Date | string | null };

const q = (c: Context<AppEnv>): Query => { const database = c.get("database"); return (sql, params) => database.query(sql, params); };
const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

/** DNS over HTTPS for Workers, which have no resolver API; Node uses the system resolver (custom-domain.ts). */
const dohTxt: TxtResolver = async (name) => {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw Object.assign(new Error("lookup failed"), { code: "ESERVFAIL" });
  const json = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
  if (json.Status === 3) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  if (json.Status !== 0) throw Object.assign(new Error("lookup failed"), { code: "ESERVFAIL" });
  return (json.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => [...a.data!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")));
};

async function view(c: Context<AppEnv>) {
  const [row] = await q(c)<ConnectionRow>(
    `SELECT id::text AS id, issuer, client_id, default_role, require_sso, enabled, created_at, updated_at FROM sso_connection WHERE organization_id = $1::text`,
    [c.get("orgId")],
  );
  const domains = row ? await q(c)<DomainRow>(`SELECT id::text AS id, domain, token, verified_at FROM sso_domain WHERE connection_id = $1::uuid ORDER BY domain`, [row.id]) : [];
  return {
    callbackUrl: ssoCallbackUrl(c.env),
    instanceProvider: !!instanceConnection(c.env),
    connection: row ? {
      id: row.id,
      issuer: row.issuer,
      clientId: row.client_id,
      // write-only: only whether one is stored
      hasClientSecret: true,
      defaultRole: row.default_role,
      requireSso: row.require_sso,
      enabled: row.enabled,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      domains: domains.map((d) => ({ domain: d.domain, verified: d.verified_at !== null, verifiedAt: iso(d.verified_at), txtName: `_montral-challenge.${d.domain}`, txtValue: d.token })),
    } : null,
  };
}

const ssoErrorResponse = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof SsoError) return c.json({ error: e.message, code: e.code }, 400);
  throw e;
};

export const ssoAdmin = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("cache-control", "private, no-store");
    c.header("x-content-type-options", "nosniff");
    if (c.get("workspaceGrant") !== null) return c.json({ error: "Single sign-on is managed from a signed-in session, not with an API key or agent authorization" }, 403);
    if (!isOwnerRole(await c.get("repo").memberRole(c.get("userId"), c.get("orgId")))) return c.json({ error: "Only the workspace owner can manage single sign-on" }, 403);
    await next();
  })
  .get("/", async (c) => c.json(await view(c)))

  .put("/", async (c) => {
    const parsed = body.safeParse(await limitedJsonBody(c.req.raw, 16 * 1024));
    if (!parsed.success) return c.json({ error: "Invalid single sign-on settings", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    const input = parsed.data;
    let issuer: string;
    try {
      issuer = normalizeIssuer(input.issuer);
    } catch (e) {
      return ssoErrorResponse(c, e);
    }
    const domains: string[] = [];
    for (const raw of input.domains) {
      const d = statusPageDomain(raw.replace(/^@/, ""), appHosts(c.env));
      if ("error" in d) return c.json({ error: `${raw.slice(0, 80)}: ${d.error}` }, 400);
      if (!domains.includes(d.domain)) domains.push(d.domain);
    }
    const orgId = c.get("orgId");
    const [current] = await q(c)<{ id: string; issuer: string }>(`SELECT id::text AS id, issuer FROM sso_connection WHERE organization_id = $1::text`, [orgId]);
    const secret = input.clientSecret?.trim() ?? "";
    if (!current && !secret) return c.json({ error: "Enter the client secret" }, 400);
    // the provider must answer as an OpenID Connect issuer before it is saved (and whenever it changes)
    if (!current || current.issuer !== issuer) {
      if (!(await allow(c.get("repo"), `sso:discover:${orgId}`, 30, 600))) return c.json({ error: "Too many attempts, try again later" }, 429);
      try {
        await discover(issuer, { fresh: true });
      } catch (e) {
        return ssoErrorResponse(c, e);
      }
    }
    const id = current?.id ?? crypto.randomUUID();
    const enc = secret ? await encryptSecret(c.env.BETTER_AUTH_SECRET, id, secret) : null;
    if (current) {
      await q(c)(
        `UPDATE sso_connection SET issuer = $2::text, client_id = $3::text, client_secret_enc = coalesce($4::text, client_secret_enc), default_role = $5::text,
                require_sso = $6::boolean, enabled = $7::boolean, updated_at = now() WHERE id = $1::uuid`,
        [id, issuer, input.clientId, enc, input.defaultRole, input.requireSso, input.enabled],
      );
      // links are keyed on issuer and subject, so links of another issuer can never match again: remove them
      if (current.issuer !== issuer) await q(c)(`DELETE FROM account WHERE provider_id = $1::text`, [providerIdOf(id)]);
    } else {
      try {
        await q(c)(
          `INSERT INTO sso_connection (id, organization_id, issuer, client_id, client_secret_enc, default_role, require_sso, enabled, created_by)
           VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean, $8::boolean, $9::text)`,
          [id, orgId, issuer, input.clientId, enc, input.defaultRole, input.requireSso, input.enabled, c.get("userId")],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "23505") return c.json({ error: "This workspace already has a single sign-on connection" }, 409);
        throw e;
      }
    }
    await q(c)(`DELETE FROM sso_domain WHERE connection_id = $1::uuid AND domain NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`, [id, JSON.stringify(domains)]);
    for (const d of domains) {
      await q(c)(`INSERT INTO sso_domain (connection_id, domain, token) VALUES ($1::uuid, $2::text, $3::text) ON CONFLICT (connection_id, domain) DO NOTHING`, [id, d, newDomainToken()]);
    }
    if (input.requireSso && input.enabled) {
      const [{ n }] = await q(c)<{ n: number }>(`SELECT count(*)::int AS n FROM sso_domain WHERE connection_id = $1::uuid AND verified_at IS NOT NULL`, [id]);
      if (!n) {
        await q(c)(`UPDATE sso_connection SET require_sso = false WHERE id = $1::uuid`, [id]);
        forgetSsoRequirement(orgId);
        await audit(c, current ? "sso.connection_update" : "sso.connection_create", { type: "sso_connection", id, projectId: null }, auditChanges({ ...input, clientSecret: secret ? "set" : undefined }, { enabled: input.enabled, requireSso: false, defaultRole: input.defaultRole }));
        return c.json({ ...(await view(c)), warning: "Saved, but single sign-on can only be required once a domain is verified" }, current ? 200 : 201);
      }
    }
    forgetSsoRequirement(orgId);
    await audit(c, current ? "sso.connection_update" : "sso.connection_create", { type: "sso_connection", id, projectId: null }, auditChanges({ ...input, clientSecret: secret ? "set" : undefined }, { enabled: input.enabled, requireSso: input.requireSso, defaultRole: input.defaultRole }));
    return c.json(await view(c), current ? 200 : 201);
  })

  .delete("/", async (c) => {
    const orgId = c.get("orgId");
    const [gone] = await q(c)<{ id: string }>(`DELETE FROM sso_connection WHERE organization_id = $1::text RETURNING id::text AS id`, [orgId]);
    forgetSsoRequirement(orgId);
    if (!gone) return c.body(null, 204);
    await q(c)(`DELETE FROM account WHERE provider_id = $1::text`, [providerIdOf(gone.id)]);
    await q(c)(`DELETE FROM sso_session WHERE connection_id = $1::text`, [gone.id]);
    await audit(c, "sso.connection_delete", { type: "sso_connection", id: gone.id, projectId: null }, null);
    return c.body(null, 204);
  })

  // "Test": discovery only, nothing is saved
  .post("/test", async (c) => {
    const raw = (await limitedJsonBody(c.req.raw, 2048)) as { issuer?: unknown } | null;
    if (!(await allow(c.get("repo"), `sso:discover:${c.get("orgId")}`, 30, 600))) return c.json({ error: "Too many attempts, try again later" }, 429);
    try {
      const d = await discover(normalizeIssuer(raw?.issuer), { fresh: true });
      return c.json({ ok: true, issuer: d.issuer, authorizationEndpoint: d.authorizationEndpoint, tokenEndpoint: d.tokenEndpoint, jwksUri: d.jwksUri, algorithms: d.algorithms, tokenAuth: d.tokenAuth });
    } catch (e) {
      return ssoErrorResponse(c, e);
    }
  })

  .post("/domains/:domain/verify", async (c) => {
    const orgId = c.get("orgId");
    const domain = c.req.param("domain").toLowerCase();
    const [row] = await q(c)<DomainRow>(
      `SELECT d.id::text AS id, d.domain, d.token, d.verified_at FROM sso_domain d JOIN sso_connection s ON s.id = d.connection_id WHERE s.organization_id = $1::text AND d.domain = $2::text`,
      [orgId, domain],
    );
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.verified_at) return c.json({ verified: true });
    if (!(await allow(c.get("repo"), `sso:verify:${orgId}`, 30, 600))) return c.json({ error: "Too many attempts, try again later" }, 429);
    const outcome = await verifyDomainToken(row.domain, row.token, isWorkers() ? dohTxt : undefined);
    if (!outcome.ok) {
      const why = { missing: "No TXT record was found", mismatch: "The TXT record does not hold the expected value", lookup_failed: "DNS could not be queried; try again" }[outcome.reason];
      return c.json({ error: why, reason: outcome.reason }, 400);
    }
    try {
      await q(c)(`UPDATE sso_domain SET verified_at = now() WHERE id = $1::uuid`, [row.id]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return c.json({ error: "Another workspace on this instance already verified this domain" }, 409);
      throw e;
    }
    await audit(c, "sso.domain_verify", { type: "sso_domain", id: row.id, projectId: null }, auditChanges({}, { domain: row.domain, verified: true }));
    return c.json({ verified: true });
  });
