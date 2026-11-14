import { openDatabase } from "@montral/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { setMailTransport } from "./email";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "synthetic-status-access-secret-123456789", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, CRON_SECRET: "cron", TRUST_PROXY: "true", EMAIL_FROM: "alerts@example.test" };
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
describe.skipIf(!url)("atomic status-page access changes", () => {
  const database = url ? openDatabase(url) : undefined;
  const ip = `2001:db8:72:${crypto.randomUUID().slice(0, 4)}::1`;
  let cookie: string, org: string, project: string;
  let gate: { pageId: string; reads: number; first: ReturnType<typeof signal>; both: ReturnType<typeof signal>; second: ReturnType<typeof signal> } | null = null;
  let subscriptionGate: { slug: string; reads: number; ready: ReturnType<typeof signal>; release: ReturnType<typeof signal> } | null = null;
  const app = createApp((connection, options) => {
    const db = openDatabase(connection, options);
    return { ...db, repo: { ...db.repo, getStatusPage: async (...args: Parameters<typeof db.repo.getStatusPage>) => {
      const snapshot = await db.repo.getStatusPage(...args);
      const current = gate;
      if (current && args[1] === current.pageId) {
        const number = ++current.reads;
        if (number === 1) { current.first.resolve(); await current.both.promise; }
        if (number === 2) { current.both.resolve(); await current.second.promise; }
      }
      return snapshot;
    }, statusPageBySlug: async (slug) => {
      const current = subscriptionGate;
      if (current && slug === current.slug && ++current.reads === 2) {
        current.ready.resolve(); await current.release.promise;
      }
      return db.repo.statusPageBySlug(slug);
    } } };
  });
  async function request(path: string, method = "GET", body?: unknown, authenticated = false, visitor?: string) {
    const response = await app.fetch(new Request(origin + path, { method,
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(authenticated ? { cookie } : visitor ? { cookie: visitor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env as never);
    return { status: response.status, body: await response.json().catch(() => null) as any, response };
  }
  beforeAll(async () => {
    setMailTransport(async () => {});
    expect((await app.fetch(new Request(`${origin}/internal/migrate`, { method: "POST", headers: { "x-cron-secret": "cron" } }), env as never)).status).toBe(200);
    const signup = await request("/api/auth/sign-up/email", "POST", { email: `access-race-${crypto.randomUUID()}@example.test`, password: "correct horse battery", name: "Access owner" });
    expect(signup.status).toBe(200);
    cookie = signup.response.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const me = await request("/api/me", "GET", undefined, true);
    org = me.body.organization.id; project = me.body.projectId;
  });
  afterAll(async () => { gate?.both.resolve(); gate?.second.resolve(); subscriptionGate?.release.resolve(); setMailTransport(undefined); await database?.close(); });
  async function page() {
    const slug = `access-${crypto.randomUUID().slice(0, 12)}`;
    const result = await request("/api/status-pages", "POST", { slug, title: "Private control", visibility: "password", password: "initial-password" }, true);
    expect(result.status).toBe(201);
    return { id: result.body.id as string, slug };
  }
  const unlock = async (slug: string, password: string) => {
    const result = await request("/api/public/status/_/unlock", "POST", { slug, password });
    expect(result.status).toBe(204);
    return result.response.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  };
  async function overlap(id: string, firstBody: unknown, secondBody: unknown, between: () => Promise<void>, revoke = false) {
    const current = { pageId: id, reads: 0, first: signal(), both: signal(), second: signal() };
    gate = current;
    const first = request(`/api/status-pages/${id}`, "PATCH", firstBody, true);
    await current.first.promise;
    const second = request(`/api/status-pages/${id}${revoke ? "/access/revoke" : ""}`, revoke ? "POST" : "PATCH", revoke ? undefined : secondBody, true);
    try {
      await current.both.promise;
      expect((await first).status).toBe(200);
      await between();
      current.second.resolve();
      expect((await second).status).toBe(200);
    } finally {
      current.both.resolve(); current.second.resolve();
      await Promise.allSettled([first, second]); gate = null;
    }
  }
  it("removes public subscriber eligibility when a stale PATCH restores password visibility", async () => {
    const p = await page();
    const [monitor] = await database!.query<{ id: string }>("insert into monitor (organization_id,project_id,name,type,target,paused) values ($1,$2,'Scope','heartbeat','synthetic',true) returning id", [org, project]);
    await database!.query("insert into status_page_component (status_page_id,monitor_id) values ($1,$2)", [p.id, monitor.id]);
    const email = `outsider-${crypto.randomUUID()}@example.test`;
    const recipients = async () => (await database!.repo.subscribersFor(org, monitor.id)).map((s) => s.email);
    await overlap(p.id, { visibility: "public" }, { visibility: "password" }, async () => {
      expect((await request(`/api/public/status/${p.slug}/subscribe`, "POST", { email })).status).toBe(200);
      // Confirmation belongs to the synthetic outsider; no real mail provider is used.
      const [row] = await database!.query<{ token: string }>("select token from status_subscriber where status_page_id=$1 and email=$2", [p.id, email]);
      expect((await request(`/api/public/status/_/confirm?token=${row.token}`)).status).toBe(302);
      expect(await recipients()).toEqual([email]);
    });
    expect((await request(`/api/public/status/${p.slug}`)).status).toBe(401);
    expect(await recipients()).toEqual([]);
  });
  it.each([false, true])("invalidates an intermediate password grant after a later change (revoke: %s)", async (revoke) => {
    const p = await page();
    let intermediate = "";
    await overlap(p.id, { password: "replacement-password-A" }, { password: "replacement-password-B" }, async () => {
      intermediate = await unlock(p.slug, "replacement-password-A");
      expect((await request(`/api/public/status/${p.slug}`, "GET", undefined, false, intermediate)).status).toBe(200);
    }, revoke);
    expect((await request(`/api/public/status/${p.slug}`, "GET", undefined, false, intermediate)).status).toBe(401);
    const current = await unlock(p.slug, revoke ? "replacement-password-A" : "replacement-password-B");
    expect((await request(`/api/public/status/${p.slug}`, "GET", undefined, false, current)).status).toBe(200);
    expect((await request(`/api/status-pages/${p.id}`, "PATCH", { title: "Renamed", visibility: "password" }, true)).status).toBe(200);
    expect((await request(`/api/public/status/${p.slug}`, "GET", undefined, false, current)).status).toBe(200);
  });
  it.each(["public", "password"] as const)("does not upgrade an in-flight %s subscription to a newly protected version", async (visibility) => {
    const p = await page();
    const visitor = visibility === "password" ? await unlock(p.slug, "initial-password") : undefined;
    if (visibility === "public") expect((await request(`/api/status-pages/${p.id}`, "PATCH", { visibility: "public" }, true)).status).toBe(200);
    const [monitor] = await database!.query<{ id: string }>("insert into monitor (organization_id,project_id,name,type,target,paused) values ($1,$2,'Subscription','heartbeat','synthetic',true) returning id", [org, project]);
    await database!.query("insert into status_page_component (status_page_id,monitor_id) values ($1,$2)", [p.id, monitor.id]);
    const email = `subscription-${crypto.randomUUID()}@example.test`;
    if (visitor) {
      expect((await request(`/api/public/status/${p.slug}/subscribe`, "POST", { email }, false, visitor)).status).toBe(200);
      const [existing] = await database!.query<{ token: string }>("select token from status_subscriber where status_page_id=$1 and email=$2", [p.id, email]);
      expect((await request(`/api/public/status/_/confirm?token=${existing.token}`)).status).toBe(302);
    }
    const current = { slug: p.slug, reads: 0, ready: signal(), release: signal() };
    subscriptionGate = current;
    const pending = request(`/api/public/status/${p.slug}/subscribe`, "POST", { email }, false, visitor);
    try {
      // The middleware already authorized the old version; hold the handler's fresh page lookup.
      await current.ready.promise;
      const changed = visibility === "public"
        ? await request(`/api/status-pages/${p.id}`, "PATCH", { visibility: "password" }, true)
        : await request(`/api/status-pages/${p.id}/access/revoke`, "POST", undefined, true);
      expect(changed.status).toBe(200);
      current.release.resolve();
      expect((await pending).status).toBe(200);
    } finally {
      current.release.resolve(); await pending; subscriptionGate = null;
    }
    const [row] = await database!.query<{ token: string }>("select token from status_subscriber where status_page_id=$1 and email=$2", [p.id, email]);
    expect((await request(`/api/public/status/_/confirm?token=${row.token}`)).status).toBe(302);
    const recipients = async () => (await database!.repo.subscribersFor(org, monitor.id)).map((s) => s.email);
    expect(await recipients()).toEqual([]);
    const renewed = await unlock(p.slug, "initial-password");
    expect((await request(`/api/public/status/${p.slug}/subscribe`, "POST", { email }, false, renewed)).status).toBe(200);
    expect(await recipients()).toEqual([email]);
  });
  it("does not authorize a protected page created between the access check and subscription lookup", async () => {
    const slug = `missing-${crypto.randomUUID().slice(0, 12)}`;
    const email = `missing-${crypto.randomUUID()}@example.test`;
    const current = { slug, reads: 0, ready: signal(), release: signal() };
    subscriptionGate = current;
    const pending = request(`/api/public/status/${slug}/subscribe`, "POST", { email });
    try {
      await current.ready.promise;
      expect((await request("/api/status-pages", "POST", { slug, title: "New private page", visibility: "password", password: "new-page-password" }, true)).status).toBe(201);
      current.release.resolve();
      expect((await pending).status).toBe(404);
    } finally { current.release.resolve(); await pending; subscriptionGate = null; }
    expect(await database!.query("select id from status_subscriber where email=$1", [email])).toEqual([]);
  });
});
