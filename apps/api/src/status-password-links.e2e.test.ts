import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-e2e-only-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};

describe.skipIf(!url)("password-protected status pages and share links (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 4 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  beforeAll(async () => { await migrateMontralSchema(database!, montralEdition); });
  afterAll(async () => { await database?.close(1); });

  const call = async (path: string, init: RequestInit & { cookie?: string; extraEnv?: Record<string, string> } = {}): Promise<Response> =>
    app.fetch(new Request(origin + path, {
      ...init,
      redirect: "manual",
      headers: { origin, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) },
    }), { ...env, ...init.extraEnv } as never);
  const json = async (r: Response) => r.json().catch(() => null) as Promise<any>;
  const cookieOf = (r: Response) => r.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  async function signUp() {
    const res = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email: `montral-sp-${crypto.randomUUID()}@example.com`, name: "Access QA", password: "correct horse battery staple" }) });
    expect(res.status).toBe(200);
    return cookieOf(res);
  }
  const slug = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const unlock = (s: string, password: string, extra: Partial<Parameters<typeof call>[1]> = {}) =>
    call("/api/public/status/_/unlock", { method: "POST", body: JSON.stringify({ slug: s, password }), ...extra });
  const routes = (s: string) => [`/api/public/status/${s}`, `/api/public/status/${s}/summary`, `/api/public/status/${s}/incidents`, `/api/public/status/${s}/rss.xml`, `/api/public/status/${s}/llms.txt`];

  it("locks a password page, unlocks it only with the password, and never reveals the hash or the content", async () => {
    const owner = await signUp();
    const s = slug("pw");
    expect((await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Partner status", visibility: "password" }) })).status).toBe(400);
    expect((await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Partner status", visibility: "password", password: "short" }) })).status).toBe(400);
    const created = await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Partner status", visibility: "password", password: "partners-only-2026" }) });
    expect(created.status).toBe(201);
    const page = await json(created);
    expect(page.hasPassword).toBe(true);
    for (const body of [JSON.stringify(page), JSON.stringify(await json(await call("/api/status-pages", { cookie: owner }))), JSON.stringify(await json(await call(`/api/status-pages/${page.id}`, { cookie: owner })))]) {
      expect(body).not.toMatch(/pbkdf2|accessPasswordHash/);
    }

    for (const path of routes(s)) {
      const res = await call(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
      const text = await res.text();
      expect(text, path).not.toContain("Partner status");
      expect(text, path).toContain("password protected");
    }
    // Every failure looks the same: wrong password, unknown slug, a members-only page, a public page, junk.
    const membersSlug = slug("mem");
    await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: membersSlug, title: "Members", visibility: "members" }) });
    const publicSlug = slug("pub");
    await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: publicSlug, title: "Public" }) });
    for (const [s2, pw] of [[s, "wrong-password"], [slug("nope"), "partners-only-2026"], [membersSlug, "partners-only-2026"], [publicSlug, "partners-only-2026"], ["UPPER", "partners-only-2026"]]) {
      const res = await unlock(s2, pw);
      expect(res.status, s2).toBe(401);
      expect(await json(res), s2).toEqual({ error: "Incorrect password" });
      expect(res.headers.getSetCookie(), s2).toEqual([]);
    }
    const opened = await unlock(s, "partners-only-2026");
    expect(opened.status).toBe(204);
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
    expect(opened.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Lax/);
    const visitor = cookieOf(opened);
    for (const path of routes(s)) {
      const res = await call(path, { cookie: visitor });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
    }
    // The cookie is for this page only.
    expect((await call(`/api/public/status/${membersSlug}`, { cookie: visitor })).status).toBe(404);
    // Members never need the password.
    expect((await call(`/api/public/status/${s}`, { cookie: owner })).status).toBe(200);

    // A new password signs out everyone who used the old one.
    expect((await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ password: "rotated-partners-2027" }) })).status).toBe(200);
    expect((await call(`/api/public/status/${s}`, { cookie: visitor })).status).toBe(401);
    expect((await unlock(s, "partners-only-2026")).status).toBe(401);
    const again = cookieOf(await unlock(s, "rotated-partners-2027"));
    expect((await call(`/api/public/status/${s}`, { cookie: again })).status).toBe(200);
    // "Sign everyone out" does the same without changing the password.
    expect((await call(`/api/status-pages/${page.id}/access/revoke`, { method: "POST", cookie: owner })).status).toBe(200);
    expect((await call(`/api/public/status/${s}`, { cookie: again })).status).toBe(401);
    // Making the page public opens it; making it members-only closes it even to password holders.
    const third = cookieOf(await unlock(s, "rotated-partners-2027"));
    await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ visibility: "members" }) });
    expect((await call(`/api/public/status/${s}`, { cookie: third })).status).toBe(404);
  });

  it("limits unlock attempts per client and page", async () => {
    const owner = await signUp();
    const s = slug("rl");
    await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Rate limited", visibility: "password", password: "the-right-password" }) });
    const fromIp = { extraEnv: { TRUST_PROXY: "true" }, headers: { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` } };
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await unlock(s, `wrong-${i}`, fromIp)).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses[8]).toBe(429);
    // Even the right password is refused while limited.
    expect((await unlock(s, "the-right-password", fromIp)).status).toBe(429);
  });

  it("opens a non-public page through an expiring, revocable share link whose token is stored only as a hash", async () => {
    const owner = await signUp();
    const s = slug("link");
    const page = await json(await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Shared with auditors", visibility: "members" }) }));
    const publicSlug = slug("pub");
    const publicPage = await json(await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: publicSlug, title: "Public" }) }));
    expect((await call(`/api/status-pages/${publicPage.id}/share-links`, { method: "POST", cookie: owner, body: "{}" })).status).toBe(400);
    expect((await call(`/api/status-pages/${page.id}/share-links`, { method: "POST", cookie: owner, body: JSON.stringify({ expiresInHours: 0 }) })).status).toBe(400);
    expect((await call(`/api/status-pages/${page.id}/share-links`, { method: "POST", cookie: owner, body: JSON.stringify({ extra: true }) })).status).toBe(400);

    const created = await call(`/api/status-pages/${page.id}/share-links`, { method: "POST", cookie: owner, body: JSON.stringify({ label: "Auditor", expiresInHours: 48 }) });
    expect(created.status).toBe(201);
    const link = await json(created);
    const token = new URL(link.url).searchParams.get("t")!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await database!.query<{ token_hash: string }>("SELECT token_hash FROM status_page_share_link WHERE id = $1", [link.id]);
    expect(stored[0].token_hash).not.toBe(token);
    const listed = JSON.stringify(await json(await call(`/api/status-pages/${page.id}/share-links`, { cookie: owner })));
    expect(listed).toContain(link.id);
    expect(listed).not.toContain(token);

    // Following the link sets a cookie and lands on the page without the token in the address.
    const followed = await call(`/api/public/status/_/access?t=${token}`);
    expect(followed.status).toBe(303);
    expect(followed.headers.get("location")).toBe(`/status/${s}`);
    expect(followed.headers.get("referrer-policy")).toBe("no-referrer");
    const holder = cookieOf(followed);
    expect((await call(`/api/public/status/${s}`, { cookie: holder })).status).toBe(200);
    expect((await call(`/api/public/status/${s}`)).status).toBe(404);
    for (const bad of ["", "x".repeat(64), token.slice(0, 63), token.toUpperCase()]) {
      expect((await call(`/api/public/status/_/access?t=${bad}`)).status, bad).toBe(404);
    }

    // Revoking the link ends access at once, for the cookie and the URL.
    expect((await call(`/api/status-pages/${page.id}/share-links/${link.id}`, { method: "DELETE", cookie: owner })).status).toBe(204);
    expect((await call(`/api/public/status/${s}`, { cookie: holder })).status).toBe(404);
    expect((await call(`/api/public/status/_/access?t=${token}`)).status).toBe(404);

    // An expired link stops working the same way.
    const second = await json(await call(`/api/status-pages/${page.id}/share-links`, { method: "POST", cookie: owner, body: "{}" }));
    const secondToken = new URL(second.url).searchParams.get("t")!;
    const secondHolder = cookieOf(await call(`/api/public/status/_/access?t=${secondToken}`));
    expect((await call(`/api/public/status/${s}`, { cookie: secondHolder })).status).toBe(200);
    await database!.query("UPDATE status_page_share_link SET expires_at = now() - interval '1 second' WHERE id = $1", [second.id]);
    expect((await call(`/api/public/status/${s}`, { cookie: secondHolder })).status).toBe(404);
    expect((await call(`/api/public/status/_/access?t=${secondToken}`)).status).toBe(404);

    // Another workspace cannot see or revoke this page's links.
    const stranger = await signUp();
    expect((await call(`/api/status-pages/${page.id}/share-links`, { cookie: stranger })).status).toBe(404);
    expect((await call(`/api/status-pages/${page.id}/share-links/${second.id}`, { method: "DELETE", cookie: stranger })).status).toBe(404);
  });

  it("mails a password page only to subscribers of the current access version", async () => {
    const owner = await signUp();
    const s = slug("pwmail");
    const page = await json(await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Password mail", visibility: "password", password: "mail-password-1" }) }));
    const me = await json(await call("/api/me", { cookie: owner }));
    const [monitor] = await database!.query<{ id: string }>(
      "INSERT INTO monitor (organization_id, project_id, name, type, target) VALUES ($1, $2, 'Access QA', 'heartbeat', 'synthetic') RETURNING id",
      [me.organization.id, me.projectId],
    );
    await database!.query("INSERT INTO status_page_component (status_page_id, monitor_id) VALUES ($1, $2)", [page.id, monitor.id]);
    // Subscribing goes through the page, so it needs the page unlocked; the row records the access version.
    const visitor = cookieOf(await unlock(s, "mail-password-1"));
    expect((await call(`/api/public/status/${s}/subscribe`, { method: "POST", body: JSON.stringify({ email: "partner@example.com" }) })).status).toBe(401);
    expect((await call(`/api/public/status/${s}/subscribe`, { method: "POST", cookie: visitor, body: JSON.stringify({ email: "partner@example.com" }) })).status).toBe(200);
    await database!.query("UPDATE status_subscriber SET confirmed_at = now() WHERE status_page_id = $1", [page.id]);
    const recipients = async () => (await database!.repo.subscribersFor(me.organization.id, monitor.id)).map((x) => x.email);
    expect(await recipients()).toEqual(["partner@example.com"]);
    // A new password (or "sign everyone out") stops mail to earlier subscribers until they subscribe again with access.
    await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ password: "mail-password-2" }) });
    expect(await recipients()).toEqual([]);
    const renewed = cookieOf(await unlock(s, "mail-password-2"));
    await call(`/api/public/status/${s}/subscribe`, { method: "POST", cookie: renewed, body: JSON.stringify({ email: "partner@example.com" }) });
    expect(await recipients()).toEqual(["partner@example.com"]);
  });

  it("signs outsiders out on any visibility change, so a page returning to password mode does not revive old access", async () => {
    const owner = await signUp();
    const s = slug("round");
    const page = await json(await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Round trip", visibility: "password", password: "round-trip-pass" }) }));
    const me = await json(await call("/api/me", { cookie: owner }));
    const [monitor] = await database!.query<{ id: string }>(
      "INSERT INTO monitor (organization_id, project_id, name, type, target) VALUES ($1, $2, 'Round QA', 'heartbeat', 'synthetic') RETURNING id",
      [me.organization.id, me.projectId],
    );
    await database!.query("INSERT INTO status_page_component (status_page_id, monitor_id) VALUES ($1, $2)", [page.id, monitor.id]);
    const unlocked = cookieOf(await unlock(s, "round-trip-pass"));
    // While public, a stranger subscribes; then the page goes back behind the same password.
    expect((await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ visibility: "public" }) })).status).toBe(200);
    expect((await call(`/api/public/status/${s}/subscribe`, { method: "POST", body: JSON.stringify({ email: "stranger@example.com" }) })).status).toBe(200);
    await database!.query("UPDATE status_subscriber SET confirmed_at = now() WHERE status_page_id = $1", [page.id]);
    // while public the stranger is a recipient (so the empty list below is caused by the switch, not a no-op subscribe)
    expect((await database!.repo.subscribersFor(me.organization.id, monitor.id)).map((x) => x.email)).toEqual(["stranger@example.com"]);
    expect((await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ visibility: "password" }) })).status).toBe(200);
    expect((await database!.repo.subscribersFor(me.organization.id, monitor.id)).map((x) => x.email)).toEqual([]);
    expect((await call(`/api/public/status/${s}`, { cookie: unlocked })).status).toBe(401);
    // password -> members -> password: the earlier unlock cookie stays dead
    const fresh = cookieOf(await unlock(s, "round-trip-pass"));
    expect((await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ visibility: "members" }) })).status).toBe(200);
    expect((await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ visibility: "password" }) })).status).toBe(200);
    expect((await call(`/api/public/status/${s}`, { cookie: fresh })).status).toBe(401);
  });

  it("counts only failed unlocks against the page, and refuses cross-site unlock requests", async () => {
    const owner = await signUp();
    const s = slug("fail");
    await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Failures", visibility: "password", password: "only-failures-count" }) });
    // Successful unlocks give their slot back: they leave no failure counted.
    const failures = async () => (await database!.query<{ count: number }>("SELECT count FROM rate_limit WHERE key = $1", [`sp-unlock:fail:${s}`]))[0]?.count ?? 0;
    for (let i = 0; i < 3; i++) expect((await unlock(s, "only-failures-count")).status).toBe(204);
    expect(await failures()).toBe(0);
    expect((await unlock(s, "wrong-once")).status).toBe(401);
    expect(await failures()).toBe(1);
    // A page that reached its hourly failure budget refuses even the right password, without verifying it.
    await database!.query("UPDATE rate_limit SET count = 100 WHERE key = $1", [`sp-unlock:fail:${s}`]);
    expect((await unlock(s, "only-failures-count")).status).toBe(429);
    await database!.query("UPDATE rate_limit SET count = 99 WHERE key = $1", [`sp-unlock:fail:${s}`]);
    expect((await unlock(s, "only-failures-count")).status).toBe(204);
    expect(await failures()).toBe(99);
    // Concurrent wrong guesses cannot overshoot the budget: each takes its slot before the slow check.
    await database!.query("UPDATE rate_limit SET count = 95 WHERE key = $1", [`sp-unlock:fail:${s}`]);
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => unlock(s, `burst-${i}`).then((r) => r.status)));
    expect(burst.filter((x) => x === 401)).toHaveLength(5);
    expect(burst.filter((x) => x === 429)).toHaveLength(15);
    // Cross-site: a text/plain form post or a foreign Origin cannot plant a page grant.
    const plain = await call("/api/public/status/_/unlock", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ slug: s, password: "only-failures-count" }) });
    expect(plain.status).toBe(403);
    expect(plain.headers.getSetCookie()).toEqual([]);
    const foreign = await call("/api/public/status/_/unlock", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ slug: s, password: "only-failures-count" }) });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.getSetCookie()).toEqual([]);
  });

  it("never exceeds the active share-link cap under concurrent creation", async () => {
    const owner = await signUp();
    const s = slug("cap");
    const page = await json(await call("/api/status-pages", { method: "POST", cookie: owner, body: JSON.stringify({ slug: s, title: "Cap", visibility: "members" }) }));
    const statuses = await Promise.all(Array.from({ length: 60 }, () =>
      call(`/api/status-pages/${page.id}/share-links`, { method: "POST", cookie: owner, body: "{}" }).then((r) => r.status)));
    expect(statuses.filter((x) => x === 201)).toHaveLength(50);
    expect(statuses.filter((x) => x === 409)).toHaveLength(10);
    const [{ n }] = await database!.query<{ n: number }>("SELECT count(*)::int AS n FROM status_page_share_link WHERE status_page_id = $1 AND revoked_at IS NULL", [page.id]);
    expect(n).toBe(50);
  }, 30_000);
});
