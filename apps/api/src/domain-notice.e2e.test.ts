import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { DOMAIN_RECHECK, purgeCustomDomains, recheckCustomDomains, setTxtResolver, type TxtResolver } from "./custom-domain";
import { deliverDomainNotices, queueDomainNotices } from "./domain-notice";
import { configureEmail, setMailTransport } from "./email";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-e2e-only-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
  EMAIL_FROM: "alerts@example.test",
};
const H = 3600_000;
type Mail = { to: string; subject: string; text: string; html: string };

/**
 * Owner/admin emails about custom-domain re-checks (domain-notice.ts), on real PostgreSQL with a stub resolver, an
 * explicit clock and a recording mail transport. Every re-check and delivery is scoped to the test's own pages.
 */
describe.skipIf(!url)("custom domain withdrawal notices (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 6 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  const txt = new Map<string, string[]>();
  const stub: TxtResolver = async (name) => (txt.get(name) ?? []).map((v) => [v]);
  const mails: Mail[] = [];
  let failNext = 0;
  beforeAll(async () => {
    await migrateMontralSchema(database!, montralEdition);
    setTxtResolver(stub);
    configureEmail(env as never);
    setMailTransport(async (m) => {
      if (failNext > 0) { failNext--; throw new Error("smtp 451 temporary failure for someone@example.test"); }
      mails.push({ to: m.to, subject: m.subject, text: m.text, html: m.html });
    });
  });
  afterEach(() => { txt.clear(); purgeCustomDomains(); mails.length = 0; failNext = 0; });
  afterAll(async () => { setTxtResolver(undefined); setMailTransport(undefined); await database?.close(1); });

  const q = <T,>(sql: string, params?: unknown[]) => database!.query<T>(sql, params);
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.fetch(new Request(origin + path, {
      ...init,
      headers: { origin, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
    }), env as never);
  async function signUp(label: string) {
    const email = `montral-notice-${label}-${crypto.randomUUID()}@example.com`;
    const res = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: `Notice ${label}`, password: "correct horse battery staple" }) });
    expect(res.status).toBe(200);
    const id = ((await res.clone().json()) as { user: { id: string } }).user.id;
    return { email, id, cookie: res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ") };
  }
  /** an owner's workspace with two admins (one reading Chinese) and a plain member, and a page with a verified domain */
  async function workspace() {
    const owner = await signUp("owner");
    const admin = await signUp("admin");
    const adminZh = await signUp("admin-zh");
    const member = await signUp("member");
    const slug = `ntc-${crypto.randomUUID().slice(0, 8)}`;
    const created = await call("/api/status-pages", { method: "POST", cookie: owner.cookie, body: JSON.stringify({ slug, title: `Notice ${slug}` }) });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const [{ org }] = await q<{ org: string }>("SELECT organization_id AS org FROM status_page WHERE id = $1", [id]);
    for (const [u, role] of [[admin, "admin"], [adminZh, "admin"], [member, "member"]] as const) {
      await q("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, now())", [`ntc-${crypto.randomUUID()}`, org, u.id, role]);
    }
    await q(`UPDATE "user" SET locale = 'zh-CN' WHERE id = $1`, [adminZh.id]);
    const domain = `status-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const set = await call(`/api/status-pages/${id}/domain`, { method: "PUT", cookie: owner.cookie, body: JSON.stringify({ domain }) });
    const rec = ((await set.json()) as { customDomainRecord: { name: string; value: string } }).customDomainRecord;
    txt.set(rec.name, [rec.value]);
    expect((await call(`/api/status-pages/${id}/domain/verify`, { method: "POST", cookie: owner.cookie })).status).toBe(200);
    const [row] = await q<{ checked: Date }>("SELECT custom_domain_checked_at AS checked FROM status_page WHERE id = $1", [id]);
    return { id, org, domain, rec, owner, admin, adminZh, member, title: `Notice ${slug}`, t0: new Date(row.checked).getTime() };
  }
  const recheck = (id: string, at: number, query = q) => recheckCustomDomains(query, { now: new Date(at), resolver: stub, pageIds: [id] });
  const rows = (id: string, kind: string) => q<{ target_user_id: string; status: string; attempts: number; dedupe_key: string; status_message: string | null; next_attempt_at: Date | null }>(
    "SELECT target_user_id, status, attempts, dedupe_key, status_message, next_attempt_at FROM alert_delivery WHERE status_page_id = $1 AND kind = $2 ORDER BY target_user_id", [id, kind]);
  const to = (...people: { email: string }[]) => people.map((p) => p.email).sort();
  const sent = (list: Mail[]) => list.map((m) => m.to).sort();

  it("a withdrawal emails each owner and admin exactly once, members never; a second failing re-check warns once per streak", async () => {
    const w = await workspace();
    txt.delete(w.rec.name);
    const t1 = w.t0 + 7 * H;
    // first failure: a DNS blip is no news
    expect(await recheck(w.id, t1)).toMatchObject({ failed: 1, notices: 0 });
    expect(mails).toHaveLength(0);
    // second failure in a row: one early warning per owner/admin, in their language, while the page is still served
    expect(await recheck(w.id, t1 + 12 * H)).toMatchObject({ failed: 1, withdrawn: 0, notices: 3 });
    expect(sent(mails)).toEqual(to(w.owner, w.admin, w.adminZh));
    const zh = mails.find((m) => m.to === w.adminZh.email)!;
    expect(zh.subject).toBe(`自定义域名 DNS 校验失败：${w.domain}`);
    expect(mails.find((m) => m.to === w.admin.email)!.subject).toBe(`Custom domain failing its DNS check: ${w.domain}`);
    expect(mails.find((m) => m.to === w.admin.email)!.text).toContain(`_montral-challenge.${w.domain}`);
    expect(mails.some((m) => m.text.includes(w.rec.value) || m.html.includes(w.rec.value))).toBe(false); // the TXT value is not repeated
    mails.length = 0;
    // third failure (still within 24 h): nothing new
    expect(await recheck(w.id, t1 + 24 * H - 60_000)).toMatchObject({ failed: 1, withdrawn: 0, notices: 0 });
    expect(mails).toHaveLength(0);
    // withdrawal: one email per owner/admin, none for the member
    expect(await recheck(w.id, t1 + 24 * H - 60_000 + DOMAIN_RECHECK.failingMs)).toMatchObject({ withdrawn: 1, notices: 3 });
    expect(sent(mails)).toEqual(to(w.owner, w.admin, w.adminZh));
    expect(mails.every((m) => m.to !== w.member.email)).toBe(true);
    expect(mails.find((m) => m.to === w.admin.email)!.subject).toBe(`Custom domain withdrawn: ${w.domain}`);
    expect(mails.find((m) => m.to === w.adminZh.email)!.subject).toBe(`自定义域名已撤销：${w.domain}`);
    expect(mails.find((m) => m.to === w.owner.email)!.text).toContain(`${origin}/app/status-pages/${w.id}`);
    const withdrawn = await rows(w.id, "domain.withdrawn");
    expect(withdrawn.map((r) => r.target_user_id).sort()).toEqual([w.owner.id, w.admin.id, w.adminZh.id].sort());
    expect(withdrawn.every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    expect((await rows(w.id, "domain.failing")).every((r) => r.status === "sent")).toBe(true);
    // the audit event stays, once
    expect(await q("SELECT 1 FROM audit_event WHERE target_id = $1 AND action = 'status_page.domain.withdrawn'", [w.id])).toHaveLength(1);
    mails.length = 0;

    // re-checking an already withdrawn domain: not claimed, no email; queuing the same withdrawal again inserts nothing
    expect(await recheck(w.id, t1 + 48 * H)).toMatchObject({ checked: 0, notices: 0 });
    const [{ since }] = await q<{ since: Date }>("SELECT custom_domain_failing_since AS since FROM status_page WHERE id = $1", [w.id]);
    expect(await queueDomainNotices(q, { pageId: w.id, kind: "domain.withdrawn", domain: w.domain, streakSince: since })).toEqual([]);
    expect(await deliverDomainNotices(q, { pageIds: [w.id] })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(mails).toHaveLength(0);
    expect(await rows(w.id, "domain.withdrawn")).toHaveLength(3);
  });

  it("servers re-checking at the same moment withdraw once and email each admin once", async () => {
    const w = await workspace();
    txt.delete(w.rec.name);
    const t1 = w.t0 + 7 * H;
    for (const dt of [0, 12 * H, 23 * H]) await recheck(w.id, t1 + dt);
    mails.length = 0;
    const at = t1 + 24 * H;
    const results = await Promise.all([recheck(w.id, at), recheck(w.id, at), recheck(w.id, at)]);
    expect(results.reduce((n, r) => n + r.withdrawn, 0)).toBe(1);
    expect(sent(mails.filter((m) => m.subject.includes("withdrawn") || m.subject.includes("撤销")))).toEqual(to(w.owner, w.admin, w.adminZh));
  });

  it("a notice the mail server refuses is retried by the delivery machinery, and skipped once it no longer applies", async () => {
    const w = await workspace();
    txt.delete(w.rec.name);
    const t1 = w.t0 + 7 * H;
    await recheck(w.id, t1);
    failNext = 3; // the three early warnings are refused once
    await recheck(w.id, t1 + 12 * H);
    expect(mails).toHaveLength(0);
    let failing = await rows(w.id, "domain.failing");
    expect(failing).toHaveLength(3);
    expect(failing.every((r) => r.status === "pending" && r.attempts === 1 && r.next_attempt_at !== null)).toBe(true);
    expect(failing[0].status_message).toMatch(/^failed: email not accepted \(attempt 1 of 3, trying again in 60 s\)$/);
    expect(JSON.stringify(failing)).not.toContain("someone@example.test"); // provider detail never reaches the log
    // not due yet: nothing is sent
    expect(await deliverDomainNotices(q, { pageIds: [w.id] })).toMatchObject({ sent: 0 });
    // the admin is demoted before the retry: their notice is skipped, the others go out
    await q("UPDATE member SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [w.org, w.admin.id]);
    await q("UPDATE alert_delivery SET next_attempt_at = now() - interval '1 second' WHERE status_page_id = $1", [w.id]);
    expect(await deliverDomainNotices(q, { pageIds: [w.id] })).toEqual({ sent: 2, failed: 0, skipped: 1 });
    expect(sent(mails)).toEqual(to(w.owner, w.adminZh));
    failing = await rows(w.id, "domain.failing");
    expect(failing.find((r) => r.target_user_id === w.admin.id)).toMatchObject({ status: "skipped" });
    expect(failing.filter((r) => r.status === "sent").every((r) => r.attempts === 2)).toBe(true);
  });

  it("a failure to queue notices never blocks or undoes the withdrawal", async () => {
    const w = await workspace();
    txt.delete(w.rec.name);
    const t1 = w.t0 + 7 * H;
    for (const dt of [0, 12 * H, 23 * H]) await recheck(w.id, t1 + dt);
    const broken = <T,>(sql: string, params?: unknown[]) =>
      /INSERT INTO alert_delivery/.test(sql) ? Promise.reject(new Error("queue unavailable")) : q<T>(sql, params);
    expect(await recheck(w.id, t1 + 24 * H, broken)).toMatchObject({ withdrawn: 1, notices: 0 });
    expect((await q<{ verified: Date | null }>("SELECT custom_domain_verified_at AS verified FROM status_page WHERE id = $1", [w.id]))[0].verified).toBeNull();
    expect(await rows(w.id, "domain.withdrawn")).toHaveLength(0);
  });
});
