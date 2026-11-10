import type { Database } from "@montral/repo";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { auditChanges, recordAuditEvent, type Query } from "./audit";
import type { Bindings } from "./env";
import { clientIpFromHeaders } from "./ratelimit";
import { authorizationUrl, discover, emailDomain, exchangeCode, randomToken, sha256b64url, SsoError, verifyIdToken, type VerifiedIdentity } from "./sso-oidc";
import { SecretUnreadable } from "./sso-secret";
import {
  accountIdOf, connectionById, connectionForStart, consumeFlow, createFlow, linkIdentity, removedFrom, markSsoSession, provisionUser,
  userByEmail, userByIdentity, userById, type SsoConnection,
} from "./sso-store";

/**
 * The sign-in endpoints of single sign-on, as a Better Auth plugin so a successful sign-in gets an ordinary Montral
 * session (same cookie, same expiry, same hooks):
 *
 * - POST /api/auth/sso/start  { email? | workspace?, intent?: "signin" | "link", returnTo? } -> { url }
 * - GET  /api/auth/sso/callback?code&state  (the redirect URI registered at the identity provider)
 *
 * Linking policy (see docs/evidence/2026-11-10-oidc-sso.md): an SSO identity signs in the user it is linked to. A new
 * identity whose verified email belongs to nobody provisions a new user. A new identity whose email already belongs to
 * a Montral user is refused: that user must sign in the usual way first and link SSO from Account settings, which
 * proves they hold the Montral account. An email match alone never links.
 */

/**
 * Holds the binding secret of the browser that started a sign-in; the state is only valid together with it. Over https
 * it is a __Host- cookie, which a sibling subdomain cannot set (no cookie tossing a binding into a victim's browser).
 */
export const flowCookie = (secure: boolean) => (secure ? { name: "__Host-montral_sso_flow", path: "/" } : { name: "montral_sso_flow", path: "/api/auth/sso" });
/** The redirect URI: fixed to this instance's own origin, never taken from a request. */
export const ssoCallbackUrl = (env: Pick<Bindings, "BETTER_AUTH_URL">) => `${new URL(env.BETTER_AUTH_URL).origin}/api/auth/sso/callback`;

/** What the current request's sign-in is (shared with the session hook in auth.ts; the auth object lives per request). */
export type SsoSignIn = { connectionId: string | null; orgId: string | null };

/** The discovery document names another token endpoint than the one the client secret was entered for. */
class TokenEndpointMoved extends Error {}

/** Relative path inside the web app; anything else becomes /app. */
export function safeReturnTo(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return s.length <= 500 && /^\/(?![/\\])[^\s\\]*$/.test(s) ? s : "/app";
}

/** Error codes the web app turns into a message (login page, or Account for a link). Never details of the failure. */
export type SsoFailure =
  | "invalid_state" | "idp_error" | "invalid_id_token" | "connection_disabled" | "connection_misconfigured" | "email_not_verified"
  | "domain_not_allowed" | "link_required" | "link_email_mismatch" | "identity_in_use" | "signup_closed" | "sso_required" | "access_removed";

export function ssoPlugin(database: Database, env: Bindings, signIn: SsoSignIn) {
  const q: Query = (sql, params) => database.query(sql, params);
  const secure = env.BETTER_AUTH_URL.startsWith("https://");
  const cookie = flowCookie(secure);

  async function refusal(conn: SsoConnection, reason: string, headers: Headers | undefined) {
    if (!conn.orgId) return;
    try {
      await recordAuditEvent(q, {
        orgId: conn.orgId, projectId: null, actor: { type: "system", id: null, label: "single sign-on" }, action: "sso.sign_in_refused",
        targetType: "sso_connection", targetId: conn.id, changes: auditChanges({}, { reason }), ip: clientIpFromHeaders((n) => headers?.get(n), env),
      });
    } catch {
      console.error("audit event could not be recorded; private diagnostics suppressed");
    }
  }

  return {
    id: "montral-sso",
    endpoints: {
      ssoStart: createAuthEndpoint(
        "/sso/start",
        {
          method: "POST",
          body: z.object({
            email: z.string().max(254).optional(),
            workspace: z.string().max(100).optional(),
            intent: z.enum(["signin", "link"]).optional(),
            returnTo: z.string().max(500).optional(),
          }),
        },
        async (ctx) => {
          const intent = ctx.body.intent ?? "signin";
          let email = ctx.body.email?.trim().toLowerCase() || null;
          let linkUserId: string | null = null;
          if (intent === "link") {
            const session = await getSessionFromCtx(ctx).catch(() => null);
            if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in first, then link single sign-on" });
            linkUserId = session.user.id;
            email = session.user.email.toLowerCase();
          }
          const conn = await connectionForStart(q, env, { email, workspace: intent === "link" ? null : ctx.body.workspace?.trim() || null });
          if (!conn) throw new APIError("NOT_FOUND", { message: "No single sign-on is set up for that email domain or workspace", code: "SSO_NOT_CONFIGURED" });
          let discovery;
          try {
            discovery = await discover(conn.issuer);
          } catch (e) {
            console.error(`SSO discovery failed (${e instanceof SsoError ? e.code : "unknown"}); private diagnostics suppressed`);
            throw new APIError("BAD_GATEWAY", { message: "The identity provider could not be reached. Try again later.", code: "SSO_IDP_UNAVAILABLE" });
          }
          const state = randomToken();
          const nonce = randomToken();
          const codeVerifier = randomToken();
          // one binding per browser, reused by parallel sign-ins (two tabs), so starting a second does not void the first
          const held = ctx.getCookie(cookie.name);
          const binding = held && /^[A-Za-z0-9_-]{43}$/.test(held) ? held : randomToken();
          await createFlow(q, {
            stateHash: await sha256b64url(state), bindingHash: await sha256b64url(binding), connectionId: conn.id, orgId: conn.orgId,
            nonce, codeVerifier, intent, linkUserId, returnTo: safeReturnTo(ctx.body.returnTo),
          });
          ctx.setCookie(cookie.name, binding, { httpOnly: true, secure, sameSite: "lax", path: cookie.path, maxAge: 600 });
          const url = authorizationUrl(discovery, { clientId: conn.clientId, redirectUri: ssoCallbackUrl(env), state, nonce, codeChallenge: await sha256b64url(codeVerifier), loginHint: email });
          return ctx.json({ url });
        },
      ),

      ssoCallback: createAuthEndpoint(
        "/sso/callback",
        {
          method: "GET",
          query: z.object({ code: z.string().max(4096).optional(), state: z.string().max(512).optional(), error: z.string().max(200).optional(), iss: z.string().max(500).optional() }),
        },
        async (ctx) => {
          let toAccount = false;
          const fail = (code: SsoFailure): never => {
            throw ctx.redirect(`${env.WEB_ORIGIN}${toAccount ? "/app/account" : "/login"}?sso_error=${code}`);
          };
          const { code, state, error, iss } = ctx.query;
          const binding = ctx.getCookie(cookie.name);
          if (!state || !binding) return fail("invalid_state");
          const flow = await consumeFlow(q, await sha256b64url(state), await sha256b64url(binding));
          if (!flow) return fail("invalid_state");
          toAccount = flow.intent === "link";
          if (error || !code) return fail("idp_error");

          const conn = await connectionById(q, env, flow.connection_id);
          // the connection may have been switched off, deleted or moved since the sign-in started
          if (!conn || !conn.enabled || conn.orgId !== flow.organization_id) return fail("connection_disabled");

          let identity: VerifiedIdentity;
          try {
            const discovery = await discover(conn.issuer);
            // RFC 9207: a provider that names itself in the response must be the one this sign-in went to
            if (iss !== undefined && iss !== discovery.issuer) throw new SsoError("invalid_id_token", "issuer mix-up");
            // the client secret only goes to the token endpoint it was entered for; a moved endpoint needs the owner
            if (conn.orgId && discovery.tokenEndpoint !== conn.tokenEndpoint) throw new TokenEndpointMoved();
            const idToken = await exchangeCode(discovery, { clientId: conn.clientId, clientSecret: await conn.secret(), code, redirectUri: ssoCallbackUrl(env), codeVerifier: flow.code_verifier });
            identity = await verifyIdToken(idToken, { discovery, clientId: conn.clientId, nonce: flow.nonce });
          } catch (e) {
            const why = e instanceof SsoError ? e.code : e instanceof SecretUnreadable ? "secret_unreadable" : e instanceof TokenEndpointMoved ? "token_endpoint_moved" : "unknown";
            console.error(`SSO sign-in refused (${why}); private diagnostics suppressed`);
            return fail(e instanceof SecretUnreadable || e instanceof TokenEndpointMoved ? "connection_misconfigured" : e instanceof SsoError && e.code === "invalid_id_token" ? "invalid_id_token" : "idp_error");
          }

          // only an address the provider itself verified, in a domain this connection may use, ever names an account
          if (!identity.email || !identity.emailVerified) {
            await refusal(conn, "email_not_verified", ctx.headers);
            return fail("email_not_verified");
          }
          if (conn.domains !== null && !conn.domains.includes(emailDomain(identity.email))) {
            await refusal(conn, "domain_not_allowed", ctx.headers);
            return fail("domain_not_allowed");
          }

          let userId = await userByIdentity(q, conn.id, identity.issuer, identity.subject);
          let how: "existing" | "provisioned" | "linked";
          if (flow.intent === "link") {
            const me = flow.link_user_id ? await userById(q, flow.link_user_id) : null;
            if (!me) return fail("invalid_state");
            if (userId && userId !== me.id) return fail("identity_in_use");
            if (me.email.toLowerCase() !== identity.email) return fail("link_email_mismatch");
            if (!userId) {
              try {
                await linkIdentity(q, { userId: me.id, connectionId: conn.id, issuer: identity.issuer, subject: identity.subject });
              } catch {
                return fail("identity_in_use"); // linked to someone else in a concurrent request (unique index)
              }
            }
            userId = me.id;
            how = "linked";
          } else if (userId) {
            how = "existing";
          } else {
            if (await userByEmail(q, identity.email)) {
              await refusal(conn, "link_required", ctx.headers);
              return fail("link_required");
            }
            // someone removed from the workspace (by address or by this identity) is not provisioned back into it, even
            // with a new account, until the address is invited again
            if (conn.orgId && (await removedFrom(q, conn.orgId, identity.email, accountIdOf(identity.issuer, identity.subject)))) {
              await refusal(conn, "removed", ctx.headers);
              return fail("access_removed");
            }
            // the operator's provider follows DISABLE_SIGNUP; a workspace's own provider provisions into that workspace only
            if (!conn.orgId && ["true", "1"].includes(String(env.DISABLE_SIGNUP ?? "").trim().toLowerCase()) && !(await database.repo.hasPendingInvitation(identity.email))) return fail("signup_closed");
            const name = identity.name ?? identity.email.split("@")[0];
            try {
              userId = await provisionUser(q, { email: identity.email, name, connectionId: conn.id, issuer: identity.issuer, subject: identity.subject, orgId: conn.orgId, role: conn.defaultRole });
            } catch {
              userId = null;
            }
            // a concurrent sign-in of the same person created it first: theirs is the account (or the address was taken)
            userId ??= await userByIdentity(q, conn.id, identity.issuer, identity.subject);
            if (!userId) return fail("link_required");
            if (!conn.orgId) {
              const ws = `${name}'s workspace`;
              const slug = (ws.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace") + "-" + Math.random().toString(36).slice(2, 6);
              if (!(await database.repo.anyWorkspaceOf(userId))) await database.repo.createPersonalWorkspace({ id: crypto.randomUUID(), name: ws, slug, ownerId: userId });
            }
            how = "provisioned";
          }
          // Membership comes only with first-time provisioning (a person new to Montral). Linking never adds anyone to the
          // workspace (an invitation does), and a removed member's links are deleted with the membership, so SSO never
          // brings back someone who was removed.

          signIn.connectionId = conn.id;
          signIn.orgId = conn.orgId;
          let session;
          try {
            session = await ctx.context.internalAdapter.createSession(userId);
          } catch {
            return fail("sso_required"); // another workspace of this user requires its own SSO
          } finally {
            signIn.connectionId = null;
            signIn.orgId = null;
          }
          await markSsoSession(q, session.id, conn.id);
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) return fail("invalid_state");
          await setSessionCookie(ctx, { session, user });

          if (conn.orgId) {
            try {
              await recordAuditEvent(q, {
                orgId: conn.orgId, projectId: null, actor: { type: "user", id: userId, userId }, action: "sso.sign_in", targetType: "sso_connection",
                targetId: conn.id, changes: auditChanges({}, { type: how }), ip: clientIpFromHeaders((n) => ctx.headers?.get(n), env), requireMember: userId,
              });
            } catch {
              console.error("audit event could not be recorded; private diagnostics suppressed");
            }
          }
          throw ctx.redirect(`${env.WEB_ORIGIN}${toAccount ? "/app/account?sso=linked" : flow.return_to}`);
        },
      ),
    },
  };
}
