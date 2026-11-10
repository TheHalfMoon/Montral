import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "@montral/repo";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { captcha, jwt, oneTimeToken, organization, twoFactor } from "better-auth/plugins";
import { actionEmail, appUrl, sendEmail } from "./email";
import { userLang, tr } from "./mail-i18n";
import type { Bindings } from "./env";
import { AUDITED_AUTH_PATHS, auditAuthCall, MEMBERSHIP_ENDING_PATHS, noteKeyBeforeDelete, noteMembershipBefore, type KeyNote, type MemberNote } from "./audit-auth";
import { ssoPlugin, type SsoSignIn } from "./sso-auth";
import { clearRemoval, dropSsoLinksOfFormerMember, recordRemoval, recordSsoCredential, sessionConnection, ssoAllows, ssoProtected, ssoRequiredFor, ssoSatisfiesAll } from "./sso-store";

/** Better Auth endpoints that act on a workspace without passing requireOrg: held to the workspace's "require SSO". */
const SSO_GUARDED_PATHS = new Set(["/api-key/create", "/api-key/update"]);
/**
 * The OAuth provider's endpoints that issue authorization codes or create or change consent. /oauth2/authorize issues a
 * code by itself when a consent is already on file, so it is guarded like the consent screens.
 */
const SSO_OAUTH_PATHS = new Set(["/oauth2/authorize", "/oauth2/continue", "/oauth2/consent", "/oauth2/update-consent"]);
const plain = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Error) && !(v instanceof Response) ? (v as Record<string, unknown>) : null);
const text = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Message (and code) of a sign-in refused because a workspace of the user requires single sign-on. */
export const SSO_REQUIRED_MESSAGE = "Your workspace requires single sign-on. Use “Sign in with SSO”.";

export function slugify(s: string) {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace") + "-" + Math.random().toString(36).slice(2, 6);
}

/** Invitation lifetime in days: INVITE_TTL_DAYS when it is a positive number, else 7. */
export function inviteTtlDays(env: Pick<Bindings, "INVITE_TTL_DAYS">) {
  const n = Number(env.INVITE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** Registration is closed (DISABLE_SIGNUP=true): only people with a pending invitation can still create an account. */
export const signupDisabled = (env: Pick<Bindings, "DISABLE_SIGNUP">) => ["true", "1"].includes(String(env.DISABLE_SIGNUP ?? "").trim().toLowerCase());

/**
 * Cloudflare Turnstile guards email sign-up when both keys are set: the site key is public (the form renders the
 * widget), the secret key stays on the server. Either one alone leaves it off, since a form with no widget could
 * never be submitted.
 */
export const turnstile = (env: Pick<Bindings, "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">) => {
  const siteKey = String(env.TURNSTILE_SITE_KEY ?? "").trim();
  const secretKey = String(env.TURNSTILE_SECRET_KEY ?? "").trim();
  return siteKey && secretKey ? { siteKey, secretKey } : null;
};

// scopes a token for the MCP resource may carry; offline_access must be here or refresh grants never keep it
const MCP_RESOURCE_SCOPES = ["mcp:read", "mcp:write", "offline_access"];

/** OAuth scopes an agent can be granted: read-only, or read and change. */
export const OAUTH_SCOPES = ["openid", "offline_access", "mcp:read", "mcp:write"] as const;

/** The MCP endpoint, which is the OAuth "resource" access tokens are issued for (RFC 8707). */
export const mcpResource = (env: Pick<Bindings, "BETTER_AUTH_URL">) => `${new URL(env.BETTER_AUTH_URL).origin}/api/mcp`;

/** The only redirect target a native app may ask for; the exact scheme and host, so no other custom scheme is trusted. */
export const NATIVE_CALLBACK = "montral://auth";
/** How long a handoff token stays valid, in minutes (the plugin counts minutes). */
export const HANDOFF_TTL_MINUTES = 1;

const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** True when a redirect location is the native app's callback (and nothing that merely starts with it). */
export const isNativeCallback = (location: string | null | undefined) => {
  if (!location || !location.startsWith(NATIVE_CALLBACK)) return false;
  const rest = location.slice(NATIVE_CALLBACK.length);
  return rest === "" || /^[/?#]/.test(rest);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the picker page leaves in a short-lived cookie, and what a consent stores as its reference:
 * `*` = every workspace the user is in; otherwise `;`-separated entries, each `<workspace id>` (all of its projects)
 * or `<workspace id>|<project id>,<project id>` (only those). The cookie may also say `<workspace id>|*`.
 */
export const GRANT_COOKIE = "montral_grant";
/**
 * The cookie reads `<code_challenge>~<grant>`: it only counts for the authorization request (one PKCE challenge) the
 * picker was shown for, so an answer left over from an earlier attempt can never skip the picker of a later one.
 */
export const grantCookie = (header: string | null | undefined, challenge: string) => {
  const m = header?.split(/;\s*/).find((p) => p.startsWith(`${GRANT_COOKIE}=`));
  let v = "";
  if (m) {
    try {
      v = decodeURIComponent(m.slice(GRANT_COOKIE.length + 1));
    } catch {
      // Malformed percent sequences and invalid UTF-8 are client-controlled.
      // Never abort the OAuth request or reuse a previous grant selection.
      return undefined;
    }
  }
  const i = v.indexOf("~");
  return i >= 0 && v.slice(0, i) === challenge ? v.slice(i + 1) || undefined : undefined;
};
type GrantEntry = { org: string; ids: string[] | null };
export function parseGrant(raw: string): "all" | GrantEntry[] {
  if (raw.trim() === "*") return "all";
  return raw
    .split(";")
    .map((e) => e.split("|"))
    .filter(([org]) => !!org)
    .map(([org, sel]) => ({ org, ids: !sel || sel === "*" ? null : sel.split(",") }));
}

/**
 * Every new user gets a personal workspace they own, and it becomes the active workspace of the session they signed
 * up with. Better Auth runs a user's create.after hook only once the whole sign-up has finished (it is queued "after
 * the transaction"), i.e. after the first session was created; that session's create.before hook therefore found no
 * workspace and stored none. Left like that, every request of the session had to guess a workspace.
 */
export async function givePersonalWorkspace(database: Pick<Database, "repo" | "query">, user: { id: string; name?: string | null; email: string }) {
  const name = `${user.name || user.email.split("@")[0]}'s workspace`;
  const id = crypto.randomUUID();
  await database.repo.createPersonalWorkspace({ id, name, slug: slugify(name), ownerId: user.id });
  await database.query(`update session set active_organization_id = $2 where user_id = $1 and active_organization_id is null`, [user.id, id]);
  return id;
}

/**
 * A member who leaves or is removed loses the API keys they pinned to that workspace: otherwise the keys would only be
 * blocked while the membership is missing and would work again after a re-invitation. Keys pinned elsewhere, and
 * unpinned keys (which follow the user's memberships), are kept. Metadata is parsed here, not cast in SQL, so one
 * malformed row cannot fail the whole statement.
 */
export async function revokeKeysPinnedTo(query: <T>(sql: string, params?: unknown[]) => Promise<T[]>, orgId: string, userId: string) {
  const keys = await query<{ id: string; metadata: unknown }>(`select id, metadata from apikey where reference_id = $1`, [userId]);
  const pinned = keys.filter((k) => {
    let meta = k.metadata;
    if (typeof meta === "string") {
      try { meta = JSON.parse(meta); } catch { return false; }
      // Better Auth may store the metadata JSON-encoded twice
      if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { return false; } }
    }
    return !!meta && typeof meta === "object" && (meta as { organizationId?: unknown }).organizationId === orgId;
  });
  if (pinned.length) await query(`delete from apikey where reference_id = $1 and id = any($2::text[])`, [userId, pinned.map((k) => k.id)]);
  return pinned.length;
}

/** Removes everything that could let someone who never proved the email keep access to the user. */
export async function purgeUnverifiedSecrets(database: Database, userId: string) {
  for (const sql of [
    `delete from account where user_id = $1 and (provider_id = 'credential' or password is not null)`,
    `delete from session where user_id = $1`,
    `delete from apikey where reference_id = $1`,
    `delete from two_factor where user_id = $1`,
    `update "user" set two_factor_enabled = false where id = $1`,
    `delete from oauth_access_token where user_id = $1`,
    `delete from oauth_refresh_token where user_id = $1`,
    `delete from oauth_consent where user_id = $1`,
    `delete from verification where value = $1`,
  ]) await database.query(sql, [userId]);
}

/**
 * The session for a request. The signed cookie cache serves a session for minutes without asking the database, which
 * would let a session that was just revoked (see purgeUnverifiedSecrets) live on; so for a user whose email is not
 * verified the cache is skipped and the database decides.
 */
export async function currentSession(auth: { api: { getSession: (o: { headers: Headers; query?: { disableCookieCache?: boolean } }) => Promise<any> } }, headers: Headers) {
  const cached = await auth.api.getSession({ headers });
  if (!cached || cached.user?.emailVerified) return cached;
  return auth.api.getSession({ headers, query: { disableCookieCache: true } });
}

export function createAuth(database: Database, env: Bindings) {
  const repo = database.repo;
  // this auth object lives for one request, so the cookie of that request can be parked here for the OAuth callbacks
  let picked: string | undefined;
  // the API key a delete request is about, read before Better Auth removes its row (audit log)
  let keyNote: KeyNote | null = null;
  // the acting user's membership, confirmed before a call that may end it (audit log)
  let memberNote: MemberNote | null = null;
  // the SSO removal recorded before a removal or leave runs (deleted again if the call fails)
  let removalNote: { orgId: string; userId: string; ids: string[] } | null = null;
  const query = <T>(sql: string, params?: unknown[]) => database.query<T>(sql, params);
  // set by the SSO callback around the session it creates (sso-auth.ts), read by the session hook below
  const ssoSignIn: SsoSignIn = { connectionId: null, orgId: null };
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN, NATIVE_CALLBACK],
    // A signed-in user may connect a GitHub account whose email differs from theirs (linking is always an explicit
    // action by the signed-in user). On sign-in an existing account is only matched when the provider says the email
    // is verified: trustedProviders stays empty, so an unverified address never links by itself.
    // requireLocalEmailVerified is off so the real owner of an email someone else registered without verifying it is
    // not locked out of GitHub sign-in; the account.create hook below then strips whatever that someone set up.
    account: { accountLinking: { enabled: true, allowDifferentEmails: true, trustedProviders: [], requireLocalEmailVerified: false } },
    // signed session cookie cache: most requests skip the session/user DB lookups entirely
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    database: database.authDatabase as never,
    // verification is requested at sign-up but never blocks sign-in, so accounts created before it existed keep working
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const lang = await userLang(repo, user.email);
        const mail = actionEmail({
          title: tr(lang, "Verify your email address"),
          body: tr(lang, "Confirm this address so we can reach you about your Montral account and recover it if you lose access."),
          footer: tr(lang, "Didn't create a Montral account? Ignore this email."),
          cta: tr(lang, "Verify email"),
          url,
          lang,
        });
        await sendEmail({ to: user.email, subject: tr(lang, "Verify your Montral email"), fromName: "Montral", ...mail });
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // a workspace nobody else belongs to goes with its owner; one with other members must be handed over first
        beforeDelete: async (u) => {
          const owned = await repo.ownedWorkspaces(u.id);
          const shared = owned.find((o) => o.members > 1);
          if (shared) throw new APIError("BAD_REQUEST", { message: `Remove the other members of "${shared.name}" (or delete it) before deleting your account` });
          await repo.deleteWorkspaces(owned.map((o) => o.id));
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // whoever held the old password (or a stolen session) is signed out when it is reset
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const lang = await userLang(repo, user.email);
        const mail = actionEmail({
          title: tr(lang, "Reset your password"),
          body: tr(lang, "Someone asked to reset the password for your Montral account. If that wasn't you, ignore this email and nothing will change."),
          footer: tr(lang, "Security email. You can't unsubscribe from these."),
          cta: tr(lang, "Choose a new password"),
          url,
          lang,
        });
        await sendEmail({ to: user.email, subject: tr(lang, "Reset your Montral password"), fromName: "Montral", ...mail });
      },
      // a reset is a security event: tell the owner afterwards, so a takeover does not go unnoticed
      onPasswordReset: async ({ user }) => {
        try {
          const lang = await userLang(repo, user.email);
          const mail = actionEmail({
            title: tr(lang, "Your password was changed"),
            body: tr(lang, "The password for your Montral account was just changed with a reset link, and you were signed out on every device. If this was you, sign in again with the new password.\n\nIf it wasn't you, reset your password again now."),
            footer: tr(lang, "Security email. You can't unsubscribe from these."),
            cta: tr(lang, "Reset password again"),
            url: `${appUrl()}/forgot-password`,
            lang,
          });
          await sendEmail({ to: user.email, subject: tr(lang, "Your Montral password was changed"), fromName: "Montral", ...mail });
        } catch (err) {
          // the password is already changed; a failed notice must not turn that into an error for the user
          console.error("password-changed email failed; provider diagnostics suppressed");
        }
      },
    },
    socialProviders:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {},
    hooks: {
      // Most MCP clients register without an application_type and use a loopback or custom-scheme redirect; the
      // OIDC default ("web") would refuse those, so such clients are treated as the native apps they are.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/api-key/delete") keyNote = await noteKeyBeforeDelete(query, ctx.body).catch(() => null);
        if (MEMBERSHIP_ENDING_PATHS.has(ctx.path)) {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          memberNote = await noteMembershipBefore(query, session as never, ctx.body).catch(() => null);
        }
        // access tokens are issued for the MCP endpoint; the resource row is created on first use because the
        // identifier is this deployment's own URL (known only at runtime, so it cannot ship in a migration)
        if (["/oauth2/authorize", "/oauth2/continue", "/oauth2/consent"].includes(ctx.path)) {
          const q = ctx.path === "/oauth2/authorize" ? (ctx.query as Record<string, unknown> | undefined)?.code_challenge : new URLSearchParams(String((ctx.body as { oauth_query?: unknown } | undefined)?.oauth_query ?? "")).get("code_challenge");
          picked = grantCookie(ctx.headers?.get("cookie"), typeof q === "string" ? q : "");
        }
        // "Require SSO" for what Better Auth runs itself (members, invitations, roles, the active workspace, agent
        // consent, API keys): a member other than an owner may only act on such a workspace with a session its own
        // SSO connection created. The workspaces concerned: the one named in the request, else the active one; for an
        // agent's consent, every workspace the grant would cover.
        // The OAuth endpoints do not trust the picker cookie (montral_grant, written by the browser) to say which
        // workspaces a grant covers: the session must satisfy every require-SSO workspace of the user.
        if (SSO_OAUTH_PATHS.has(ctx.path)) {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          if (session && !(await ssoSatisfiesAll(query, session.user.id, session.session.id))) {
            throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED" });
          }
        }
        if (ctx.path.startsWith("/organization/") || SSO_GUARDED_PATHS.has(ctx.path)) {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          if (session) {
            const body = plain(ctx.body) ?? {};
            const queryArgs = plain(ctx.query) ?? {};
            const active = text((session.session as { activeOrganizationId?: unknown }).activeOrganizationId);
            let targets: (string | null)[];
            if (ctx.path.startsWith("/api-key/")) {
              targets = [text(plain(body.metadata)?.organizationId) ?? active];
            } else {
              // a workspace may be named by id or by slug (set-active, get-full-organization, ...): both are checked
              const slug = text(body.organizationSlug) ?? text(queryArgs.organizationSlug);
              const bySlug = slug ? ((await query<{ id: string }>(`SELECT id FROM organization WHERE slug = $1::text`, [slug]))[0]?.id ?? null) : null;
              const byId = text(body.organizationId) ?? text(queryArgs.organizationId);
              targets = byId || bySlug ? [byId, bySlug] : [active];
            }
            for (const orgId of new Set(targets)) {
              if (orgId && !(await ssoAllows(query, orgId, session.user.id, session.session.id))) {
                throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED" });
              }
            }
            // a key may be pinned only to a workspace the caller belongs to: a former member cannot prepare a key that
            // would start working again after a re-invitation
            const pin = ctx.path.startsWith("/api-key/") ? text(plain(body.metadata)?.organizationId) : null;
            if (pin && !(await query(`SELECT 1 AS one FROM member WHERE organization_id = $1::text AND user_id = $2::text`, [pin, session.user.id])).length) {
              throw new APIError("FORBIDDEN", { message: "Not a member of this workspace", code: "NOT_A_MEMBER" });
            }
          }
        }
        // LAST step for a removal or leave, after every guard above has passed (a call they refuse records nothing):
        // the removal is recorded BEFORE the membership ends, so the block can never be missing; when it cannot be
        // written, the removal itself is refused (fail closed). If the call then fails, the after-hook deletes the rows
        // again, and a block whose person is still a member never counts (sso-store.ts removedFrom).
        if (MEMBERSHIP_ENDING_PATHS.has(ctx.path)) {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          if (session) {
            const body = plain(ctx.body) ?? {};
            const orgId = text(body.organizationId) ?? text((session.session as { activeOrganizationId?: unknown }).activeOrganizationId);
            let userId: string | null = null;
            if (orgId && ctx.path === "/organization/leave") userId = session.user.id;
            if (orgId && ctx.path === "/organization/remove-member" && text(body.memberIdOrEmail)) {
              const [m] = await query<{ user_id: string }>(
                `SELECT m.user_id FROM member m JOIN "user" u ON u.id = m.user_id WHERE m.organization_id = $1::text AND (m.id = $2::text OR lower(u.email) = lower($2::text)) LIMIT 1`,
                [orgId, body.memberIdOrEmail],
              );
              userId = m?.user_id ?? null;
            }
            if (orgId && userId) {
              try {
                removalNote = { orgId, userId, ids: await recordRemoval(query, orgId, userId) };
              } catch {
                console.error("sso removal could not be recorded; private diagnostics suppressed");
                throw new APIError("INTERNAL_SERVER_ERROR", { message: "The removal could not be recorded. Nothing was changed; try again." });
              }
            }
          }
        }
        if (ctx.path === "/oauth2/authorize" || ctx.path === "/oauth2/token") {
          await repo.ensureOAuthResource(mcpResource(env), "Montral MCP", MCP_RESOURCE_SCOPES);
          // clients repeat the original scope (including offline_access) on refresh, and the library rejects any scope
          // the grant does not hold. Grants issued before the resource allowed offline_access never stored it, so
          // for those it is dropped (it only means "issue a refresh token" and cannot widen access).
          const body = ctx.body as Record<string, unknown> | undefined;
          if (ctx.path === "/oauth2/token" && body?.grant_type === "refresh_token" && typeof body.scope === "string" && typeof body.refresh_token === "string") {
            const asked = body.scope.split(/\s+/).filter(Boolean);
            if (asked.includes("offline_access")) {
              const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.refresh_token)));
              const stored = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
              const rows = await database.query<{ scopes: string }>("select array_to_string(scopes, ' ') as scopes from oauth_refresh_token where token = $1", [stored]);
              const held = rows[0] ? String(rows[0].scopes).split(" ").filter(Boolean) : undefined;
              const kept = asked.filter((x) => x !== "offline_access");
              if (held && (!held.includes("offline_access") || !kept.length)) {
                return { context: { ...ctx, body: { ...body, scope: (kept.length ? kept : held).join(" ") } } };
              }
            }
          }
          return;
        }
        const body = ctx.body as { application_type?: string; redirect_uris?: unknown } | undefined;
        if (ctx.path !== "/oauth2/register" || !body || body.application_type || !Array.isArray(body.redirect_uris)) return;
        const native = body.redirect_uris.every((u) => {
          try {
            const url = new URL(String(u));
            return url.protocol === "http:" ? ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) : url.protocol !== "https:";
          } catch {
            return false;
          }
        });
        if (native) return { context: { ...ctx, body: { ...body, application_type: "native" } } };
      }),
      // workspace audit log for the member, invitation, workspace and API-key endpoints (audit-auth.ts); never fails the call
      after: createAuthMiddleware(async (ctx) => {
        const returned = plain(ctx.context.returned);
        // an API key made from an SSO session keeps working in a require-SSO workspace of that connection (agent tokens
        // need no record: they carry the session that authorized them)
        if (ctx.path === "/api-key/create" && returned && text(returned.id)) {
          try {
            const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
            const connection = session ? await sessionConnection(query, session.session.id) : null;
            if (connection) await recordSsoCredential(query, "api_key", returned.id as string, connection);
          } catch {
            console.error("sso credential could not be recorded; private diagnostics suppressed");
          }
        }
        // Someone left or was removed. The removal was remembered before the call (address and SSO identities), so
        // provisioning cannot bring them back even after they delete their account; their SSO links to the workspace
        // go; and someone removed from a workspace with SSO is signed out everywhere. Accepting a new invitation to the
        // address lifts the block. If the call failed, the rows recorded for it are deleted again.
        // the call failed (or the person is somehow still a member): the block recorded for it goes again
        if (MEMBERSHIP_ENDING_PATHS.has(ctx.path) && removalNote && (!returned || (await repo.isMember(removalNote.userId, removalNote.orgId).catch(() => false)))) {
          await query(`DELETE FROM sso_removal WHERE id = ANY (string_to_array($1::text, ',')::uuid[])`, [removalNote.ids.join(",")])
            .catch(() => console.error("sso removal could not be withdrawn; private diagnostics suppressed"));
        }
        // the workspace switcher's list leaves out require-SSO workspaces this session does not qualify for (like
        // GET /api/workspaces)
        if (ctx.path === "/organization/list" && Array.isArray(ctx.context.returned)) {
          const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
          if (session) {
            const all = ctx.context.returned as { id?: unknown }[];
            const keep = await Promise.all(all.map((o) => (typeof o?.id === "string" ? ssoAllows(query, o.id, session.user.id, session.session.id) : Promise.resolve(true))));
            if (keep.includes(false)) return ctx.json(all.filter((_, i) => keep[i]));
          }
        }
        if (MEMBERSHIP_ENDING_PATHS.has(ctx.path) && returned) {
          const gone = ctx.path === "/organization/remove-member" ? plain(returned.member) : returned;
          const orgId = text(gone?.organizationId);
          const userId = text(gone?.userId) ?? (ctx.path === "/organization/leave" ? (memberNote?.userId ?? null) : null);
          if (orgId && userId) {
            // keys pinned to the workspace end with the membership (on their own: an SSO bookkeeping failure must not keep them)
            await revokeKeysPinnedTo(query, orgId, userId).catch(() => console.error("api keys of a former member could not be revoked; private diagnostics suppressed"));
            try {
              // normally recorded before the call; a removal the before-hook could not attribute is recorded now
              if (!(removalNote && removalNote.orgId === orgId && removalNote.userId === userId)) await recordRemoval(query, orgId, userId);
              await dropSsoLinksOfFormerMember(query, orgId, userId);
              // in a workspace with single sign-on, a removed member is signed out everywhere (elsewhere the membership
              // check of every request already shuts them out of the workspace, and their other sessions stay)
              if (ctx.path === "/organization/remove-member") {
                await query(`DELETE FROM session WHERE user_id = $1::text AND EXISTS (SELECT 1 FROM sso_connection WHERE organization_id = $2::text)`, [userId, orgId]);
              }
            } catch {
              console.error("sso removal could not be recorded; private diagnostics suppressed");
            }
          }
        }
        // only an ACCEPTED invitation lifts a removal block; a pending, cancelled or expired one does not
        if (ctx.path === "/organization/accept-invitation" && returned) {
          const inv = plain(returned.invitation);
          if (text(inv?.organizationId) && text(inv?.email)) {
            await clearRemoval(query, inv!.organizationId as string, inv!.email as string).catch(() => console.error("sso removal could not be cleared; private diagnostics suppressed"));
          }
        }
        if (!AUDITED_AUTH_PATHS.has(ctx.path)) return;
        const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
        await auditAuthCall(query, env, { path: ctx.path, body: ctx.body, returned: ctx.context.returned, headers: ctx.headers, session: session as never }, keyNote, memberNote);
      }),
    },
    plugins: [
      // single sign-on with OpenID Connect: per-workspace connections and the operator's OIDC_* provider (sso-*.ts)
      ssoPlugin(database, env, ssoSignIn),
      // Native handoff: the app signs in with GitHub inside ASWebAuthenticationSession, whose cookies the app cannot
      // read. A short-lived single-use token is appended to the montral://auth redirect and exchanged for the
      // cookie session at POST /api/auth/one-time-token/verify. Only the handoff below mints tokens: the plugin's
      // own generate endpoint is closed to clients, and tokens are stored hashed.
      oneTimeToken({
        expiresIn: HANDOFF_TTL_MINUTES,
        disableClientRequest: true,
        storeToken: { type: "custom-hasher", hash: sha256Hex },
      }),
      {
        id: "native-handoff",
        hooks: {
          after: [
            {
              matcher: (c) => c.path === "/callback/:id",
              handler: createAuthMiddleware(async (ctx) => {
                const location = ctx.context.responseHeaders?.get("location");
                const created = ctx.context.newSession;
                if (!isNativeCallback(location) || !created) return;
                const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
                await ctx.context.internalAdapter.createVerificationValue({
                  value: created.session.token,
                  identifier: `one-time-token:${await sha256Hex(token)}`,
                  expiresAt: new Date(Date.now() + HANDOFF_TTL_MINUTES * 60_000),
                });
                const url = new URL(location!);
                url.searchParams.set("token", token);
                ctx.setHeader("location", url.toString());
              }),
            },
          ],
        },
      },
      organization({
        invitationExpiresIn: Math.round(inviteTtlDays(env) * 86400),
        organizationHooks: {
          // the workspace owner is the one account that cannot be taken out of it
          beforeRemoveMember: async ({ member }) => {
            if (member.role === "owner") throw new APIError("BAD_REQUEST", { message: "The workspace owner cannot be removed" });
          },
        },
        sendInvitationEmail: async ({ email, id, organization: org, inviter, invitation }) => {
          const expires = (invitation as { expiresAt?: Date | string } | undefined)?.expiresAt;
          const expiresAt = expires ? new Date(expires) : new Date(Date.now() + inviteTtlDays(env) * 864e5);
          const until = expiresAt.toISOString().slice(0, 10);
          // the invitee's own setting if they already have an account, else the inviter's
          const lang = await userLang(repo, email, await userLang(repo, inviter.user.email));
          const who = inviter.user.name || inviter.user.email;
          const mail = actionEmail({
            title: tr(lang, "Join {org} on Montral", { org: org.name }),
            body: tr(lang, "{who} invited you to collaborate on {org}. You'll be able to see its monitors, incidents and status pages.", { who, org: org.name }),
            rows: [[tr(lang, "Workspace"), org.name], [tr(lang, "Invited by"), who], [tr(lang, "Valid until"), until]],
            footer: tr(lang, "Not expecting this? Ignore this email and the invitation expires on its own."),
            cta: tr(lang, "Accept invitation"),
            url: `${env.WEB_ORIGIN}/accept-invite/${id}`,
            lang,
          });
          await sendEmail({ to: email, subject: tr(lang, "Join {org} on Montral", { org: org.name }), fromName: "Montral", ...mail });
        },
      }),
      ...(turnstile(env) ? [captcha({ provider: "cloudflare-turnstile", secretKey: turnstile(env)!.secretKey, endpoints: ["/sign-up/email"] })] : []),
      // the plugin's default allows 10 requests per key per day; the REST API has no per-key quota
      apiKey({ enableMetadata: true, defaultPrefix: "montral_", rateLimit: { enabled: false } }),
      twoFactor({ issuer: "Montral" }),
      // only the OAuth provider signs tokens; do not mint a JWT (and touch the keys table) on every session read
      jwt({ disableSettingJwtHeader: true }),
      // lets agents (MCP clients) register themselves and ask the user for access: OAuth 2.1 with PKCE
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        scopes: [...OAUTH_SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["mcp:read", "mcp:write"],
        clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
        // the auth object is rebuilt per request, so no boot-time resource seeding: any client may ask for any resource
        enforcePerClientResources: false,
        // which workspace, and which of its projects, the agent acts in: what the user picked while authorizing
        postLogin: {
          page: "/oauth/workspace",
          // the picker page sets a short-lived cookie once the user chose (the library has no other "done" signal);
          // it is only ever narrowed to workspaces and projects the user belongs to (see consentReferenceId)
          shouldRedirect: async ({ user, headers }) => {
            if (picked) return false;
            // always ask, even with a single workspace and project: the user sees exactly what the agent is given
            return (await repo.workspacesOf(user.id)).length > 0;
          },
          consentReferenceId: async ({ user, session }) => {
            if (picked) {
              const want = parseGrant(picked);
              if (want === "all") return (await repo.workspacesOf(user.id)).length ? "*" : undefined;
              const out = new Map<string, string>();
              for (const { org, ids } of want) {
                if (out.has(org) || !(await repo.isMember(user.id, org))) continue;
                if (!ids) { out.set(org, org); continue; }
                const own = new Set((await repo.listProjects(org, null)).map((p) => p.id));
                const keep = [...new Set(ids)].filter((id) => UUID.test(id) && own.has(id));
                if (keep.length) out.set(org, keep.length === own.size ? org : `${org}|${keep.join(",")}`);
              }
              if (!out.size) throw new APIError("BAD_REQUEST", { message: "Pick at least one project" });
              return [...out.values()].join(";");
            }
            const active = (session as { activeOrganizationId?: string | null }).activeOrganizationId;
            if (active && (await repo.isMember(user.id, active))) return active;
            return (await repo.anyWorkspaceOf(user.id)) ?? undefined;
          },
        },
        customAccessTokenClaims: ({ referenceId }) => {
          const g = parseGrant(referenceId ?? "");
          if (g === "all") return { all_workspaces: true };
          // `org` stays for clients holding tokens from before agents could be given several workspaces
          return { org: g[0]?.org, workspaces: g.map((e) => (e.ids ? { id: e.org, projects: e.ids } : { id: e.org })) };
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // covers every way an account comes to exist: the sign-up form and a first GitHub sign-in alike
          before: async (user) => {
            if (signupDisabled(env) && !(await repo.hasPendingInvitation(user.email))) {
              throw new APIError("FORBIDDEN", { message: "Sign-ups are closed on this instance. Ask a workspace owner to invite you." });
            }
          },
          // every new user gets a personal workspace they own
          after: async (user) => {
            await givePersonalWorkspace(database, user);
          },
        },
      },
      account: {
        create: {
          // Pre-registration takeover: email sign-up needs no verification, so someone can register a victim's email
          // with a password they know. When the victim then signs in with GitHub (verified email), the provider is
          // matched to that unverified user. Everything created while the address was unproven is removed first, so
          // only the proven owner holds the account afterwards. A signed-in user linking GitHub to their own account
          // is not this case and keeps what they have.
          before: async (account, ctx) => {
            // A social sign-in never links itself to an account protected by SSO (an SSO identity, or membership of a
            // require-SSO workspace) because the emails match: its holder connects it from Account while signed in.
            if (account.providerId !== "credential" && !account.providerId.startsWith("sso:")) {
              const session = ctx ? await getSessionFromCtx(ctx).catch(() => null) : null;
              if (session?.user.id !== account.userId && (await ssoProtected(query, account.userId))) {
                throw new APIError("FORBIDDEN", { message: "Sign in to this account first, then connect it from Account settings", code: "LINK_REQUIRES_SESSION" });
              }
            }
            if (account.providerId !== "github") return;
            const rows = await database.query<{ email_verified: boolean }>(`select email_verified from "user" where id = $1`, [account.userId]);
            if (!rows[0] || rows[0].email_verified) return;
            const session = ctx ? await getSessionFromCtx(ctx).catch(() => null) : null;
            if (session?.user.id === account.userId) return;
            await purgeUnverifiedSecrets(database, account.userId);
          },
        },
      },
      session: {
        create: {
          // Every way a session comes to exist (password, GitHub, 2FA, email verification, SSO) passes here. A member
          // (not the owner, who is the break-glass account) of a workspace that requires single sign-on only gets one
          // from that workspace's own SSO connection.
          // Then: keep the workspace of their previous session, else the one they joined most recently (an accepted
          // invitation wins over the personal one); an SSO sign-in lands in the workspace of its connection.
          before: async (session) => {
            const required = await ssoRequiredFor(query, session.userId);
            if (required.length && !required.some((r) => r.connectionId === ssoSignIn.connectionId)) {
              throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED" });
            }
            const viaSso = ssoSignIn.orgId && (await repo.isMember(session.userId, ssoSignIn.orgId)) ? ssoSignIn.orgId : null;
            const orgId = viaSso ?? (await repo.preferredWorkspace(session.userId));
            return { data: { ...session, activeOrganizationId: orgId } };
          },
        },
      },
    },
  });
}
