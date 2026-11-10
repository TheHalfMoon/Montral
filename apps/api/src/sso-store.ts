import type { Query } from "./audit";
import type { Bindings } from "./env";
import { decryptSecret } from "./sso-secret";

/**
 * Database side of single sign-on: connections (per workspace, or the operator's instance-wide provider from OIDC_*),
 * their verified email domains, pending sign-ins, identity links and the "require SSO" checks.
 */

export const INSTANCE_CONNECTION = "instance";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Role = "member" | "admin";
export type SsoConnection = {
  /** a sso_connection id, or "instance" */
  id: string;
  /** the workspace it signs people into; null for the instance-wide provider */
  orgId: string | null;
  issuer: string;
  clientId: string;
  secret: () => Promise<string>;
  defaultRole: Role;
  enabled: boolean;
  requireSso: boolean;
  /** email domains it may sign in: verified ones for a workspace; OIDC_ALLOWED_DOMAINS (null: any) for the instance */
  domains: string[] | null;
  /** the token endpoint the client secret was entered for (workspace connections); null: not pinned */
  tokenEndpoint: string | null;
};

const list = (v: string | undefined) => [...new Set(String(v ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];

/** The operator's provider, when OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are all set. */
export function instanceConnection(env: Pick<Bindings, "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CLIENT_SECRET" | "OIDC_ALLOWED_DOMAINS">): SsoConnection | null {
  const issuer = String(env.OIDC_ISSUER ?? "").trim();
  const clientId = String(env.OIDC_CLIENT_ID ?? "").trim();
  const secret = String(env.OIDC_CLIENT_SECRET ?? "");
  if (!issuer || !clientId || !secret) return null;
  const domains = list(env.OIDC_ALLOWED_DOMAINS);
  return { id: INSTANCE_CONNECTION, orgId: null, issuer, clientId, secret: async () => secret, defaultRole: "member", enabled: true, requireSso: false, domains: domains.length ? domains : null, tokenEndpoint: null };
}

type Row = { id: string; organization_id: string; issuer: string; client_id: string; client_secret_enc: string; token_endpoint: string | null; default_role: Role; require_sso: boolean; enabled: boolean; domains: string[] | null };

const toConnection = (r: Row, serverSecret: string): SsoConnection => ({
  id: r.id,
  orgId: r.organization_id,
  issuer: r.issuer,
  clientId: r.client_id,
  secret: () => decryptSecret(serverSecret, r.id, r.client_secret_enc),
  defaultRole: r.default_role === "admin" ? "admin" : "member",
  enabled: r.enabled,
  requireSso: r.require_sso,
  domains: r.domains ?? [],
  tokenEndpoint: r.token_endpoint,
});

const SELECT = `SELECT c.id::text AS id, c.organization_id, c.issuer, c.client_id, c.client_secret_enc, c.token_endpoint, c.default_role, c.require_sso, c.enabled,
       coalesce((SELECT array_agg(d.domain ORDER BY d.domain) FROM sso_domain d WHERE d.connection_id = c.id AND d.verified_at IS NOT NULL), '{}') AS domains
  FROM sso_connection c`;

/** A connection by id ("instance" included), whatever its state. */
export async function connectionById(q: Query, env: Bindings, id: string): Promise<SsoConnection | null> {
  if (id === INSTANCE_CONNECTION) return instanceConnection(env);
  if (!UUID.test(id)) return null;
  const [row] = await q<Row>(`${SELECT} WHERE c.id = $1::uuid`, [id]);
  return row ? toConnection(row, env.BETTER_AUTH_SECRET) : null;
}

/** Which enabled connection a sign-in starts with: a workspace by slug, else the email's verified domain, else the instance provider. */
export async function connectionForStart(q: Query, env: Bindings, by: { email?: string | null; workspace?: string | null }): Promise<SsoConnection | null> {
  if (by.workspace) {
    const [row] = await q<Row>(`${SELECT} JOIN organization o ON o.id = c.organization_id WHERE o.slug = $1::text AND c.enabled`, [by.workspace.trim().toLowerCase()]);
    return row ? toConnection(row, env.BETTER_AUTH_SECRET) : null;
  }
  const instance = instanceConnection(env);
  const email = by.email?.trim().toLowerCase();
  if (email) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const [row] = await q<Row>(`${SELECT} JOIN sso_domain v ON v.connection_id = c.id WHERE v.domain = $1::text AND v.verified_at IS NOT NULL AND c.enabled`, [domain]);
    if (row) return toConnection(row, env.BETTER_AUTH_SECRET);
    return instance && (!instance.domains || instance.domains.includes(domain)) ? instance : null;
  }
  return instance;
}

// ── pending sign-ins ───────────────────────────────────────────────────────────────────────────────────────────────

export const FLOW_TTL_SECONDS = 600;
export type FlowRow = {
  connection_id: string; organization_id: string | null; nonce: string; code_verifier: string; intent: "signin" | "link";
  link_user_id: string | null; return_to: string; fresh: boolean;
};

export async function createFlow(q: Query, f: { stateHash: string; bindingHash: string; connectionId: string; orgId: string | null; nonce: string; codeVerifier: string; intent: "signin" | "link"; linkUserId: string | null; returnTo: string }) {
  // expired rows are only clutter (a consumed or expired flow can never be used); keep the table small
  if (Math.random() < 0.05) await q(`DELETE FROM sso_flow WHERE expires_at < now() - interval '1 hour'`);
  await q(
    `INSERT INTO sso_flow (state_hash, binding_hash, connection_id, organization_id, nonce, code_verifier, intent, link_user_id, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10::int))`,
    [f.stateHash, f.bindingHash, f.connectionId, f.orgId, f.nonce, f.codeVerifier, f.intent, f.linkUserId, f.returnTo, FLOW_TTL_SECONDS],
  );
}

/**
 * Takes a pending sign-in out of the table: single use, and only for the browser holding the binding cookie. A state
 * that is replayed, expired or presented by another browser finds nothing.
 */
export async function consumeFlow(q: Query, stateHash: string, bindingHash: string): Promise<FlowRow | null> {
  const [row] = await q<FlowRow>(
    `DELETE FROM sso_flow WHERE state_hash = $1::text AND binding_hash = $2::text
     RETURNING connection_id, organization_id, nonce, code_verifier, intent, link_user_id, return_to, (expires_at > now()) AS fresh`,
    [stateHash, bindingHash],
  );
  return row && row.fresh ? row : null;
}

// ── identities ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const providerIdOf = (connectionId: string) => `sso:${connectionId}`;
/** The identity a link is keyed on: issuer and subject together, so a connection whose issuer changes matches nobody. */
export const accountIdOf = (issuer: string, subject: string) => `${issuer}|${subject}`;

export async function userByIdentity(q: Query, connectionId: string, issuer: string, subject: string): Promise<string | null> {
  const [row] = await q<{ user_id: string }>(`SELECT user_id FROM account WHERE provider_id = $1::text AND account_id = $2::text`, [providerIdOf(connectionId), accountIdOf(issuer, subject)]);
  return row?.user_id ?? null;
}

export async function userByEmail(q: Query, email: string): Promise<{ id: string; email: string } | null> {
  const [row] = await q<{ id: string; email: string }>(`SELECT id, email FROM "user" WHERE lower(email) = $1::text LIMIT 1`, [email.toLowerCase()]);
  return row ?? null;
}

export async function userById(q: Query, id: string): Promise<{ id: string; email: string } | null> {
  const [row] = await q<{ id: string; email: string }>(`SELECT id, email FROM "user" WHERE id = $1::text`, [id]);
  return row ?? null;
}

/**
 * Creates the account of someone signing in for the first time (no Montral user has the address), its SSO link and,
 * for a workspace connection, the membership: one statement, so it all happens or nothing does. Returns null when an
 * account with that address appeared in the meantime. The email is marked verified: the provider vouched for it and
 * its domain is one the connection may use.
 */
export async function provisionUser(q: Query, p: { email: string; name: string; connectionId: string; issuer: string; subject: string; orgId: string | null; role: Role }): Promise<string | null> {
  const userId = crypto.randomUUID().replace(/-/g, "");
  const rows = await q<{ user_id: string }>(
    `WITH u AS (
       INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1::text, $2::text, $3::text, true, now(), now())
       ON CONFLICT DO NOTHING RETURNING id
     ), a AS (
       INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       SELECT $4::text, $5::text, $6::text, id, now(), now() FROM u RETURNING user_id
     ), m AS (
       INSERT INTO member (id, organization_id, user_id, role, created_at)
       SELECT $7::text, $8::text, user_id, $9::text, now() FROM a WHERE $8::text IS NOT NULL RETURNING user_id
     )
     SELECT user_id FROM a`,
    [userId, p.name, p.email, crypto.randomUUID(), accountIdOf(p.issuer, p.subject), providerIdOf(p.connectionId), crypto.randomUUID(), p.orgId, p.role],
  );
  return rows[0]?.user_id ?? null;
}

/** Links an SSO identity to an existing user (who proved the account by being signed in). */
export async function linkIdentity(q: Query, p: { userId: string; connectionId: string; issuer: string; subject: string }) {
  await q(
    `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ($1::text, $2::text, $3::text, $4::text, now(), now())`,
    [crypto.randomUUID(), accountIdOf(p.issuer, p.subject), providerIdOf(p.connectionId), p.userId],
  );
}

export async function markSsoSession(q: Query, sessionId: string, connectionId: string) {
  await q(`INSERT INTO sso_session (session_id, connection_id) VALUES ($1::text, $2::text) ON CONFLICT (session_id) DO NOTHING`, [sessionId, connectionId]);
}

// ── require SSO ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The roles of a member row (Better Auth stores several as "a,b"). */
export const isOwnerRole = (role: string | null | undefined) => !!role && role.split(",").map((r) => r.trim()).includes("owner");

/** Enabled require-SSO workspaces in which this user is a member other than an owner, with the connection each requires. */
export async function ssoRequiredFor(q: Query, userId: string): Promise<{ orgId: string; connectionId: string }[]> {
  const rows = await q<{ organization_id: string; connection_id: string }>(
    `SELECT c.organization_id, c.id::text AS connection_id FROM member m JOIN sso_connection c ON c.organization_id = m.organization_id
      WHERE m.user_id = $1::text AND c.enabled AND c.require_sso AND NOT ('owner' = ANY (string_to_array(replace(m.role, ' ', ''), ',')))`,
    [userId],
  );
  return rows.map((r) => ({ orgId: r.organization_id, connectionId: r.connection_id }));
}

// which connection a workspace requires: asked on every session request, so remembered briefly per isolate
const requirementCache = new Map<string, { connectionId: string | null; until: number }>();
export const REQUIREMENT_TTL_MS = 30_000;
export const forgetSsoRequirement = (orgId: string) => requirementCache.delete(orgId);

export async function ssoRequirementOf(q: Query, orgId: string): Promise<string | null> {
  const hit = requirementCache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.connectionId;
  const [row] = await q<{ id: string }>(`SELECT id::text AS id FROM sso_connection WHERE organization_id = $1::text AND enabled AND require_sso`, [orgId]);
  if (requirementCache.size > 5000) requirementCache.clear();
  requirementCache.set(orgId, { connectionId: row?.id ?? null, until: Date.now() + REQUIREMENT_TTL_MS });
  return row?.id ?? null;
}

/** Whether `sessionId` is a live (unexpired) session that `connectionId` created. */
export async function sessionVia(q: Query, sessionId: string, connectionId: string): Promise<boolean> {
  const rows = await q(
    `SELECT 1 AS one FROM sso_session x JOIN session s ON s.id = x.session_id
      WHERE x.session_id = $1::text AND x.connection_id = $2::text AND s.expires_at > now()`,
    [sessionId, connectionId],
  );
  return rows.length > 0;
}

/**
 * For the OAuth authorization endpoints, where the workspaces a grant ends up covering are not known for sure in
 * advance: the session must satisfy every require-SSO workspace in which the user is a member other than an owner.
 */
export async function ssoSatisfiesAll(q: Query, userId: string, sessionId: string): Promise<boolean> {
  const required = await ssoRequiredFor(q, userId);
  if (!required.length) return true;
  const via = await sessionConnection(q, sessionId);
  return !!via && required.every((r) => r.connectionId === via);
}

// ── removals ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Someone was removed from (or left) a workspace: their address and their SSO identities at its connection are
 * remembered, so neither can be provisioned into it again (not even after deleting the account) until someone
 * invites the address again.
 */
export async function recordRemoval(q: Query, orgId: string, userId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `INSERT INTO sso_removal (organization_id, email, account_id)
     SELECT $1::text, lower(u.email), NULL FROM "user" u WHERE u.id = $2::text
     UNION ALL
     SELECT $1::text, lower(u.email), a.account_id FROM "user" u
       JOIN account a ON a.user_id = u.id
       JOIN sso_connection c ON a.provider_id = 'sso:' || c.id::text AND c.organization_id = $1::text
      WHERE u.id = $2::text
     RETURNING id::text AS id`,
    [orgId, userId],
  );
  return rows.map((r) => r.id);
}

export async function removedFrom(q: Query, orgId: string, email: string, accountId: string): Promise<boolean> {
  const rows = await q(
    `SELECT 1 AS one FROM sso_removal WHERE organization_id = $1::text AND (email = lower($2::text) OR account_id = $3::text) LIMIT 1`,
    [orgId, email, accountId],
  );
  return rows.length > 0;
}

/** An accepted invitation to the address lifts the block (for the address and the identities recorded with it). */
export async function clearRemoval(q: Query, orgId: string, email: string) {
  await q(`DELETE FROM sso_removal WHERE organization_id = $1::text AND email = lower($2::text)`, [orgId, email]);
}

/**
 * The connection's provider or client changed: what the old one produced is no longer proof of anything. Its
 * sessions are signed out (their sso_session rows go with them) and the credentials made from them stop counting.
 */
export async function invalidateConnection(q: Query, connectionId: string) {
  await q(`DELETE FROM session WHERE id IN (SELECT session_id FROM sso_session WHERE connection_id = $1::text)`, [connectionId]);
  await q(`DELETE FROM sso_session WHERE connection_id = $1::text`, [connectionId]);
  await q(`DELETE FROM sso_credential WHERE connection_id = $1::text`, [connectionId]);
}

// ── credentials made from SSO sessions ─────────────────────────────────────────────────────────────────────────────

/** The connection that created this session, if it was an SSO sign-in. */
export async function sessionConnection(q: Query, sessionId: string): Promise<string | null> {
  const [row] = await q<{ connection_id: string }>(`SELECT connection_id FROM sso_session WHERE session_id = $1::text`, [sessionId]);
  return row?.connection_id ?? null;
}

export type CredentialKind = "api_key";

export async function recordSsoCredential(q: Query, kind: CredentialKind, credentialId: string, connectionId: string) {
  await q(`INSERT INTO sso_credential (kind, credential_id, connection_id) VALUES ($1::text, $2::text, $3::text) ON CONFLICT DO NOTHING`, [kind, credentialId, connectionId]);
}

export async function credentialVia(q: Query, kind: CredentialKind, credentialId: string, connectionId: string): Promise<boolean> {
  const rows = await q(`SELECT 1 AS one FROM sso_credential WHERE kind = $1::text AND credential_id = $2::text AND connection_id = $3::text`, [kind, credentialId, connectionId]);
  return rows.length > 0;
}

/**
 * Someone left or was removed from a workspace: their links to that workspace's SSO connection go too, so a later SSO
 * sign-in finds an unlinked identity of an existing account (refused) instead of signing them back in.
 */
export async function dropSsoLinksOfFormerMember(q: Query, orgId: string, userId: string) {
  await q(
    `DELETE FROM account a USING sso_connection c
      WHERE c.organization_id = $1::text AND a.provider_id = 'sso:' || c.id::text AND a.user_id = $2::text
        AND NOT EXISTS (SELECT 1 FROM member m WHERE m.organization_id = $1::text AND m.user_id = $2::text)`,
    [orgId, userId],
  );
}

/**
 * When "require SSO" is switched on: sessions of members other than an owner that this connection did not create are
 * deleted (they are also refused per request; deleting them signs those browsers out). Returns how many.
 */
export async function revokeNonSsoSessions(q: Query, orgId: string, connectionId: string): Promise<number> {
  const rows = await q(
    `DELETE FROM session s USING member m
      WHERE m.organization_id = $1::text AND m.user_id = s.user_id
        AND NOT ('owner' = ANY (string_to_array(replace(m.role, ' ', ''), ',')))
        AND NOT EXISTS (SELECT 1 FROM sso_session x WHERE x.session_id = s.id AND x.connection_id = $2::text)
      RETURNING s.id`,
    [orgId, connectionId],
  );
  return rows.length;
}

/**
 * Whether this user, with this session, may act on `orgId` given its "require SSO" setting: always for owners and for
 * workspaces without the requirement; otherwise only with a session the workspace's own connection created.
 */
export async function ssoAllows(q: Query, orgId: string, userId: string, sessionId: string): Promise<boolean> {
  const required = await ssoRequirementOf(q, orgId);
  if (!required) return true;
  const [m] = await q<{ role: string }>(`SELECT role FROM member WHERE organization_id = $1::text AND user_id = $2::text`, [orgId, userId]);
  if (!m || isOwnerRole(m.role)) return true; // non-members are refused by the membership checks themselves
  return sessionVia(q, sessionId, required);
}

/**
 * Accounts whose other sign-in methods may only be added explicitly (from Account settings while signed in): users
 * with an SSO identity (provisioned or linked), and members other than an owner of an enabled require-SSO workspace.
 * For them a social provider reporting the same verified email never links by itself.
 */
export async function ssoProtected(q: Query, userId: string): Promise<boolean> {
  const rows = await q(
    `SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM account WHERE user_id = $1::text AND provider_id LIKE 'sso:%')
        OR EXISTS (SELECT 1 FROM member m JOIN sso_connection c ON c.organization_id = m.organization_id
                    WHERE m.user_id = $1::text AND c.enabled AND c.require_sso
                      AND NOT ('owner' = ANY (string_to_array(replace(m.role, ' ', ''), ','))))`,
    [userId],
  );
  return rows.length > 0;
}
