import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-audit-e2e-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};

type Res = { status: number; body: any; text: string; headers: Headers; cookie: string };

/**
 * Workspace audit log on real PostgreSQL: what is recorded (actor, target, field names), what never is (channel
 * webhook URLs, status page passwords, API key values, share-link and inbox secrets), who may read it, tenant
 * isolation, keyset pagination, the append-only trigger, retention pruning and the CSV / JSON Lines export.
 */
describe.skipIf(!url)("workspace audit log (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 4 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  const q = <T,>(sql: string, params?: unknown[]) => database!.query<T>(sql, params);
  beforeAll(async () => { await migrateMontralSchema(database!, montralEdition); });
  afterAll(async () => { await database?.close(1); });

  async function call(path: string, init: { method?: string; body?: unknown; cookie?: string; key?: string } = {}): Promise<Res> {
    const headers: Record<string, string> = { origin, "content-type": "application/json" };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.key) headers["x-api-key"] = init.key;
    const r = await app.fetch(new Request(origin + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env as never);
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* CSV / JSONL */ }
    return { status: r.status, body, text, headers: r.headers, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  }
  async function signUp(name: string) {
    const email = `audit-${name}-${crypto.randomUUID()}@example.com`;
    const r = await call("/api/auth/sign-up/email", { method: "POST", body: { email, name, password: "correct horse battery staple" } });
    expect(r.status).toBe(200);
    await q(`update "user" set email_verified = true where id = $1`, [r.body.user.id]);
    const login = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: "correct horse battery staple" } });
    expect(login.status).toBe(200);
    const me = await call("/api/me", { cookie: login.cookie });
    return { email, id: r.body.user.id as string, cookie: login.cookie, orgId: me.body.organization.id as string, projectId: me.body.projectId as string };
  }
  const rowsOf = (orgId: string) => q<Record<string, unknown>>("SELECT * FROM audit_event WHERE organization_id = $1 ORDER BY created_at, id", [orgId]);
  const heartbeat = (name: string) => ({ name, type: "heartbeat", intervalSec: 3600 });

  // ── one workspace with a representative history ──────────────────────────────────────────────────────────────────
  const WEBHOOK_SECRET = `audit-webhook-secret-${crypto.randomUUID()}`;
  const WEBHOOK_URL = `https://discord.com/api/webhooks/123/${WEBHOOK_SECRET}`;
  const PAGE_PASSWORD = `page-password-${crypto.randomUUID().slice(0, 12)}`;
  let owner: Awaited<ReturnType<typeof signUp>>;
  let apiKey = "";
  let apiKeyId = "";
  let shareUrl = "";
  let inboxPath = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    owner = await signUp("owner");
    const c = owner.cookie;
    const monitor = await call("/api/monitors", { method: "POST", cookie: c, body: heartbeat("Audit API") });
    expect(monitor.status).toBe(201);
    ids.monitor = monitor.body.id;
    expect((await call(`/api/monitors/${ids.monitor}`, { method: "PATCH", cookie: c, body: { name: "Audit API v2", paused: true } })).status).toBe(200);
    const doomed = await call("/api/monitors", { method: "POST", cookie: c, body: heartbeat("Doomed") });
    ids.doomed = doomed.body.id;
    expect((await call(`/api/monitors/${ids.doomed}`, { method: "DELETE", cookie: c })).status).toBe(204);

    const channel = await call("/api/channels", { method: "POST", cookie: c, body: { type: "discord", name: "Ops Discord", config: { url: WEBHOOK_URL } } });
    expect(channel.status).toBe(201);
    ids.channel = channel.body.id;
    expect((await call(`/api/channels/${ids.channel}`, { method: "PATCH", cookie: c, body: { name: "Ops", config: { url: `${WEBHOOK_URL}-rotated` } } })).status).toBe(200);
    expect((await call(`/api/channels/${ids.channel}`, { method: "DELETE", cookie: c })).status).toBe(204);

    const slug = `audit-${crypto.randomUUID().slice(0, 8)}`;
    const page = await call("/api/status-pages", { method: "POST", cookie: c, body: { slug, title: "Audit status", visibility: "password", password: PAGE_PASSWORD } });
    expect(page.status).toBe(201);
    ids.page = page.body.id;
    expect((await call(`/api/status-pages/${ids.page}`, { method: "PATCH", cookie: c, body: { password: `${PAGE_PASSWORD}-2`, title: "Audit status 2" } })).status).toBe(200);
    expect((await call(`/api/status-pages/${ids.page}/access/revoke`, { method: "POST", cookie: c })).status).toBe(200);
    const link = await call(`/api/status-pages/${ids.page}/share-links`, { method: "POST", cookie: c, body: { label: "Partner" } });
    expect(link.status).toBe(201);
    ids.link = link.body.id;
    shareUrl = link.body.url;
    expect((await call(`/api/status-pages/${ids.page}/share-links/${ids.link}`, { method: "DELETE", cookie: c })).status).toBe(204);
    expect((await call(`/api/status-pages/${ids.page}/domain`, { method: "PUT", cookie: c, body: { domain: `status-${slug}.example.com` } })).status).toBe(200);
    expect((await call(`/api/status-pages/${ids.page}/domain`, { method: "DELETE", cookie: c })).status).toBe(204);

    const incident = await call("/api/incidents", { method: "POST", cookie: c, body: { title: "Audit outage", body: "internal details" } });
    expect(incident.status).toBe(201);
    ids.incident = incident.body.id;
    expect((await call(`/api/incidents/${ids.incident}/updates`, { method: "POST", cookie: c, body: { status: "resolved", body: "fixed" } })).status).toBe(201);

    const start = new Date(Date.now() + 86400_000);
    const window = await call("/api/maintenance", { method: "POST", cookie: c, body: { name: "Audit window", startsAt: start.toISOString(), endsAt: new Date(+start + 3600_000).toISOString() } });
    expect(window.status).toBe(201);
    ids.maintenance = window.body.id;
    expect((await call(`/api/maintenance/${ids.maintenance}`, { method: "DELETE", cookie: c })).status).toBe(204);
    // repeats and unknown ids still succeed (idempotent) but change nothing, so they are not recorded
    expect((await call(`/api/maintenance/${ids.maintenance}`, { method: "DELETE", cookie: c })).status).toBe(204);
    expect((await call(`/api/maintenance/${crypto.randomUUID()}/end`, { method: "POST", cookie: c })).status).toBe(200);
    expect((await call(`/api/maintenance/series/${crypto.randomUUID()}`, { method: "DELETE", cookie: c })).status).toBe(204);

    const inbox = await call("/api/hooks/inboxes", { method: "POST", cookie: c, body: { name: "Audit inbox" } });
    expect(inbox.status).toBe(201);
    ids.inbox = inbox.body.id;
    inboxPath = inbox.body.path;
    expect((await call(`/api/hooks/inboxes/${ids.inbox}`, { method: "DELETE", cookie: c })).status).toBe(204);

    // an API key (named like a spreadsheet formula, within the 32-character name limit) that then acts on its own
    const key = await call("/api/auth/api-key/create", { method: "POST", cookie: c, body: { name: '=HYPERLINK("http://e.x","x")', metadata: { organizationId: owner.orgId } } });
    expect(key.status).toBe(200);
    apiKey = key.body.key;
    apiKeyId = key.body.id;
    expect(apiKey).toMatch(/^montral_/);
    const viaKey = await call("/api/monitors", { method: "POST", key: apiKey, body: heartbeat("Created by key") });
    expect(viaKey.status).toBe(201);
    ids.keyMonitor = viaKey.body.id;
  });

  it("records representative actions with the right actor, target and changed field names", async () => {
    const rows = await rowsOf(owner.orgId);
    const actions = rows.map((r) => r.action);
    for (const a of [
      "monitor.create", "monitor.update", "monitor.delete", "channel.create", "channel.update", "channel.delete",
      "status_page.create", "status_page.update", "status_page.access.revoke", "status_page.share_link.create", "status_page.share_link.revoke",
      "status_page.domain.set", "status_page.domain.remove", "incident.create", "incident.resolve", "maintenance.create", "maintenance.delete",
      "hook_inbox.create", "hook_inbox.delete", "api_key.create",
    ]) expect(actions, a).toContain(a);

    const one = (action: string, targetId?: string) => rows.find((r) => r.action === action && (!targetId || r.target_id === targetId))!;
    expect(one("monitor.update", ids.monitor)).toMatchObject({
      actor_type: "user", actor_id: owner.id, actor_label: owner.email, target_type: "monitor", target_id: ids.monitor, project_id: owner.projectId,
      changes: { fields: expect.arrayContaining(["name", "paused"]), values: expect.objectContaining({ name: "Audit API v2", paused: true }) },
    });
    expect(rows.filter((r) => String(r.action).startsWith("maintenance."))).toHaveLength(2);
    expect(one("maintenance.delete", ids.maintenance)).toMatchObject({ target_type: "maintenance", project_id: owner.projectId });
    expect(one("monitor.delete", ids.doomed)).toMatchObject({ target_type: "monitor", changes: { values: { name: "Doomed" } } });
    expect(one("channel.update", ids.channel)).toMatchObject({ target_type: "channel", changes: { fields: ["config", "name"], values: { name: "Ops" } } });
    expect(JSON.stringify(one("channel.update", ids.channel).changes)).not.toContain("discord");
    expect(one("status_page.update", ids.page)).toMatchObject({ changes: { fields: ["password", "title"] } });
    expect(one("status_page.create", ids.page)).toMatchObject({ changes: { values: { visibility: "password" } } });
    expect(one("status_page.share_link.create", ids.link)).toMatchObject({ target_type: "status_page_share_link" });
    expect(one("api_key.create")).toMatchObject({ actor_type: "user", actor_id: owner.id, target_type: "api_key", target_id: apiKeyId, project_id: null });
    // the key's own action names the key, by id and by its name at the time
    expect(one("monitor.create", ids.keyMonitor)).toMatchObject({ actor_type: "api_key", actor_id: apiKeyId, actor_label: '=HYPERLINK("http://e.x","x")' });
    // no client address can be told without a trusted proxy (Node, TRUST_PROXY unset)
    expect(rows.every((r) => r.ip === null)).toBe(true);
  });

  it("never stores or returns a channel webhook URL, a page password, an API key or a share-link / inbox secret", async () => {
    const secrets = [WEBHOOK_SECRET, PAGE_PASSWORD, apiKey, shareUrl.split("t=")[1]!, inboxPath.split("/").pop()!];
    for (const s of secrets) expect(s.length).toBeGreaterThan(10);
    const stored = JSON.stringify(await rowsOf(owner.orgId));
    const listed = (await call("/api/audit-events?limit=200", { cookie: owner.cookie })).text;
    const csv = (await call("/api/audit-events/export?format=csv", { cookie: owner.cookie })).text;
    const jsonl = (await call("/api/audit-events/export?format=jsonl", { cookie: owner.cookie })).text;
    for (const text of [stored, listed, csv, jsonl]) {
      for (const s of secrets) expect(text).not.toContain(s);
      expect(text).not.toContain("discord.com/api/webhooks");
      expect(text).not.toContain("internal details");
    }
  });

  it("is for owners and admins: a member gets 403 until promoted, and member changes are recorded", async () => {
    const member = await signUp("member");
    const invite = await call("/api/auth/organization/invite-member", { method: "POST", cookie: owner.cookie, body: { organizationId: owner.orgId, email: member.email, role: "member" } });
    expect(invite.status).toBe(200);
    expect((await call("/api/auth/organization/accept-invitation", { method: "POST", cookie: member.cookie, body: { invitationId: invite.body.id } })).status).toBe(200);
    const active = await call("/api/auth/organization/set-active", { method: "POST", cookie: member.cookie, body: { organizationId: owner.orgId } });
    expect(active.status).toBe(200);
    const cookie = active.cookie || member.cookie;
    expect((await call("/api/me", { cookie })).body.organization.id).toBe(owner.orgId);
    for (const path of ["/api/audit-events", "/api/audit-events/export?format=csv", "/api/audit-events/export?format=jsonl"]) {
      const r = await call(path, { cookie });
      expect(r.status, path).toBe(403);
      expect(r.headers.get("cache-control"), path).toBe("private, no-store");
      expect(r.text).not.toContain(owner.email);
    }
    const [m] = await q<{ id: string }>("SELECT id FROM member WHERE organization_id = $1 AND user_id = $2", [owner.orgId, member.id]);
    expect((await call("/api/auth/organization/update-member-role", { method: "POST", cookie: owner.cookie, body: { organizationId: owner.orgId, memberId: m.id, role: "admin" } })).status).toBe(200);
    const asAdmin = await call("/api/audit-events?action=member", { cookie });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(["member.invite", "member.role_change"]));
    const roleChange = asAdmin.body.events.find((e: any) => e.action === "member.role_change");
    expect(roleChange).toMatchObject({ actorId: owner.id, actorLabel: owner.email, targetType: "member", targetId: m.id, changes: { fields: ["role"], values: { role: "admin" } } });
    const invited = asAdmin.body.events.find((e: any) => e.action === "member.invite");
    expect(invited).toMatchObject({ targetType: "invitation", targetId: invite.body.id, changes: { fields: ["email", "role"], values: { role: "member" } } });
    expect(JSON.stringify(asAdmin.body)).not.toContain(member.email); // the invitee's address is not kept
    expect((await call("/api/auth/organization/remove-member", { method: "POST", cookie: owner.cookie, body: { organizationId: owner.orgId, memberIdOrEmail: member.email } })).status).toBe(200);
    const removed = await call(`/api/audit-events?action=member.remove&targetId=${m.id}`, { cookie: owner.cookie });
    expect(removed.body.events).toHaveLength(1);
    expect(removed.body.events[0]).toMatchObject({ targetType: "member", changes: { values: { role: "admin" } } });
  });

  it("records an admin removing themselves and a member leaving", async () => {
    const join = async (name: string, role: "admin" | "member") => {
      const u = await signUp(name);
      const invite = await call("/api/auth/organization/invite-member", { method: "POST", cookie: owner.cookie, body: { organizationId: owner.orgId, email: u.email, role } });
      expect((await call("/api/auth/organization/accept-invitation", { method: "POST", cookie: u.cookie, body: { invitationId: invite.body.id } })).status).toBe(200);
      const active = await call("/api/auth/organization/set-active", { method: "POST", cookie: u.cookie, body: { organizationId: owner.orgId } });
      const [m] = await q<{ id: string }>("SELECT id FROM member WHERE organization_id = $1 AND user_id = $2", [owner.orgId, u.id]);
      return { ...u, cookie: active.cookie || u.cookie, memberId: m.id };
    };
    const admin = await join("self-admin", "admin");
    expect((await call("/api/auth/organization/remove-member", { method: "POST", cookie: admin.cookie, body: { organizationId: owner.orgId, memberIdOrEmail: admin.memberId } })).status).toBe(200);
    const leaver = await join("leaver", "member");
    expect((await call("/api/auth/organization/leave", { method: "POST", cookie: leaver.cookie, body: { organizationId: owner.orgId } })).status).toBe(200);
    const rows = await rowsOf(owner.orgId);
    expect(rows.find((r) => r.action === "member.remove" && r.target_id === admin.memberId)).toMatchObject({ actor_id: admin.id, actor_label: admin.email, changes: { values: { role: "admin" } } });
    expect(rows.find((r) => r.action === "member.leave" && r.target_id === leaver.memberId)).toMatchObject({ actor_id: leaver.id, actor_label: leaver.email, changes: { values: { role: "member" } } });
    // someone who is not a member of the workspace cannot write a leave into its log
    const outsider = await signUp("outsider");
    await call("/api/auth/organization/leave", { method: "POST", cookie: outsider.cookie, body: { organizationId: owner.orgId } });
    expect((await rowsOf(owner.orgId)).some((r) => r.actor_id === outsider.id)).toBe(false);
  });

  it("revoking an API key is recorded against the key's workspace", async () => {
    const key = await call("/api/auth/api-key/create", { method: "POST", cookie: owner.cookie, body: { name: "short-lived", metadata: { organizationId: owner.orgId } } });
    expect((await call("/api/auth/api-key/delete", { method: "POST", cookie: owner.cookie, body: { keyId: key.body.id } })).status).toBe(200);
    const r = await call(`/api/audit-events?targetType=api_key&targetId=${key.body.id}`, { cookie: owner.cookie });
    expect(r.body.events.map((e: any) => e.action)).toEqual(["api_key.revoke", "api_key.create"]);
    expect(r.text).not.toContain(key.body.key);
  });

  it("keeps workspaces apart: another workspace sees none of these events, whatever it filters by", async () => {
    const other = await signUp("other");
    await call("/api/monitors", { method: "POST", cookie: other.cookie, body: heartbeat("Other workspace") });
    const mine = (await call("/api/audit-events?limit=200", { cookie: other.cookie })).body.events as any[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.actorId === other.id)).toBe(true);
    const ownerEventIds = new Set((await rowsOf(owner.orgId)).map((r) => r.id));
    expect(mine.some((e) => ownerEventIds.has(e.id))).toBe(false);
    for (const query of [`targetId=${ids.monitor}`, `actorId=${owner.id}`, `actorId=${apiKeyId}`, `targetType=status_page&targetId=${ids.page}`, "action=api_key"]) {
      const r = await call(`/api/audit-events?${query}`, { cookie: other.cookie });
      expect(r.status, query).toBe(200);
      expect(r.body.events, query).toEqual([]);
    }
    const exported = (await call(`/api/audit-events/export?format=jsonl&actorId=${owner.id}`, { cookie: other.cookie })).text;
    expect(exported).toBe("");
    // a cursor from the other workspace's page only moves within the caller's own workspace
    const page = await call("/api/audit-events?limit=1", { cookie: owner.cookie });
    const crossed = await call(`/api/audit-events?cursor=${page.body.next}`, { cookie: other.cookie });
    expect(crossed.status).toBe(200);
    expect(crossed.body.events.every((e: any) => !ownerEventIds.has(e.id))).toBe(true);
  });

  it("pages newest first with a stable cursor: no event is skipped or repeated", async () => {
    const all = (await call("/api/audit-events?limit=200", { cookie: owner.cookie })).body.events as any[];
    expect(all.length).toBeGreaterThan(10);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const r: Res = await call(`/api/audit-events?limit=3${cursor ? `&cursor=${cursor}` : ""}`, { cookie: owner.cookie });
      expect(r.status).toBe(200);
      seen.push(...r.body.events.map((e: any) => e.id));
      cursor = r.body.next;
      if (!cursor) break;
    }
    expect(seen).toEqual(all.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
    const times = all.map((e) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await call("/api/audit-events?cursor=not-a-cursor", { cookie: owner.cookie })).status).toBe(400);
    expect((await call("/api/audit-events?unknown=1", { cookie: owner.cookie })).status).toBe(400);
    // filters: an action prefix, and a time window that ends before everything
    const domain = (await call("/api/audit-events?action=status_page.domain", { cookie: owner.cookie })).body.events as any[];
    expect(domain.map((e) => e.action).sort()).toEqual(["status_page.domain.remove", "status_page.domain.set"]);
    expect((await call(`/api/audit-events?to=${encodeURIComponent("2000-01-01T00:00:00Z")}`, { cookie: owner.cookie })).body.events).toEqual([]);
  });

  it("is append-only in the database: UPDATE, DELETE and TRUNCATE are refused, even with a forged prune setting", async () => {
    const [row] = await q<{ id: string }>("SELECT id FROM audit_event WHERE organization_id = $1 LIMIT 1", [owner.orgId]);
    await expect(q("UPDATE audit_event SET action = 'monitor.create' WHERE id = $1", [row.id])).rejects.toThrow(/append-only/);
    await expect(q("UPDATE audit_event SET changes = NULL WHERE organization_id = $1", [owner.orgId])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM audit_event WHERE id = $1", [row.id])).rejects.toThrow(/append-only/);
    await expect(q("TRUNCATE audit_event")).rejects.toThrow(/append-only/);
    // the prune setting only lets rows older than a cutoff at least 30 days back through
    const org = owner.orgId.replace(/'/g, "");
    await expect(q(`DO $t$ BEGIN PERFORM set_config('montral.audit_prune_before', extract(epoch FROM now())::text, true); DELETE FROM audit_event WHERE organization_id = '${org}'; END $t$`)).rejects.toThrow(/append-only/);
    // a session's temporary tables cannot stand in for the real ones (the guard is schema-qualified, search_path pinned)
    await expect(q(`DO $t$ BEGIN CREATE TEMP TABLE organization (id text); DELETE FROM audit_event WHERE id = '${row.id}'; END $t$`)).rejects.toThrow(/append-only/);
    await expect(q(`DO $t$ BEGIN CREATE TEMP TABLE organization (id text); CREATE TEMP TABLE audit_event (id uuid, created_at timestamptz); DELETE FROM public.audit_event WHERE id = '${row.id}'; END $t$`)).rejects.toThrow(/append-only/);
    expect((await q<{ id: string }>("SELECT id FROM audit_event WHERE id = $1", [row.id]))).toHaveLength(1);
  });

  it("retention prunes only events older than the cutoff, in bounded batches, and refuses a cutoff under 30 days", async () => {
    const ws = await signUp("retention");
    const insert = (action: string, age: string) =>
      q(`INSERT INTO audit_event (organization_id, actor_type, action, target_type, created_at) VALUES ($1, 'system', $2, 'test', now() - $3::interval)`, [ws.orgId, action, age]);
    for (const a of ["test.ancient", "test.ancient", "test.ancient"]) await insert(a, "400 days");
    await insert("test.old", "200 days");
    await insert("test.month_plus", "31 days");
    await insert("test.month_minus", "29 days");
    await insert("test.recent", "1 day");
    const actions = async () => (await rowsOf(ws.orgId)).map((r) => r.action as string);
    await expect(q("SELECT montral_prune_audit(interval '10 days')")).rejects.toThrow(/at least 30 days/);
    // the floor is exact: just under 30 days is refused, 30 days is allowed
    await expect(q("SELECT montral_prune_audit(interval '29 days 23:59:59')")).rejects.toThrow(/at least 30 days/);
    await expect(database!.repo.pruneAuditEvents!(10)).rejects.toThrow();
    await expect(database!.repo.pruneAuditEvents!(29)).rejects.toThrow();
    // bounded: one row per statement, two statements, so one of the three ancient rows is left for the next run
    expect(await database!.repo.pruneAuditEvents!(365, { batch: 1, maxBatches: 2 })).toBe(2);
    expect((await actions()).filter((a) => a === "test.ancient")).toHaveLength(1);
    expect(await database!.repo.pruneAuditEvents!(365)).toBeGreaterThanOrEqual(1);
    expect(await actions()).not.toContain("test.ancient");
    expect(await actions()).toEqual(expect.arrayContaining(["test.old", "test.month_plus", "test.month_minus", "test.recent"]));
    // the owner's real history is untouched
    expect((await rowsOf(owner.orgId)).length).toBeGreaterThan(10);
    await q("SELECT montral_prune_audit(interval '100 days')");
    expect(await actions()).not.toContain("test.old");
    await q("SELECT montral_prune_audit(interval '30 days')");
    expect((await actions()).sort()).toEqual(["test.month_minus", "test.recent"]);
  });

  it("a forged prune cutoff only reaches rows past the 30-day floor", async () => {
    const ws = await signUp("forged");
    const org = ws.orgId.replace(/'/g, "");
    await q(`INSERT INTO audit_event (organization_id, actor_type, action, target_type, created_at) VALUES ($1, 'system', 'test.forty_days', 'test', now() - interval '40 days')`, [ws.orgId]);
    const forged = (cutoffAge: string) =>
      q(`DO $t$ BEGIN PERFORM set_config('montral.audit_prune_before', extract(epoch FROM now() - interval '${cutoffAge}')::text, true); DELETE FROM audit_event WHERE organization_id = '${org}'; END $t$`);
    // a cutoff just inside the floor (29 days 23 h) lets nothing through
    await expect(forged("29 days 23 hours")).rejects.toThrow(/append-only/);
    expect(await rowsOf(ws.orgId)).toHaveLength(1);
    // a cutoff just past it (30 days and a minute) reaches the 40-day-old row
    await forged("30 days 1 minute");
    expect(await rowsOf(ws.orgId)).toHaveLength(0);
  });

  it("deleting a workspace removes its audit events through the cascade", async () => {
    const ws = await signUp("gone");
    await call("/api/monitors", { method: "POST", cookie: ws.cookie, body: heartbeat("Short-lived") });
    expect((await rowsOf(ws.orgId)).length).toBeGreaterThan(0);
    await database!.repo.deleteWorkspaces([ws.orgId]);
    expect(await rowsOf(ws.orgId)).toEqual([]);
  });

  it("exports CSV with formula cells neutralised, and JSON Lines with one event per line", async () => {
    const csv = await call("/api/audit-events/export?format=csv", { cookie: owner.cookie });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="montral-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(csv.headers.get("cache-control")).toBe("private, no-store");
    const lines = csv.text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("created_at,id,action,actor_type,actor_id,actor_label,target_type,target_id,project_id,ip,changes");
    // the API key named =HYPERLINK(...) is exported as text, quoted and prefixed with an apostrophe
    expect(csv.text).toContain(`"'=HYPERLINK(""http://e.x"",""x"")"`);
    expect(csv.text).not.toMatch(/(^|,)=HYPERLINK/m);
    const listed = (await call("/api/audit-events?limit=200", { cookie: owner.cookie })).body.events as any[];
    expect(lines.length - 1).toBe(listed.length);

    const jsonl = await call("/api/audit-events/export?format=jsonl&action=monitor", { cookie: owner.cookie });
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
    const events = jsonl.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.action.startsWith("monitor."))).toBe(true);
    expect(events.map((e) => e.id)).toEqual(listed.filter((e) => e.action.startsWith("monitor.")).map((e) => e.id));
    expect((await call("/api/audit-events/export?format=xml", { cookie: owner.cookie })).status).toBe(400);
    // exporting is recorded: the format and the filter names, not their values
    await call(`/api/audit-events/export?format=jsonl&actorId=${owner.id}&targetType=monitor`, { cookie: owner.cookie });
    const exports = (await call("/api/audit-events?action=audit.export&limit=1", { cookie: owner.cookie })).body.events as any[];
    expect(exports[0]).toMatchObject({ actorId: owner.id, targetType: "audit_log", projectId: null, changes: { fields: ["actorId", "targetType"], values: { format: "jsonl" } } });
    expect(JSON.stringify(exports[0].changes)).not.toContain(owner.id);
  });

  it("is not available to an API key limited to some projects", async () => {
    const key = await call("/api/auth/api-key/create", { method: "POST", cookie: owner.cookie, body: { name: "limited", metadata: { organizationId: owner.orgId, projectIds: [owner.projectId] } } });
    for (const path of ["/api/audit-events", "/api/audit-events/export?format=csv", "/api/audit-events/export?format=jsonl"]) {
      const r = await call(path, { key: key.body.key });
      expect(r.status, path).toBe(403);
      expect(r.text, path).not.toContain(owner.email);
    }
    // an unrestricted key of an owner reads it, like the owner
    expect((await call("/api/audit-events?limit=1", { key: apiKey })).status).toBe(200);
  });
});
