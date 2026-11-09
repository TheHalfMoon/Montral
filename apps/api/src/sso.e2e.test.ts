import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { SyntheticIdp, type IdpUser, type Tweak } from "../test/synthetic-idp";
import { createApp } from "./app";
import { setTxtResolver } from "./custom-domain";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { createHash, randomBytes } from "node:crypto";
import { createAuth } from "./auth";
import { recheckSsoDomains } from "./sso-domains";
import { setSsoOptionsForTests } from "./sso-oidc";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-sso-e2e-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
  // the synthetic identity providers listen on 127.0.0.1 over plain http
  SSO_ALLOW_PRIVATE_IDP: "true",
};

/** A browser: keeps the cookies the server sets, sends them back. */
class Jar {
  private m = new Map<string, string>();
  take(h: Headers) {
    for (const sc of h.getSetCookie()) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (!value || /max-age=0/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) this.m.delete(name);
      else this.m.set(name, value);
    }
  }
  has = (name: string) => this.m.has(name);
  header = () => [...this.m].map(([k, v]) => `${k}=${v}`).join("; ");
}
type Res = { status: number; body: any; text: string; headers: Headers; location: string | null };

/**
 * Single sign-on end to end on real PostgreSQL, against two synthetic in-process OpenID Connect providers: owner
 * configuration, DNS domain verification, just-in-time provisioning, the linking policy for existing accounts, every
 * refusal (unverified email, foreign domain, bad id_tokens, replayed state and nonce, another browser's state,
 * cross-tenant tokens, a disabled connection), "require SSO" with the owner's break-glass sign-in, the audit trail,
 * and that client secrets never appear in responses, the audit log or logs.
 */
describe.skipIf(!url)("single sign-on with OpenID Connect (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 4 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  const q = <T,>(sql: string, params?: unknown[]) => database!.query<T>(sql, params);
  const logged: string[] = [];
  // published TXT records: a name may hold several values (two workspaces publishing for the same domain)
  const txt = new Map<string, string[]>();
  const publish = (name: string, value: string) => txt.set(name, [...(txt.get(name) ?? []), value]);
  let idpA: SyntheticIdp;
  let idpB: SyntheticIdp;
  const rand = crypto.randomUUID().slice(0, 8);
  const domainA = `corp-a-${rand}.test`;
  const domainB = `corp-b-${rand}.test`;

  async function call(path: string, init: { method?: string; body?: unknown; jar?: Jar; key?: string; env?: object } = {}): Promise<Res> {
    const headers: Record<string, string> = { origin };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const cookie = init.jar?.header();
    if (cookie) headers.cookie = cookie;
    if (init.key) headers["x-api-key"] = init.key;
    const r = await app.fetch(new Request(origin + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), (init.env ?? env) as never);
    init.jar?.take(r.headers);
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* redirects have no body */ }
    return { status: r.status, body, text, headers: r.headers, location: r.headers.get("location") };
  }

  async function signUp(name: string, email = `sso-${name}-${crypto.randomUUID().slice(0, 8)}@example.com`) {
    const jar = new Jar();
    const r = await call("/api/auth/sign-up/email", { method: "POST", body: { email, name, password: "correct horse battery staple" } });
    expect(r.status).toBe(200);
    await q(`update "user" set email_verified = true where id = $1`, [r.body.user.id]);
    expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: "correct horse battery staple" }, jar })).status).toBe(200);
    const me = await call("/api/me", { jar });
    return { email, id: r.body.user.id as string, jar, orgId: me.body.organization.id as string };
  }
  const passwordSignIn = (email: string, jar = new Jar()) => call("/api/auth/sign-in/email", { method: "POST", body: { email, password: "correct horse battery staple" }, jar });

  /** Configures SSO for the owner's workspace and verifies `domain` through (stubbed) DNS. */
  async function configure(owner: Awaited<ReturnType<typeof signUp>>, idp: SyntheticIdp, domain: string) {
    const put = await call("/api/sso", { method: "PUT", jar: owner.jar, body: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, domains: [domain], defaultRole: "member" } });
    expect(put.status, put.text).toBe(201);
    const d = put.body.connection.domains.find((x: any) => x.domain === domain);
    expect(d).toMatchObject({ verified: false, txtName: `_montral-challenge.${domain}` });
    publish(d.txtName, d.txtValue);
    const v = await call(`/api/sso/domains/${domain}/verify`, { method: "POST", jar: owner.jar });
    expect(v.status, v.text).toBe(200);
    return put.body.connection.id as string;
  }

  /** One SSO sign-in in `jar`: start, the provider signs `user` in, then the callback. */
  async function sso(idp: SyntheticIdp, jar: Jar, start: Record<string, unknown>, user: IdpUser, tweak: Tweak = {}, withEnv?: object) {
    const s = await call("/api/auth/sso/start", { method: "POST", body: start, jar, env: withEnv });
    expect(s.status, s.text).toBe(200);
    const { callback, params } = idp.authorize(s.body.url, user, tweak);
    const cb = new URL(callback);
    const res = await call(cb.pathname + cb.search, { jar, env: withEnv });
    expect(res.status).toBe(302);
    return { location: res.location ?? "", callback: cb.pathname + cb.search, params };
  }
  const failure = (location: string) => new URL(location).searchParams.get("sso_error");
  const auditOf = (orgId: string) => q<{ action: string; actor_type: string; actor_id: string | null; target_id: string | null; changes: any }>("SELECT action, actor_type, actor_id, target_id, changes FROM audit_event WHERE organization_id = $1 ORDER BY created_at, id", [orgId]);
  /** The owner invites `email` into their workspace and the invitee (signed in with `jar`) accepts. */
  async function join(owner: { jar: Jar; orgId: string }, email: string, jar: Jar, role = "member") {
    const inv = await call("/api/auth/organization/invite-member", { method: "POST", jar: owner.jar, body: { organizationId: owner.orgId, email, role } });
    expect(inv.status, inv.text).toBe(200);
    const acc = await call("/api/auth/organization/accept-invitation", { method: "POST", jar, body: { invitationId: inv.body.id } });
    expect(acc.status, acc.text).toBe(200);
  }
  const isMember = async (orgId: string, userId: string) => (await q("SELECT 1 FROM member WHERE organization_id = $1 AND user_id = $2", [orgId, userId])).length > 0;

  /**
   * An agent authorization (OAuth with PKCE, as an MCP client gets one) for `orgId`, made with the session in `jar`.
   * Returns the access token, or the HTTP status of the step that refused.
   */
  async function agentToken(jar: Jar, orgId: string): Promise<{ token?: string; refused?: number }> {
    const redirect = "http://127.0.0.1:33333/callback";
    const reg = await call("/api/auth/oauth2/register", { method: "POST", body: { client_name: "SSO e2e agent", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] } });
    expect(reg.status, reg.text).toBeLessThan(300);
    const clientId = reg.body.client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const resource = `${origin}/api/mcp`;
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "mcp:read mcp:write", state: "s", code_challenge: challenge, code_challenge_method: "S256", resource });
    const picked = `montral_grant=${encodeURIComponent(`${challenge}~${orgId}`)}`;
    const raw = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const cookie = [jar.header(), picked].filter(Boolean).join("; ");
      const r = await app.fetch(new Request(origin + path, { method: init.method ?? "GET", redirect: "manual", headers: { origin, cookie, ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined }), env as never);
      jar.take(r.headers);
      const text = await r.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* redirect */ }
      return { status: r.status, body, location: r.headers.get("location") };
    };
    const auth = await raw(`/api/auth/oauth2/authorize?${query}`);
    if (auth.status >= 400) return { refused: auth.status };
    let loc: string = auth.location ?? auth.body?.url;
    if (loc.includes("/oauth/workspace")) {
      const c = await raw("/api/auth/oauth2/continue", { method: "POST", body: { postLogin: true, oauth_query: new URL(loc, origin).search.slice(1) } });
      if (c.status !== 200) return { refused: c.status };
      loc = c.body.redirect_uri ?? c.body.url;
    }
    if (!loc.startsWith(redirect)) {
      const consent = await raw("/api/auth/oauth2/consent", { method: "POST", body: { accept: true, oauth_query: new URL(loc, origin).search.slice(1) } });
      if (consent.status !== 200) return { refused: consent.status };
      loc = consent.body.redirect_uri ?? consent.body.url;
    }
    const code = new URL(loc).searchParams.get("code")!;
    const tok = await app.fetch(new Request(`${origin}/api/auth/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource }) }), env as never);
    expect(tok.status, await tok.clone().text()).toBe(200);
    return { token: ((await tok.json()) as { access_token: string }).access_token };
  }
  const asAgent = async (token: string, orgId: string) => (await app.fetch(new Request(`${origin}/api/monitors`, { headers: { authorization: `Bearer ${token}`, "x-workspace-id": orgId } }), env as never)).status;
  const asKey = async (key: string) => (await call("/api/monitors", { key })).status;

  const userIdOf = async (email: string) => (await q<{ id: string }>(`SELECT id FROM "user" WHERE lower(email) = $1`, [email.toLowerCase()]))[0]?.id ?? null;

  let ownerA: Awaited<ReturnType<typeof signUp>>;
  let ownerB: Awaited<ReturnType<typeof signUp>>;
  let connA = "";
  let connB = "";
  let apiKey = "";

  beforeAll(async () => {
    await migrateMontralSchema(database!, montralEdition);
    for (const level of ["error", "warn", "log", "info"] as const) {
      const original = console[level].bind(console);
      // captured for the "never logged" check, and still printed so a CI failure shows its (redacted) cause
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        original(...args);
      });
    }
    setTxtResolver(async (name) => (txt.has(name) ? txt.get(name)!.map((v) => [v]) : Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))));
    idpA = await SyntheticIdp.start("tenant-a");
    idpB = await SyntheticIdp.start("tenant-b");
    ownerA = await signUp("owner-a");
    ownerB = await signUp("owner-b");
    connA = await configure(ownerA, idpA, domainA);
    connB = await configure(ownerB, idpB, domainB);
    const key = await call("/api/auth/api-key/create", { method: "POST", jar: ownerA.jar, body: { name: "sso-e2e", metadata: { organizationId: ownerA.orgId } } });
    expect(key.status).toBe(200);
    apiKey = key.body.key;
  });
  afterAll(async () => {
    setTxtResolver(undefined);
    setSsoOptionsForTests(null);
    vi.restoreAllMocks();
    await idpA?.close();
    await idpB?.close();
    await database?.close(1);
  });

  it("lets only the owner, from a session, manage the connection; the client secret is never returned", async () => {
    const view = await call("/api/sso", { jar: ownerA.jar });
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("private, no-store");
    expect(view.body).toMatchObject({ callbackUrl: `${origin}/api/auth/sso/callback`, instanceProvider: false });
    expect(view.body.connection).toMatchObject({ id: connA, issuer: idpA.issuer, clientId: idpA.clientId, hasClientSecret: true, defaultRole: "member", requireSso: false, enabled: true });
    expect(view.body.connection.domains).toEqual([expect.objectContaining({ domain: domainA, verified: true })]);
    expect(view.text).not.toContain(idpA.clientSecret);
    const [row] = await q<{ client_secret_enc: string }>("SELECT client_secret_enc FROM sso_connection WHERE id = $1", [connA]);
    expect(row.client_secret_enc).toMatch(/^v1\./);
    expect(row.client_secret_enc).not.toContain(idpA.clientSecret);
    // an API key of the owner is not enough
    expect((await call("/api/sso", { key: apiKey })).status).toBe(403);
    // updating without a secret keeps the stored one
    const upd = await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpA.issuer, clientId: idpA.clientId, domains: [domainA], defaultRole: "member" } });
    expect(upd.status, upd.text).toBe(200);
    expect((await q<{ client_secret_enc: string }>("SELECT client_secret_enc FROM sso_connection WHERE id = $1", [connA]))[0].client_secret_enc).toBe(row.client_secret_enc);
    expect(upd.body.connection.domains[0].verified).toBe(true);
    // the stored secret never follows a change of issuer or client id
    const moved = await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpB.issuer, clientId: idpA.clientId, domains: [domainA] } });
    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe("secret_required");
    const otherClient = await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpA.issuer, clientId: "another-client", domains: [domainA] } });
    expect(otherClient.body.code).toBe("secret_required");
    expect((await q<{ issuer: string; client_id: string }>("SELECT issuer, client_id FROM sso_connection WHERE id = $1", [connA]))[0]).toEqual({ issuer: idpA.issuer, client_id: idpA.clientId });
    expect((await q<{ token_endpoint: string }>("SELECT token_endpoint FROM sso_connection WHERE id = $1", [connA]))[0].token_endpoint).toBe(`${idpA.issuer}/token`);
    // a second connection for the same workspace is the same row (PUT updates)
    expect((await q("SELECT 1 FROM sso_connection WHERE organization_id = $1", [ownerA.orgId])).length).toBe(1);
  });

  it("tests discovery, refusing private and plain-http providers without SSO_ALLOW_PRIVATE_IDP", async () => {
    const ok = await call("/api/sso/test", { method: "POST", jar: ownerA.jar, body: { issuer: idpA.issuer } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, issuer: idpA.issuer, tokenEndpoint: `${idpA.issuer}/token`, algorithms: ["RS256", "ES256"] });
    const closed = { ...env, SSO_ALLOW_PRIVATE_IDP: undefined };
    const http = await call("/api/sso/test", { method: "POST", jar: ownerA.jar, body: { issuer: idpA.issuer }, env: closed });
    expect(http.status).toBe(400);
    expect(http.body.code).toBe("invalid_issuer");
    const before = idpA.requests.length;
    const loop = await call("/api/sso/test", { method: "POST", jar: ownerA.jar, body: { issuer: idpA.issuer.replace("http://", "https://") }, env: closed });
    expect(loop.status).toBe(400);
    expect(loop.body.code).toBe("blocked_target");
    const meta = await call("/api/sso", { method: "PUT", jar: ownerB.jar, body: { issuer: "https://169.254.169.254/latest", clientId: "x", clientSecret: "y", domains: [] }, env: closed });
    expect(meta.status).toBe(400);
    expect(meta.body.code).toBe("blocked_target");
    expect(idpA.requests.length).toBe(before);
    // a broken provider is refused at save time
    const wrong = await call("/api/sso/test", { method: "POST", jar: ownerA.jar, body: { issuer: `${idpA.issuer}-nope` } });
    expect(wrong.status).toBe(400);
  });

  it("provisions a new person just in time into the connection's workspace, then signs the same identity in again", async () => {
    const email = `alice@${domainA}`;
    const jar = new Jar();
    const { location, params } = await sso(idpA, jar, { email, returnTo: "/app/monitors" }, { sub: "alice-sub", email, email_verified: true, name: "Alice" });
    expect(Object.fromEntries(params)).toMatchObject({ response_type: "code", code_challenge_method: "S256", redirect_uri: `${origin}/api/auth/sso/callback`, login_hint: email });
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location).toBe(`${origin}/app/monitors`);
    const me = await call("/api/me", { jar });
    expect(me.status).toBe(200);
    expect(me.body.organization.id).toBe(ownerA.orgId);
    const userId = me.body.userId as string;
    const [m] = await q<{ role: string }>("SELECT role FROM member WHERE organization_id = $1 AND user_id = $2", [ownerA.orgId, userId]);
    expect(m.role).toBe("member");
    expect((await q<{ email_verified: boolean }>(`SELECT email_verified FROM "user" WHERE id = $1`, [userId]))[0].email_verified).toBe(true);
    // provisioned only into its own workspace: no other membership, no personal workspace
    expect((await q("SELECT organization_id FROM member WHERE user_id = $1", [userId])).length).toBe(1);
    // a member cannot read or change the SSO settings
    expect((await call("/api/sso", { jar })).status).toBe(403);

    const again = new Jar();
    expect((await sso(idpA, again, { email }, { sub: "alice-sub", email, email_verified: true })).location).toBe(`${origin}/app`);
    expect((await call("/api/me", { jar: again })).body.userId).toBe(userId);
    expect((await q(`SELECT 1 FROM "user" WHERE lower(email) = $1`, [email])).length).toBe(1);
    const events = (await auditOf(ownerA.orgId)).filter((e) => e.action === "sso.sign_in" && e.actor_id === userId);
    expect(events.map((e) => e.changes.values.type)).toEqual(["provisioned", "existing"]);
    expect(events[0]).toMatchObject({ actor_type: "user", target_id: connA });
    // signing out ends the Montral session
    expect((await call("/api/auth/sign-out", { method: "POST", jar: again, body: {} })).status).toBe(200);
    expect((await call("/api/me", { jar: again })).status).toBe(401);
  });

  it("sends the client secret only to the token endpoint it was entered for", async () => {
    const email = `pinned@${domainA}`;
    const user = { sub: "pinned-sub", email, email_verified: true };
    idpA.discovery = { token_endpoint: `${idpA.issuer}/token-elsewhere` };
    setSsoOptionsForTests(null); // forget the cached discovery document
    const tokenCalls = idpA.requests.filter((r) => r.path.startsWith("/token")).length;
    expect(failure((await sso(idpA, new Jar(), { email }, user)).location)).toBe("connection_misconfigured");
    expect(idpA.requests.filter((r) => r.path.startsWith("/token")).length).toBe(tokenCalls); // nothing was sent
    idpA.discovery = {};
    setSsoOptionsForTests(null);
    expect((await sso(idpA, new Jar(), { email }, user)).location).toBe(`${origin}/app`);
  });

  it("starts by workspace slug too, and says so when nothing is configured", async () => {
    const [{ slug }] = await q<{ slug: string }>("SELECT slug FROM organization WHERE id = $1", [ownerA.orgId]);
    const s = await call("/api/auth/sso/start", { method: "POST", body: { workspace: slug } });
    expect(s.status).toBe(200);
    expect(s.body.url.startsWith(`${idpA.issuer}/authorize?`)).toBe(true);
    for (const body of [{ email: `x@unknown-${rand}.test` }, { workspace: `nope-${rand}` }, {}]) {
      const r = await call("/api/auth/sso/start", { method: "POST", body });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("SSO_NOT_CONFIGURED");
    }
  });

  it("never lets a social sign-in link itself to an SSO account because the email matches", async () => {
    const auth = createAuth(database!, env as never);
    const ctx = await auth.$context;
    const alice = (await userIdOf(`alice@${domainA}`))!;
    await expect(ctx.internalAdapter.linkAccount({ userId: alice, providerId: "github", accountId: `gh-${rand}-alice` })).rejects.toThrow();
    expect(await q("SELECT 1 FROM account WHERE user_id = $1 AND provider_id = 'github'", [alice])).toHaveLength(0);
    // an ordinary account (no SSO, no require-SSO workspace) is unchanged: verified-email linking still works there
    await expect(ctx.internalAdapter.linkAccount({ userId: ownerB.id, providerId: "github", accountId: `gh-${rand}-owner-b` })).resolves.toBeTruthy();
    await q("DELETE FROM account WHERE user_id = $1 AND provider_id = 'github'", [ownerB.id]);
  });

  it("makes removal from the workspace final: SSO neither re-adds nor signs the identity back in", async () => {
    const email = `leaver-${rand}@${domainA}`;
    const user = { sub: "leaver-sub", email, email_verified: true };
    const jar = new Jar();
    await sso(idpA, jar, { email }, user);
    const id = (await userIdOf(email))!;
    expect(await isMember(ownerA.orgId, id)).toBe(true);
    const removed = await call("/api/auth/organization/remove-member", { method: "POST", jar: ownerA.jar, body: { organizationId: ownerA.orgId, memberIdOrEmail: email } });
    expect(removed.status, removed.text).toBe(200);
    expect(await q("SELECT 1 FROM account WHERE user_id = $1 AND provider_id = $2", [id, `sso:${connA}`])).toHaveLength(0);
    expect(failure((await sso(idpA, new Jar(), { email }, user)).location)).toBe("link_required");
    expect(await isMember(ownerA.orgId, id)).toBe(false);
  });

  it("refuses an email the provider did not verify, and a domain the connection may not use", async () => {
    for (const email_verified of [false, "true", undefined]) {
      const email = `unverified-${String(email_verified)}@${domainA}`;
      const { location } = await sso(idpA, new Jar(), { email }, { sub: `uv-${String(email_verified)}`, email, email_verified });
      expect(failure(location)).toBe("email_not_verified");
      expect(await userIdOf(email)).toBeNull();
    }
    const outsider = `mallory@other-${rand}.test`;
    const { location } = await sso(idpA, new Jar(), { workspace: (await q<{ slug: string }>("SELECT slug FROM organization WHERE id = $1", [ownerA.orgId]))[0].slug }, { sub: "mallory", email: outsider, email_verified: true });
    expect(failure(location)).toBe("domain_not_allowed");
    expect(await userIdOf(outsider)).toBeNull();
    const reasons = (await auditOf(ownerA.orgId)).filter((e) => e.action === "sso.sign_in_refused").map((e) => e.changes.values.reason);
    expect(reasons).toEqual(expect.arrayContaining(["email_not_verified", "domain_not_allowed"]));
  });

  it("never links an existing account by email; its owner signs in first and links from the account", async () => {
    const bob = await signUp("bob", `bob-${rand}@${domainA}`);
    const user = { sub: "bob-sub", email: bob.email, email_verified: true };
    const refused = await sso(idpA, new Jar(), { email: bob.email }, user);
    expect(failure(refused.location)).toBe("link_required");
    expect((await q("SELECT 1 FROM account WHERE user_id = $1 AND provider_id LIKE 'sso:%'", [bob.id])).length).toBe(0);
    expect(await q("SELECT 1 FROM member WHERE user_id = $1 AND organization_id = $2", [bob.id, ownerA.orgId])).toHaveLength(0);

    // linking needs a session
    expect((await call("/api/auth/sso/start", { method: "POST", body: { intent: "link" } })).status).toBe(401);
    const linked = await sso(idpA, bob.jar, { intent: "link" }, user);
    expect(linked.location).toBe(`${origin}/app/account?sso=linked`);
    expect((await q("SELECT 1 FROM account WHERE user_id = $1 AND provider_id = $2", [bob.id, `sso:${connA}`])).length).toBe(1);
    // a link is a way to sign in, not a membership: that takes an invitation
    expect(await isMember(ownerA.orgId, bob.id)).toBe(false);
    await join(ownerA, bob.email, bob.jar);
    expect((await q<{ role: string }>("SELECT role FROM member WHERE user_id = $1 AND organization_id = $2", [bob.id, ownerA.orgId]))[0].role).toBe("member");
    const fresh = new Jar();
    await sso(idpA, fresh, { email: bob.email }, user);
    expect((await call("/api/me", { jar: fresh })).body.userId).toBe(bob.id);

    // the provider must vouch for the signed-in user's own address
    const carol = await signUp("carol", `carol-${rand}@${domainA}`);
    const mismatch = await sso(idpA, carol.jar, { intent: "link" }, { sub: "dave-sub", email: `dave-${rand}@${domainA}`, email_verified: true });
    expect(mismatch.location).toBe(`${origin}/app/account?sso_error=link_email_mismatch`);
    // an identity already linked to someone else cannot be linked again
    const taken = await sso(idpA, carol.jar, { intent: "link" }, user);
    expect(failure(taken.location)).toBe("identity_in_use");
  });

  it("refuses id_tokens with the wrong issuer, audience, expiry, algorithm, signature or key", async () => {
    const email = `tokens@${domainA}`;
    const user = { sub: "tokens-sub", email, email_verified: true };
    const now = Math.floor(Date.now() / 1000);
    const tweaks: Tweak[] = [
      { claims: { iss: "https://evil.example" } },
      { claims: { aud: "someone-else" } },
      { claims: { aud: [idpA.clientId, "other"], azp: "other" } },
      { claims: { exp: now - 300, iat: now - 600 } },
      { claims: { iat: now + 3600, exp: now + 4000 } },
      { sign: "none" },
      { sign: "hs256" },
      { sign: "unpublished" },
      { sign: "unknown-kid" },
    ];
    for (const tweak of tweaks) {
      const jar = new Jar();
      const { location } = await sso(idpA, jar, { email }, user, tweak);
      expect(failure(location), JSON.stringify(tweak)).toBe("invalid_id_token");
      expect((await call("/api/me", { jar })).status).toBe(401);
    }
    expect(await userIdOf(email)).toBeNull();
    // a failed token exchange is an identity provider error, not a sign-in
    const { location } = await sso(idpA, new Jar(), { email }, user, { tokenResponse: { status: 400, body: { error: "invalid_grant", error_description: "secret detail" } } });
    expect(failure(location)).toBe("idp_error");
  });

  it("makes state and nonce single use, short-lived and bound to the browser that started the sign-in", async () => {
    const email = `replay@${domainA}`;
    const user = { sub: "replay-sub", email, email_verified: true };
    const jar = new Jar();
    const first = await sso(idpA, jar, { email }, user);
    expect(first.location).toBe(`${origin}/app`);
    // the same callback again (state replay)
    expect(failure((await call(first.callback, { jar })).location!)).toBe("invalid_state");
    // the id_token of that sign-in, replayed into a new one (nonce replay)
    const old = idpA.issued[idpA.issued.length - 1];
    expect(failure((await sso(idpA, new Jar(), { email }, user, { idToken: old })).location)).toBe("invalid_id_token");

    // another browser with the state of this one: refused, and the rightful browser can still finish
    const mine = new Jar();
    const s = await call("/api/auth/sso/start", { method: "POST", body: { email }, jar: mine });
    const { callback } = idpA.authorize(s.body.url, user);
    const cb = new URL(callback);
    const stranger = new Jar();
    expect(failure((await call(cb.pathname + cb.search, { jar: stranger })).location!)).toBe("invalid_state");
    await call("/api/auth/sso/start", { method: "POST", body: { email }, jar: stranger }); // the stranger has a binding of its own
    expect(failure((await call(cb.pathname + cb.search, { jar: stranger })).location!)).toBe("invalid_state");
    expect((await call(cb.pathname + cb.search, { jar: mine })).location).toBe(`${origin}/app`);

    // two callbacks racing with the same state: exactly one signs in
    const racer = new Jar();
    const sr = await call("/api/auth/sso/start", { method: "POST", body: { email }, jar: racer });
    const cbr = new URL(idpA.authorize(sr.body.url, user).callback);
    const replayUser = (await userIdOf(email))!;
    const [{ n: before }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM session WHERE user_id = $1", [replayUser]);
    const raced = await Promise.all([call(cbr.pathname + cbr.search, { jar: racer }), call(cbr.pathname + cbr.search, { jar: racer })]);
    expect(raced.map((r) => r.location === `${origin}/app` ? "ok" : failure(r.location!)).sort()).toEqual(["invalid_state", "ok"]);
    const [{ n: after }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM session WHERE user_id = $1", [replayUser]);
    expect(after - before).toBe(1);

    // expired
    const late = new Jar();
    const s2 = await call("/api/auth/sso/start", { method: "POST", body: { email }, jar: late });
    await q(`UPDATE sso_flow SET expires_at = now() - interval '1 second' WHERE connection_id = $1 AND expires_at > now()`, [connA]);
    const cb2 = new URL(idpA.authorize(s2.body.url, user).callback);
    expect(failure((await call(cb2.pathname + cb2.search, { jar: late })).location!)).toBe("invalid_state");
    // no cookie, no state
    expect(failure((await call("/api/auth/sso/callback?code=x&state=y")).location!)).toBe("invalid_state");
    // only hashes of states are stored
    const stored = await q<{ state_hash: string }>("SELECT state_hash FROM sso_flow");
    expect(stored.some((r) => r.state_hash === cb2.searchParams.get("state"))).toBe(false);
  });

  it("keeps tenants apart: another provider's token, another workspace's domain and memberships", async () => {
    // a sign-in through workspace B whose provider hands back a token minted by workspace A's provider
    const email = `cross@${domainB}`;
    const minted = await idpA.mint({ sub: "cross-sub", email, email_verified: true }, "unused-nonce");
    const { location } = await sso(idpB, new Jar(), { email }, { sub: "cross-sub", email, email_verified: true }, { idToken: minted });
    expect(failure(location)).toBe("invalid_id_token");
    // alice (provisioned by A) through B's connection: her domain is not B's
    const viaB = await sso(idpB, new Jar(), { workspace: (await q<{ slug: string }>("SELECT slug FROM organization WHERE id = $1", [ownerB.orgId]))[0].slug }, { sub: "alice-sub", email: `alice@${domainA}`, email_verified: true });
    expect(failure(viaB.location)).toBe("domain_not_allowed");
    // B cannot claim A's verified domain
    const claim = await call("/api/sso", { method: "PUT", jar: ownerB.jar, body: { issuer: idpB.issuer, clientId: idpB.clientId, domains: [domainB, domainA] } });
    expect(claim.status).toBe(200);
    const dA = claim.body.connection.domains.find((d: any) => d.domain === domainA);
    publish(dA.txtName, dA.txtValue);
    expect((await call(`/api/sso/domains/${domainA}/verify`, { method: "POST", jar: ownerB.jar })).status).toBe(409);
    expect((await call("/api/auth/sso/start", { method: "POST", body: { email: `x@${domainA}` } })).body.url.startsWith(idpA.issuer)).toBe(true);
    // a person provisioned through B is a member of B only
    const bea = `bea@${domainB}`;
    const jar = new Jar();
    await sso(idpB, jar, { email: bea }, { sub: "bea-sub", email: bea, email_verified: true });
    const orgs = await q<{ organization_id: string }>("SELECT organization_id FROM member WHERE user_id = $1", [await userIdOf(bea)]);
    expect(orgs.map((o) => o.organization_id)).toEqual([ownerB.orgId]);
    // the same subject at A's provider is a different identity: B's link does not sign anyone in at A
    expect(failure((await sso(idpA, new Jar(), { email: `bea@${domainA}` }, { sub: "bea-sub", email: bea, email_verified: true })).location)).toBe("domain_not_allowed");
    const beaId = await userIdOf(bea);
    expect((await auditOf(ownerA.orgId)).some((e) => e.actor_id === beaId)).toBe(false);
  });

  it("refuses a disabled connection, including sign-ins that started before it was switched off", async () => {
    const email = `late@${domainA}`;
    const user = { sub: "late-sub", email, email_verified: true };
    const jar = new Jar();
    const s = await call("/api/auth/sso/start", { method: "POST", body: { email }, jar });
    const off = await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpA.issuer, clientId: idpA.clientId, domains: [domainA], enabled: false } });
    expect(off.status).toBe(200);
    const cb = new URL(idpA.authorize(s.body.url, user).callback);
    expect(failure((await call(cb.pathname + cb.search, { jar })).location!)).toBe("connection_disabled");
    expect((await call("/api/auth/sso/start", { method: "POST", body: { email } })).status).toBe(404);
    expect((await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpA.issuer, clientId: idpA.clientId, domains: [domainA], enabled: true } })).status).toBe(200);
    expect((await sso(idpA, new Jar(), { email }, user)).location).toBe(`${origin}/app`);
  });

  it("with SSO required, members sign in only through it; the owner keeps password sign-in as break-glass", async () => {
    const dana = await signUp("dana", `dana-${rand}@${domainA}`);
    const danaUser = { sub: "dana-sub", email: dana.email, email_verified: true };
    await join(ownerA, dana.email, dana.jar);
    await sso(idpA, dana.jar, { intent: "link" }, danaUser); // a member of A with a password and a linked identity
    const [{ id: danaMember }] = await q<{ id: string }>("SELECT id FROM member WHERE organization_id = $1 AND user_id = $2", [ownerA.orgId, dana.id]);
    expect((await call("/api/auth/organization/update-member-role", { method: "POST", jar: ownerA.jar, body: { organizationId: ownerA.orgId, memberId: danaMember, role: "admin" } })).status).toBe(200);
    // the same identity at the operator's instance-wide provider (provider B here), linked directly in the database
    const instanceEnv = { ...env, OIDC_ISSUER: idpB.issuer, OIDC_CLIENT_ID: idpB.clientId, OIDC_CLIENT_SECRET: idpB.clientSecret };
    await q(`INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ($1, $2, 'sso:instance', $3, now(), now())`, [crypto.randomUUID(), `${idpB.issuer}|dana-instance`, dana.id]);

    // before the switch: a password session, an API key and an agent authorization made with it
    const passwordJar = new Jar();
    expect((await passwordSignIn(dana.email, passwordJar)).status).toBe(200);
    expect((await call("/api/auth/organization/set-active", { method: "POST", jar: passwordJar, body: { organizationId: ownerA.orgId } })).status).toBe(200);
    expect((await call("/api/me", { jar: passwordJar })).body.organization.id).toBe(ownerA.orgId);
    const oldKey = await call("/api/auth/api-key/create", { method: "POST", jar: passwordJar, body: { name: "pre-switch", metadata: { organizationId: ownerA.orgId } } });
    expect(oldKey.status, oldKey.text).toBe(200);
    expect(await asKey(oldKey.body.key)).toBe(200);
    const oldAgent = await agentToken(passwordJar, ownerA.orgId);
    expect(oldAgent.token).toBeTruthy();
    expect(await asAgent(oldAgent.token!, ownerA.orgId)).toBe(200);
    // the owner's own key keeps working throughout (break-glass)
    expect(await asKey(apiKey)).toBe(200);

    const on = await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpA.issuer, clientId: idpA.clientId, domains: [domainA], requireSso: true } });
    expect(on.status, on.text).toBe(200);
    expect(on.body.connection.requireSso).toBe(true);

    // password sign-in is refused for the member...
    const refused = await passwordSignIn(dana.email);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("SSO_REQUIRED");
    // ...her session from before the switch was revoked and can no longer act on the workspace, through the API or
    // through the endpoints Better Auth runs itself (invitations, roles, agent consent, API keys)...
    expect(await q("SELECT 1 FROM session s WHERE s.user_id = $1 AND NOT EXISTS (SELECT 1 FROM sso_session x WHERE x.session_id = s.id)", [dana.id])).toHaveLength(0);
    expect([401, 403]).toContain((await call("/api/me", { jar: passwordJar })).status);
    expect([401, 403]).toContain((await call("/api/auth/organization/invite-member", { method: "POST", jar: passwordJar, body: { organizationId: ownerA.orgId, email: `x-${rand}@example.com`, role: "member" } })).status);
    expect([401, 403]).toContain((await call("/api/auth/organization/update-member-role", { method: "POST", jar: passwordJar, body: { organizationId: ownerA.orgId, memberId: danaMember, role: "member" } })).status);
    expect([401, 403]).toContain((await call("/api/auth/api-key/create", { method: "POST", jar: passwordJar, body: { name: "post-switch", metadata: { organizationId: ownerA.orgId } } })).status);
    const lateAgent = await agentToken(passwordJar, ownerA.orgId);
    expect(lateAgent.token).toBeUndefined();
    // ...and the key and the agent authorization made before the switch are refused at use
    expect(await asKey(oldKey.body.key)).toBe(403);
    expect(await asAgent(oldAgent.token!, ownerA.orgId)).toBe(403);
    expect(await q<{ role: string }>("SELECT role FROM member WHERE id = $1", [danaMember])).toEqual([{ role: "admin" }]);

    // SSO through the workspace's own connection works, and what is made from that session works too
    const viaSso = new Jar();
    expect((await sso(idpA, viaSso, { email: dana.email }, danaUser)).location).toBe(`${origin}/app`);
    const me = await call("/api/me", { jar: viaSso });
    expect(me.status).toBe(200);
    expect(me.body.organization.id).toBe(ownerA.orgId);
    const invite = await call("/api/auth/organization/invite-member", { method: "POST", jar: viaSso, body: { organizationId: ownerA.orgId, email: `y-${rand}@example.com`, role: "member" } });
    expect(invite.status, invite.text).toBe(200);
    const newKey = await call("/api/auth/api-key/create", { method: "POST", jar: viaSso, body: { name: "via-sso", metadata: { organizationId: ownerA.orgId } } });
    expect(newKey.status, newKey.text).toBe(200);
    expect(await asKey(newKey.body.key)).toBe(200);
    const newAgent = await agentToken(viaSso, ownerA.orgId);
    expect(newAgent.token).toBeTruthy();
    expect(await asAgent(newAgent.token!, ownerA.orgId)).toBe(200);

    // the operator's instance-wide provider is another connection: it does not satisfy workspace A's requirement
    const viaInstance = new Jar();
    const inst = await sso(idpB, viaInstance, {}, { sub: "dana-instance", email: dana.email, email_verified: true }, {}, instanceEnv);
    expect(failure(inst.location)).toBe("sso_required");
    expect((await call("/api/me", { jar: viaInstance })).status).toBe(401);

    // the owner is the break-glass account, and keeps password sign-in
    const owner = await passwordSignIn(ownerA.email);
    expect(owner.status).toBe(200);
    expect(await asKey(apiKey)).toBe(200);
    expect((await call("/api/sso", { method: "PUT", jar: ownerA.jar, body: { issuer: idpA.issuer, clientId: idpA.clientId, domains: [domainA], requireSso: false } })).status).toBe(200);
    expect((await passwordSignIn(dana.email)).status).toBe(200);
    expect(await asKey(oldKey.body.key)).toBe(200);
  });

  it("re-checks verified domains: a vanished TXT record withdraws the domain and releases it for another workspace", async () => {
    const ownerC = await signUp("owner-c");
    const domainC = `corp-c-${rand}.test`;
    await configure(ownerC, idpA, domainC);
    const [{ id }] = await q<{ id: string }>("SELECT id::text AS id FROM sso_domain WHERE domain = $1 AND verified_at IS NOT NULL", [domainC]);
    const gone = async () => [] as string[][];
    const policy = { healthyMs: 0, failingMs: 0, absentMs: 0, minFailures: 2 };
    const query = <T,>(sql: string, params?: unknown[]) => q<T>(sql, params);
    // a record that is still there keeps the domain
    expect(await recheckSsoDomains(query, { domainIds: [id], policy })).toMatchObject({ checked: 1, matched: 1, withdrawn: 0 });
    // the first failure only starts a streak
    expect(await recheckSsoDomains(query, { domainIds: [id], policy, resolver: gone, now: new Date(Date.now() + 1000) })).toMatchObject({ checked: 1, failed: 1, withdrawn: 0 });
    expect((await call("/api/sso", { jar: ownerC.jar })).body.connection.domains[0]).toMatchObject({ verified: true, checkError: "missing" });
    expect((await call("/api/auth/sso/start", { method: "POST", body: { email: `x@${domainC}` } })).status).toBe(200);
    // the streak is old and long enough: withdrawn, audited, and nobody signs in through it any more
    expect(await recheckSsoDomains(query, { domainIds: [id], policy, resolver: gone, now: new Date(Date.now() + 2000) })).toMatchObject({ withdrawn: 1 });
    expect((await call("/api/sso", { jar: ownerC.jar })).body.connection.domains[0]).toMatchObject({ verified: false, checkError: "missing" });
    expect((await call("/api/auth/sso/start", { method: "POST", body: { email: `x@${domainC}` } })).status).toBe(404);
    expect((await auditOf(ownerC.orgId)).find((e) => e.action === "sso.domain_withdrawn")).toMatchObject({ actor_type: "system", changes: { values: { domain: domainC, reason: "missing" } } });
    // the instance-wide claim is released: another workspace that proves control now verifies it
    const claim = await call("/api/sso", { method: "PUT", jar: ownerB.jar, body: { issuer: idpB.issuer, clientId: idpB.clientId, domains: [domainB, domainC] } });
    expect(claim.status, claim.text).toBe(200);
    const dC = claim.body.connection.domains.find((d: any) => d.domain === domainC);
    publish(dC.txtName, dC.txtValue);
    expect((await call(`/api/sso/domains/${domainC}/verify`, { method: "POST", jar: ownerB.jar })).status).toBe(200);
    expect((await call("/api/auth/sso/start", { method: "POST", body: { email: `x@${domainC}` } })).body.url.startsWith(idpB.issuer)).toBe(true);
    // and the former holder cannot take it back while B holds it
    expect((await call(`/api/sso/domains/${domainC}/verify`, { method: "POST", jar: ownerC.jar })).status).toBe(409);
  });

  it("records SSO configuration changes and sign-ins in the audit log, never a secret", async () => {
    const events = await auditOf(ownerA.orgId);
    const actions = events.map((e) => e.action);
    for (const a of ["sso.connection_create", "sso.connection_update", "sso.domain_verify", "sso.sign_in", "sso.sign_in_refused"]) expect(actions, a).toContain(a);
    const created = events.find((e) => e.action === "sso.connection_create")!;
    expect(created).toMatchObject({ actor_type: "user", actor_id: ownerA.id, target_id: connA });
    expect(created.changes.fields).toEqual(expect.arrayContaining(["clientId", "clientSecret", "issuer", "domains"]));
    expect(created.changes.values).toMatchObject({ enabled: true, requireSso: false, defaultRole: "member" });
    const listed = await call("/api/audit-events?action=sso&limit=200", { jar: ownerA.jar });
    expect(listed.status).toBe(200);
    expect(listed.body.events.length).toBeGreaterThan(5);
    const all = JSON.stringify([events, listed.body, await auditOf(ownerB.orgId)]);
    for (const secret of [idpA.clientSecret, idpB.clientSecret]) expect(all).not.toContain(secret);
    for (const token of idpA.issued) expect(all).not.toContain(token);
  });

  it("deletes the connection with its identity links", async () => {
    expect((await call("/api/sso", { method: "DELETE", jar: ownerB.jar })).status).toBe(204);
    expect((await q("SELECT 1 FROM account WHERE provider_id = $1", [`sso:${connB}`])).length).toBe(0);
    expect((await q("SELECT 1 FROM sso_domain WHERE connection_id = $1", [connB])).length).toBe(0);
    expect((await call("/api/auth/sso/start", { method: "POST", body: { email: `bea@${domainB}` } })).status).toBe(404);
    expect((await call("/api/sso", { jar: ownerB.jar })).body.connection).toBeNull();
    expect((await auditOf(ownerB.orgId)).map((e) => e.action)).toContain("sso.connection_delete");
  });

  it("never logs a client secret, a code or an id_token", () => {
    const text = logged.join("\n");
    for (const secret of [idpA.clientSecret, idpB.clientSecret, ...idpA.issued, ...idpB.issued]) expect(text).not.toContain(secret);
    expect(text).not.toContain("secret detail");
  });
});
