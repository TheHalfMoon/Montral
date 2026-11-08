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

describe.skipIf(!url)("members-only status pages (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 4 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  beforeAll(async () => { await migrateMontralSchema(database!, montralEdition); });
  afterAll(async () => { await database?.close(1); });

  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.fetch(new Request(origin + path, {
      ...init,
      headers: { origin, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) },
    }), env as never);
  async function signUp() {
    const email = `montral-visibility-${crypto.randomUUID()}@example.com`;
    const res = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Visibility QA", password: "correct horse battery staple" }) });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const me = (await (await call("/api/me", { cookie })).json()) as { organization: { id: string }; projectId: string };
    return { email, cookie, orgId: me.organization.id, projectId: me.projectId };
  }
  const routes = (slug: string) => [
    `/api/public/status/${slug}`, `/api/public/status/${slug}/summary`, `/api/public/status/${slug}/badge.svg`,
    `/api/public/status/${slug}/incidents`, `/api/public/status/${slug}/rss.xml`, `/api/public/status/${slug}/rss`,
    `/api/public/status/${slug}/maintenance.ics`, `/api/public/status/${slug}/llms.txt`, `/api/public/status/${slug}/maintenance`,
  ];

  it("hides a members-only page and its feeds from everyone outside the workspace, without shared caching", async () => {
    const owner = await signUp();
    const outsider = await signUp();
    const slug = `private-${crypto.randomUUID().slice(0, 8)}`;
    const created = await call("/api/status-pages", { method: "POST", cookie: owner.cookie, body: JSON.stringify({ slug, title: "Internal systems" }) });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; visibility: string };
    expect(page.visibility).toBe("public");
    expect((await call(`/api/public/status/${slug}`)).status).toBe(200);

    const patched = await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "members" }) });
    expect(patched.status).toBe(200);
    expect((await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "secret" }) })).status).toBe(400);

    for (const path of routes(slug)) {
      for (const [who, cookie] of [["anonymous", undefined], ["outsider", outsider.cookie]] as const) {
        const res = await call(path, { cookie });
        expect(res.status, `${who} ${path}`).toBe(404);
        expect(res.headers.get("cache-control"), `${who} ${path}`).toBe("private, no-store");
        const text = await res.text();
        expect(text, `${who} ${path}`).not.toContain("Internal systems");
      }
      const member = await call(path, { cookie: owner.cookie });
      expect(member.status, `member ${path}`).toBe(200);
      expect(member.headers.get("cache-control"), `member ${path}`).toBe("private, no-store");
      expect(member.headers.get("vary"), `member ${path}`).toContain("Cookie");
    }
    // Subscribing is part of the page too: outsiders cannot even learn the page exists.
    const subscribe = await call(`/api/public/status/${slug}/subscribe`, { method: "POST", body: JSON.stringify({ email: "stranger@example.com" }) });
    expect(subscribe.status).toBe(404);
    // An API key is not a browser session of a member.
    const anyKey = await call(`/api/public/status/${slug}`, { headers: { authorization: "Bearer montral_not_a_session" } });
    expect(anyKey.status).toBe(404);

    // Back to public: shared caching and anonymous access return.
    await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "public" }) });
    const open = await call(`/api/public/status/${slug}/summary`);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toMatch(/^public/);
  });

  it("mails a members-only page's incidents only to verified workspace members", async () => {
    const owner = await signUp();
    const slug = `private-mail-${crypto.randomUUID().slice(0, 8)}`;
    const page = (await (await call("/api/status-pages", { method: "POST", cookie: owner.cookie, body: JSON.stringify({ slug, title: "Private mail" }) })).json()) as { id: string };
    const [monitor] = await database!.query<{ id: string }>(
      "INSERT INTO monitor (organization_id, project_id, name, type, target) VALUES ($1, $2, 'Visibility QA', 'heartbeat', 'synthetic') RETURNING id",
      [owner.orgId, owner.projectId],
    );
    await database!.query("INSERT INTO status_page_component (status_page_id, monitor_id) VALUES ($1, $2)", [page.id, monitor.id]);
    for (const email of [owner.email.toUpperCase(), "outside-subscriber@example.com"]) {
      await database!.query(
        "INSERT INTO status_subscriber (status_page_id, email, token, confirmed_at) VALUES ($1, $2, $3, now())",
        [page.id, email, crypto.randomUUID().replace(/-/g, "")],
      );
    }
    const recipients = async () => (await database!.repo.subscribersFor(owner.orgId, monitor.id)).map((s) => s.email.toLowerCase()).sort();
    const manualRecipients = async () => (await database!.repo.subscribersFor(owner.orgId, null, owner.projectId)).map((s) => s.email.toLowerCase()).sort();
    expect(await recipients()).toEqual([owner.email, "outside-subscriber@example.com"].sort());

    await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "members" }) });
    // Unverified members do not count either.
    await database!.query('UPDATE "user" SET email_verified = false WHERE lower(email) = lower($1)', [owner.email]);
    expect(await recipients()).toEqual([]);
    expect(await manualRecipients()).toEqual([]);
    await database!.query('UPDATE "user" SET email_verified = true WHERE lower(email) = lower($1)', [owner.email]);
    expect(await recipients()).toEqual([owner.email]);
    expect(await manualRecipients()).toEqual([owner.email]);
  });

  it("reminds only verified members about a members-only page's maintenance, never outside subscribers", async () => {
    const owner = await signUp();
    const slug = `private-maint-${crypto.randomUUID().slice(0, 8)}`;
    const page = (await (await call("/api/status-pages", { method: "POST", cookie: owner.cookie, body: JSON.stringify({ slug, title: "Private maintenance", visibility: "members" }) })).json()) as { id: string; visibility: string };
    expect(page.visibility).toBe("members");
    await database!.query(
      "INSERT INTO status_subscriber (status_page_id, email, token, confirmed_at) VALUES ($1, 'outsider-maint@example.com', $2, now())",
      [page.id, crypto.randomUUID().replace(/-/g, "")],
    );
    const [w] = await database!.query<{ id: string }>(
      "INSERT INTO maintenance_window (organization_id, project_id, name, starts_at, ends_at) VALUES ($1, $2, 'Upgrade', now() + interval '1 hour', now() + interval '2 hours') RETURNING id",
      [owner.orgId, owner.projectId],
    );
    const mine = async () => (await database!.repo.claimMaintenanceReminders(500)).filter((r) => r.window.id === w.id);
    // Only an outsider follows the page: nothing is sent and the window stays unclaimed.
    expect(await mine()).toEqual([]);
    const claimed = await database!.query("SELECT 1 FROM maintenance_reminder WHERE maintenance_id = $1", [w.id]);
    expect(claimed).toHaveLength(0);
    // A verified member subscribes: the reminder goes to the member only.
    await database!.query('UPDATE "user" SET email_verified = true WHERE lower(email) = lower($1)', [owner.email]);
    await database!.query(
      "INSERT INTO status_subscriber (status_page_id, email, token, confirmed_at) VALUES ($1, $2, $3, now())",
      [page.id, owner.email, crypto.randomUUID().replace(/-/g, "")],
    );
    const sent = await mine();
    expect(sent).toHaveLength(1);
    expect(sent[0].subscribers.map((x) => x.email)).toEqual([owner.email]);
  });
});
