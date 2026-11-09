import { openDatabase } from "@montral/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryDeliveries, sendEscalations } from "./alerts";
import { createApp } from "./app";
import { setMailTransport } from "./email";
import { unmetered } from "./entitlements";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "oncall-test-secret-not-for-production-0123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  EMAIL_FROM: "alerts@example.com",
};

type Res = { status: number; body: any; cookie: string };

describe.skipIf(!url)("on-call schedules and escalation (PostgreSQL)", () => {
  const app = createApp(openDatabase);
  const db = openDatabase(url ?? "postgres://unused", { max: 4 });
  // a second connection pool: a second server racing the first for the same escalation step
  const db2 = openDatabase(url ?? "postgres://unused", { max: 4 });
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  let failMailTo: string | null = null;
  beforeAll(async () => {
    await db.migrate();
    setMailTransport(async (m) => {
      if (failMailTo && m.to === failMailTo) throw new Error("synthetic SMTP outage");
      sent.push(m);
    });
  });
  afterAll(async () => {
    setMailTransport(undefined);
    await db.close(1);
    await db2.close(1);
  });

  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const call = async (cookie: string, method: string, path: string, body?: unknown): Promise<Res> => {
    const r = await raw(`/api${path}`, { method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  };
  const viaKey = async (key: string, method: string, path: string, body?: unknown): Promise<Res> => {
    const r = await raw(`/api${path}`, { method, headers: { "x-api-key": key, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any, cookie: "" };
  };
  const apiKeyOf = async (cookie: string, orgId: string) => {
    const r = await call(cookie, "POST", "/auth/api-key/create", { name: "oncall-test", metadata: { organizationId: orgId } });
    expect(r.status).toBe(200);
    return r.body.key as string;
  };
  async function signup(name: string) {
    const email = `oncall-${name.toLowerCase().replace(/\W/g, "")}-${crypto.randomUUID()}@example.com`;
    const r = await call("", "POST", "/auth/sign-up/email", { email, name, password: "correct horse battery" });
    expect(r.status).toBe(200);
    await db.query(`update "user" set email_verified = true where id = $1`, [r.body.user.id]);
    const login = await call("", "POST", "/auth/sign-in/email", { email, password: "correct horse battery" });
    expect(login.status).toBe(200);
    return { email, id: r.body.user.id as string, cookie: login.cookie, name };
  }
  /** An owner and a plain member of one workspace, plus an outsider who owns another workspace. */
  async function team() {
    const owner = await signup("Olive Owner");
    const member = await signup("Max Member");
    const outsider = await signup("Otto Outsider");
    const me = (await call(owner.cookie, "GET", "/me")).body;
    const orgId = me.organization.id as string;
    const invite = await call(owner.cookie, "POST", "/auth/organization/invite-member", { organizationId: orgId, email: member.email, role: "member" });
    expect(invite.status).toBe(200);
    expect((await call(member.cookie, "POST", "/auth/organization/accept-invitation", { invitationId: invite.body.id })).status).toBe(200);
    const active = await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId });
    expect(active.status).toBe(200);
    member.cookie = active.cookie || member.cookie;
    return { owner, member, outsider, orgId, projectId: me.projectId as string };
  }
  const layer = (userIds: string[], extra: Record<string, unknown> = {}) => ({ name: "Primary rotation", userIds, rotationType: "daily", handoffTime: "00:00", startDate: "2020-01-01", ...extra });
  const deliveries = (incidentId: string) => db.query<{ target_user_id: string | null; channel_type: string; status: string; kind: string; attempts: number; id: string }>(
    `select id, target_user_id, channel_type, status, kind, attempts from alert_delivery where incident_id = $1 and kind = 'incident.escalated' order by created_at, id`, [incidentId]);
  async function autoIncident(orgId: string, projectId: string, monitorId: string) {
    const inc = await db.repo.openAutoIncident({ organizationId: orgId, monitorId, title: "Synthetic outage", auto: true }, { status: "investigating", body: "3 consecutive failed checks." });
    expect(inc).toBeTruthy();
    await db.repo.scheduleFollowUps(inc!, projectId);
    return inc!;
  }
  /** The next step is due now (instead of waiting for the step timeout). */
  const dueNow = (incidentId: string) => db.query(`update incident set next_escalation_at = now() - interval '1 second' where id = $1 and next_escalation_at is not null`, [incidentId]);
  const incidentRow = async (id: string) => (await db.query<{ escalation_level: number; next_escalation_at: Date | null; assignee_id: string | null; acknowledged_at: Date | null }>(`select escalation_level, next_escalation_at, assignee_id, acknowledged_at from incident where id = $1`, [id]))[0];

  it("schedules: CRUD, member permissions, override rules and tenant isolation", async () => {
    const { owner, member, outsider } = await team();
    // owners create; members and outsiders cannot
    const created = await call(owner.cookie, "POST", "/oncall/schedules", { name: "Platform", timeZone: "Europe/London", layers: [layer([owner.id, member.id])] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Platform", timeZone: "Europe/London", version: 1, projectId: null });
    expect(created.body.layers).toHaveLength(1);
    const id = created.body.id as string;
    expect((await call(member.cookie, "POST", "/oncall/schedules", { name: "Mine", timeZone: "UTC" })).status).toBe(403);
    expect((await call(member.cookie, "PATCH", `/oncall/schedules/${id}`, { version: 1, name: "Renamed" })).status).toBe(403);
    expect((await call(member.cookie, "DELETE", `/oncall/schedules/${id}`)).status).toBe(403);
    // validation: zone, members only, real dates, custom length
    expect((await call(owner.cookie, "POST", "/oncall/schedules", { name: "Bad", timeZone: "Mars/Base" })).status).toBe(400);
    expect((await call(owner.cookie, "POST", "/oncall/schedules", { name: "Bad", timeZone: "UTC", layers: [layer([outsider.id])] })).body.error).toMatch(/member/);
    expect((await call(owner.cookie, "POST", "/oncall/schedules", { name: "Bad", timeZone: "UTC", layers: [layer([owner.id], { startDate: "2027-02-29" })] })).status).toBe(400);
    expect((await call(owner.cookie, "POST", "/oncall/schedules", { name: "Bad", timeZone: "UTC", layers: [layer([owner.id], { rotationType: "custom" })] })).status).toBe(400);

    // people list: a signed-in member sees name, email and role; an API key only ids and names
    const people = await call(member.cookie, "GET", "/oncall/members");
    expect(people.body.find((p: any) => p.userId === owner.id)).toEqual({ userId: owner.id, name: "Olive Owner", email: owner.email, role: "owner" });
    const key = await apiKeyOf(owner.cookie, (await call(owner.cookie, "GET", "/me")).body.organization.id);
    const byKey = await viaKey(key, "GET", "/oncall/members");
    expect(byKey.status).toBe(200);
    expect(byKey.body.find((p: any) => p.userId === member.id)).toEqual({ userId: member.id, name: "Max Member" });
    expect(JSON.stringify(byKey.body)).not.toContain("@example.com");
    // members read everything, including who is on call and the shifts
    const list = await call(member.cookie, "GET", "/oncall/schedules");
    expect(list.status).toBe(200);
    expect(list.body.map((s: any) => s.id)).toEqual([id]);
    expect([owner.id, member.id]).toContain(list.body[0].onCallNow.userId);
    const shifts = await call(member.cookie, "GET", `/oncall/schedules/${id}/shifts`);
    expect(shifts.status).toBe(200);
    expect(shifts.body.shifts.length).toBeGreaterThanOrEqual(14);
    expect(shifts.body.shifts.every((s: any) => [owner.id, member.id].includes(s.userId) && s.name)).toBe(true);
    const from = new Date().toISOString();
    expect((await call(member.cookie, "GET", `/oncall/schedules/${id}/shifts?from=${from}&to=${new Date(Date.now() + 91 * 86_400_000).toISOString()}`)).status).toBe(400);
    const now = await call(member.cookie, "GET", "/oncall/now");
    expect(now.body.schedules).toEqual([expect.objectContaining({ scheduleId: id, scheduleName: "Platform", onCall: expect.objectContaining({ source: "layer" }) })]);

    // overrides: a member takes a shift for themselves, never for someone else
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call(member.cookie, "POST", `/oncall/schedules/${id}/overrides`, { userId: owner.id, startsAt: start, endsAt: end })).status).toBe(403);
    const mine = await call(member.cookie, "POST", `/oncall/schedules/${id}/overrides`, { userId: member.id, startsAt: start, endsAt: end });
    expect(mine.status).toBe(201);
    expect((await call(owner.cookie, "GET", "/oncall/now")).body.schedules[0].onCall).toMatchObject({ userId: member.id, source: "override", overrideId: mine.body.id });
    const byOwner = await call(owner.cookie, "POST", `/oncall/schedules/${id}/overrides`, { userId: member.id, startsAt: end, endsAt: new Date(Date.now() + 7_200_000).toISOString() });
    expect(byOwner.status).toBe(201);
    // the member removes their own override but not one an admin put them on
    expect((await call(member.cookie, "DELETE", `/oncall/schedules/${id}/overrides/${byOwner.body.id}`)).status).toBe(403);
    expect((await call(member.cookie, "DELETE", `/oncall/schedules/${id}/overrides/${mine.body.id}`)).status).toBe(204);
    expect((await call(owner.cookie, "DELETE", `/oncall/schedules/${id}/overrides/${byOwner.body.id}`)).status).toBe(204);
    expect((await call(owner.cookie, "POST", `/oncall/schedules/${id}/overrides`, { userId: outsider.id, startsAt: start, endsAt: end })).status).toBe(400);
    expect((await call(owner.cookie, "POST", `/oncall/schedules/${id}/overrides`, { userId: owner.id, startsAt: end, endsAt: start })).status).toBe(400);

    // another workspace sees none of it, even with the id (the outsider owns their own workspace, so is a manager there)
    for (const [method, path, body] of [
      ["GET", `/oncall/schedules/${id}`], ["GET", `/oncall/schedules/${id}/shifts`], ["GET", `/oncall/schedules/${id}/overrides`],
      ["PATCH", `/oncall/schedules/${id}`, { version: 1, name: "Stolen" }], ["DELETE", `/oncall/schedules/${id}`],
      ["POST", `/oncall/schedules/${id}/overrides`, { userId: outsider.id, startsAt: start, endsAt: end }],
      ["POST", `/oncall/schedules/${id}/layers`, { version: 1, layer: layer([outsider.id]) }],
    ] as [string, string, unknown?][]) {
      expect((await call(outsider.cookie, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await call(outsider.cookie, "GET", "/oncall/schedules")).body).toEqual([]);
    expect((await call(outsider.cookie, "GET", "/oncall/now")).body.schedules).toEqual([]);

    // layer CRUD bumps the version; delete
    const added = await call(owner.cookie, "POST", `/oncall/schedules/${id}/layers`, { version: 1, layer: layer([member.id], { name: "Business hours", restrictions: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] }) });
    expect(added.status).toBe(201);
    expect(added.body.version).toBe(2);
    const layerId = added.body.layers[1].id;
    const edited = await call(owner.cookie, "PATCH", `/oncall/schedules/${id}/layers/${layerId}`, { version: 2, handoffTime: "08:30" });
    expect(edited.body.layers[1]).toMatchObject({ id: layerId, handoffTime: "08:30", restrictions: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] });
    const removed = await call(owner.cookie, "DELETE", `/oncall/schedules/${id}/layers/${layerId}?version=3`);
    expect(removed.body.layers.map((l: any) => l.id)).toEqual([created.body.layers[0].id]);
    expect((await call(owner.cookie, "DELETE", `/oncall/schedules/${id}?version=4`)).status).toBe(204);
    expect((await call(owner.cookie, "GET", `/oncall/schedules/${id}`)).status).toBe(404);

    // every change is in the audit log
    const audit = await call(owner.cookie, "GET", "/audit-events?action=oncall&limit=50");
    const actions = audit.body.events.map((e: any) => e.action);
    for (const a of ["oncall_schedule.create", "oncall_override.create", "oncall_override.delete", "oncall_layer.create", "oncall_layer.update", "oncall_layer.delete", "oncall_schedule.delete"]) expect(actions).toContain(a);
    expect(audit.body.events.find((e: any) => e.action === "oncall_schedule.create").changes).toMatchObject({ values: { name: "Platform", timeZone: "Europe/London" } });
  });

  it("optimistic concurrency: concurrent edits never lose an update (409 on a stale version)", async () => {
    const { owner } = await team();
    const s = (await call(owner.cookie, "POST", "/oncall/schedules", { name: "Race", timeZone: "UTC", layers: [layer([owner.id])] })).body;
    const both = await Promise.all([
      call(owner.cookie, "PATCH", `/oncall/schedules/${s.id}`, { version: 1, name: "Alice's edit" }),
      call(owner.cookie, "PATCH", `/oncall/schedules/${s.id}`, { version: 1, timeZone: "Asia/Tokyo" }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = both.find((r) => r.status === 409)!;
    expect(loser.body).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    const stored = (await call(owner.cookie, "GET", `/oncall/schedules/${s.id}`)).body;
    expect(stored.version).toBe(2);
    // exactly the winner's change is stored: the loser changed nothing
    const winner = both.find((r) => r.status === 200)!.body;
    expect([stored.name, stored.timeZone]).toEqual([winner.name, winner.timeZone]);
    expect((await call(owner.cookie, "POST", `/oncall/schedules/${s.id}/layers`, { version: 1, layer: layer([owner.id]) })).status).toBe(409);
    expect((await call(owner.cookie, "DELETE", `/oncall/schedules/${s.id}?version=1`)).status).toBe(409);
    // a retry with the current version works
    expect((await call(owner.cookie, "PATCH", `/oncall/schedules/${s.id}`, { version: 2, name: "Merged" })).body).toMatchObject({ name: "Merged", version: 3 });

    const p = (await call(owner.cookie, "POST", "/escalation-policies", { name: "P", steps: [{ timeoutMin: 5, userIds: [owner.id] }] })).body;
    const pRace = await Promise.all([1, 2, 3].map((n) => call(owner.cookie, "PATCH", `/escalation-policies/${p.id}`, { version: 1, repeatCount: n })));
    expect(pRace.filter((r) => r.status === 200)).toHaveLength(1);
    expect(pRace.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it("escalation policies: validation, tenant isolation, monitor selection and schedules in use", async () => {
    const { owner, member, outsider, projectId } = await team();
    const s = (await call(owner.cookie, "POST", "/oncall/schedules", { name: "Primary", timeZone: "UTC", layers: [layer([member.id])] })).body;
    expect((await call(member.cookie, "POST", "/escalation-policies", { name: "X", steps: [{ timeoutMin: 5, userIds: [member.id] }] })).status).toBe(403);
    expect((await call(owner.cookie, "POST", "/escalation-policies", { name: "Empty step", steps: [{ timeoutMin: 5 }] })).status).toBe(400);
    expect((await call(owner.cookie, "POST", "/escalation-policies", { name: "Stranger", steps: [{ timeoutMin: 5, userIds: [outsider.id] }] })).status).toBe(400);
    const theirSchedule = (await call(outsider.cookie, "POST", "/oncall/schedules", { name: "Theirs", timeZone: "UTC", layers: [layer([outsider.id])] })).body;
    expect((await call(owner.cookie, "POST", "/escalation-policies", { name: "Cross", steps: [{ timeoutMin: 5, scheduleIds: [theirSchedule.id] }] })).status).toBe(400);
    const policy = await call(owner.cookie, "POST", "/escalation-policies", { name: "Sev1", repeatCount: 1, steps: [{ timeoutMin: 5, scheduleIds: [s.id] }, { timeoutMin: 10, userIds: [owner.id] }] });
    expect(policy.status).toBe(201);
    expect(policy.body).toMatchObject({ name: "Sev1", repeatCount: 1, version: 1, steps: [{ timeoutMin: 5, scheduleIds: [s.id], userIds: [], channelIds: [] }, { timeoutMin: 10, userIds: [owner.id] }] });
    expect((await call(outsider.cookie, "GET", `/escalation-policies/${policy.body.id}`)).status).toBe(404);
    expect((await call(member.cookie, "GET", `/escalation-policies/${policy.body.id}`)).status).toBe(200);

    // a monitor may use its workspace's policies only
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Cron", type: "heartbeat", intervalSec: 3600, escalationPolicyId: policy.body.id })).body;
    expect(hb.escalationPolicyId).toBe(policy.body.id);
    const theirPolicy = (await call(outsider.cookie, "POST", "/escalation-policies", { name: "Theirs", steps: [{ timeoutMin: 5, userIds: [outsider.id] }] })).body;
    expect((await call(owner.cookie, "PATCH", `/monitors/${hb.id}`, { escalationPolicyId: theirPolicy.id })).status).toBe(400);
    expect((await call(owner.cookie, "POST", "/monitors", { name: "Cron2", type: "heartbeat", intervalSec: 3600, escalationPolicyId: theirPolicy.id })).status).toBe(400);
    expect((await call(owner.cookie, "GET", `/escalation-policies/${policy.body.id}`)).body.monitors).toEqual([{ id: hb.id, name: "Cron" }]);

    // a schedule a policy (or a project's levels) names cannot be deleted
    const inUse = await call(owner.cookie, "DELETE", `/oncall/schedules/${s.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe("schedule_in_use");
    // project levels accept people and schedules beside channels, and the old channel-only shape still saves
    const levels = await call(owner.cookie, "PUT", `/projects/${projectId}/alerting`, { reminderIntervalMin: null, reminderEmail: false, escalation: [{ scheduleIds: [s.id], escalateAfterMin: 5 }, { userIds: [owner.id], escalateAfterMin: 15 }] });
    expect(levels.status).toBe(200);
    expect(levels.body.escalation).toEqual([{ channelIds: [], scheduleIds: [s.id], escalateAfterMin: 5 }, { channelIds: [], userIds: [owner.id], escalateAfterMin: 15 }]);
    expect((await call(owner.cookie, "PUT", `/projects/${projectId}/alerting`, { reminderIntervalMin: null, reminderEmail: false, escalation: [{ escalateAfterMin: 5 }] })).status).toBe(400);

    // deleting the policy sends its monitors back to the project's levels
    expect((await call(owner.cookie, "DELETE", `/escalation-policies/${policy.body.id}?version=1`)).status).toBe(204);
    expect((await call(owner.cookie, "GET", `/monitors/${hb.id}`)).body.escalationPolicyId).toBeNull();
    const audit = (await call(owner.cookie, "GET", "/audit-events?action=escalation_policy&limit=20")).body.events.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["escalation_policy.create", "escalation_policy.delete"]));
  });

  it("an incident escalates to whoever is on call, then to the next step when nobody acknowledges, exactly once per step", async () => {
    const { owner, member, orgId, projectId } = await team();
    const s = (await call(owner.cookie, "POST", "/oncall/schedules", { name: "Primary", timeZone: "America/New_York", layers: [layer([member.id])] })).body;
    const policy = (await call(owner.cookie, "POST", "/escalation-policies", { name: "Sev1", repeatCount: 1, steps: [{ timeoutMin: 5, scheduleIds: [s.id] }, { timeoutMin: 10, userIds: [owner.id] }] })).body;
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Billing cron", type: "heartbeat", intervalSec: 3600, escalationPolicyId: policy.id })).body;
    const inc = await autoIncident(orgId, projectId, hb.id);
    // the policy's first step is due at once
    expect((await incidentRow(inc.id)).next_escalation_at).not.toBeNull();

    // two servers race for the step: it is sent once
    sent.length = 0;
    await Promise.all([sendEscalations(db.repo, unmetered, 100), sendEscalations(db2.repo, unmetered, 100), sendEscalations(db.repo, unmetered, 100), sendEscalations(db2.repo, unmetered, 100)]);
    let rows = await deliveries(inc.id);
    expect(rows.map((r) => [r.target_user_id, r.channel_type, r.status])).toEqual([[member.id, "email", "sent"]]);
    expect(sent.filter((m) => m.to === member.email)).toHaveLength(1);
    const mail = sent.find((m) => m.to === member.email)!;
    expect(`${mail.text}${mail.html}`).toMatch(/escalated to you/);
    let row = await incidentRow(inc.id);
    expect(row.escalation_level).toBe(1);
    // the next step waits for the step timeout (5 minutes)
    expect(new Date(row.next_escalation_at!).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    await sendEscalations(db.repo, unmetered, 100);
    expect(await deliveries(inc.id)).toHaveLength(1);

    // nobody acknowledged within the timeout: the second step notifies the owner
    await dueNow(inc.id);
    await Promise.all([sendEscalations(db.repo, unmetered, 100), sendEscalations(db2.repo, unmetered, 100)]);
    rows = await deliveries(inc.id);
    expect(rows.map((r) => r.target_user_id)).toEqual([member.id, owner.id]);
    row = await incidentRow(inc.id);
    expect(row.escalation_level).toBe(2);
    // repeatCount 1: after the last step the policy starts over with the on-call person
    expect(row.next_escalation_at).not.toBeNull();
    await dueNow(inc.id);
    await sendEscalations(db.repo, unmetered, 100);
    expect((await deliveries(inc.id)).map((r) => r.target_user_id)).toEqual([member.id, owner.id, member.id]);
    await dueNow(inc.id);
    await sendEscalations(db.repo, unmetered, 100);
    expect((await deliveries(inc.id)).map((r) => r.target_user_id)).toEqual([member.id, owner.id, member.id, owner.id]);
    // both rounds done: the clock stops
    row = await incidentRow(inc.id);
    expect([row.escalation_level, row.next_escalation_at]).toEqual([4, null]);

    // the timeline (team only) and the audit log say who was notified and why
    const detail = (await call(owner.cookie, "GET", `/incidents/${inc.id}`)).body;
    const notes = detail.updates.filter((u: any) => u.body.startsWith("Escalation level"));
    expect(notes).toHaveLength(4);
    expect(notes.every((u: any) => u.visibility === "internal")).toBe(true);
    expect(notes.map((u: any) => u.body)).toContain("Escalation level 1 (policy Sev1, step 1): notified Max Member (on call for Primary).");
    expect(notes.map((u: any) => u.body)).toContain("Escalation level 2 (policy Sev1, step 2): notified Olive Owner (named in the step).");
    expect(detail.deliveries.filter((d: any) => d.kind === "incident.escalated").map((d: any) => d.targetUserId)).toEqual([member.id, owner.id, member.id, owner.id]);
    const audit = (await call(owner.cookie, "GET", "/audit-events?action=incident.escalat&limit=50")).body.events;
    expect(audit.filter((e: any) => e.action === "incident.escalate" && e.targetId === inc.id)).toHaveLength(4);
    expect(audit.filter((e: any) => e.action === "incident.escalation_notify").map((e: any) => [e.targetId, e.actorType]).sort()).toEqual(
      [[member.id, "system"], [member.id, "system"], [owner.id, "system"], [owner.id, "system"]].sort());
    // internal escalation notes never reach the public: the incident has no public page entry for them
    expect(detail.updates.filter((u: any) => u.visibility === "public").every((u: any) => !u.body.startsWith("Escalation"))).toBe(true);
  });

  it("an override decides who is paged, and acknowledgement stops escalation and assigns the incident", async () => {
    const { owner, member, orgId, projectId } = await team();
    const s = (await call(owner.cookie, "POST", "/oncall/schedules", { name: "Primary", timeZone: "Europe/London", layers: [layer([owner.id])] })).body;
    // the member covers the owner right now
    expect((await call(member.cookie, "POST", `/oncall/schedules/${s.id}/overrides`, { userId: member.id, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(201);
    const policy = (await call(owner.cookie, "POST", "/escalation-policies", { name: "Primary only", steps: [{ timeoutMin: 5, scheduleIds: [s.id] }, { timeoutMin: 5, userIds: [owner.id] }] })).body;
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Queue", type: "heartbeat", intervalSec: 3600, escalationPolicyId: policy.id })).body;
    const inc = await autoIncident(orgId, projectId, hb.id);
    await sendEscalations(db.repo, unmetered, 100);
    expect((await deliveries(inc.id)).map((r) => r.target_user_id)).toEqual([member.id]);

    // the member acknowledges: the incident is theirs and nothing more is sent, even if the clock were still due
    const ack = await call(member.cookie, "POST", `/incidents/${inc.id}/ack`);
    expect(ack.status).toBe(200);
    expect(ack.body.assigneeId).toBe(member.id);
    expect((await incidentRow(inc.id)).next_escalation_at).toBeNull();
    await db.query(`update incident set next_escalation_at = now() - interval '1 second' where id = $1`, [inc.id]);
    await Promise.all([sendEscalations(db.repo, unmetered, 100), sendEscalations(db2.repo, unmetered, 100)]);
    expect(await deliveries(inc.id)).toHaveLength(1);
    // a second acknowledgement does not take the incident away from its owner
    expect((await call(owner.cookie, "POST", `/incidents/${inc.id}/ack`)).body.assigneeId).toBe(member.id);
  });

  it("resolution stops everything, and a failed personal delivery is retried by the existing machinery", async () => {
    const { owner, member, orgId, projectId } = await team();
    const policy = (await call(owner.cookie, "POST", "/escalation-policies", { name: "Direct", steps: [{ timeoutMin: 5, userIds: [member.id] }, { timeoutMin: 5, userIds: [owner.id] }] })).body;
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Mailer", type: "heartbeat", intervalSec: 3600, escalationPolicyId: policy.id })).body;
    const inc = await autoIncident(orgId, projectId, hb.id);
    // the member's mail server is down: the attempt fails and waits for a retry
    failMailTo = member.email;
    await sendEscalations(db.repo, unmetered, 100);
    let [row] = await deliveries(inc.id);
    expect([row.target_user_id, row.status, row.attempts]).toEqual([member.id, "pending", 1]);
    // back up; the retry is due: the existing retry worker rebuilds the person's address and sends it
    failMailTo = null;
    sent.length = 0;
    await db.query(`update alert_delivery set next_attempt_at = now() - interval '1 second' where id = $1`, [row.id]);
    for (let i = 0; i < 10 && row.status !== "sent"; i++) {
      await retryDeliveries(db.repo, 50, unmetered);
      [row] = await deliveries(inc.id);
    }
    expect([row.status, row.attempts]).toEqual(["sent", 2]);
    expect(sent.map((m) => m.to)).toContain(member.email);

    // resolved: no further step fires, and a queued escalation retry is skipped
    const resolved = await call(owner.cookie, "POST", `/incidents/${inc.id}/updates`, { status: "resolved", body: "Fixed." });
    expect(resolved.status).toBe(201);
    expect((await incidentRow(inc.id)).next_escalation_at).toBeNull();
    await db.query(`update incident set next_escalation_at = now() - interval '1 second' where id = $1`, [inc.id]);
    await sendEscalations(db.repo, unmetered, 100);
    expect(await deliveries(inc.id)).toHaveLength(1);
  });

  it("calendar feed: token-protected, revocable, and only the person's own shifts", async () => {
    const { owner, member } = await team();
    await call(owner.cookie, "POST", "/oncall/schedules", { name: "Nights; EU", timeZone: "UTC", layers: [layer([member.id, owner.id])] });
    const s = (await call(owner.cookie, "GET", "/oncall/schedules")).body[0];
    expect((await call(member.cookie, "GET", "/oncall/calendar")).body.active).toBe(false);
    // an API key (or an agent) cannot mint a bearer link to someone's shifts
    const key = await apiKeyOf(owner.cookie, (await call(owner.cookie, "GET", "/me")).body.organization.id);
    expect((await viaKey(key, "POST", "/oncall/calendar")).status).toBe(403);
    const created = await call(member.cookie, "POST", "/oncall/calendar");
    expect(created.status).toBe(201);
    expect(created.body.replaced).toBe(false);
    const path = new URL(created.body.url).pathname;
    expect(path).toMatch(/^\/api\/public\/oncall\/[0-9a-f]{64}\.ics$/);
    const feed = await raw(path);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toMatch(/^text\/calendar/);
    expect(feed.headers.get("cache-control")).toBe("private, no-store");
    const text = await feed.text();
    // exactly the member's own shifts: every event starts at one of theirs, none at one of the owner's
    const now = Date.now();
    const shifts = (await call(member.cookie, "GET", `/oncall/schedules/${s.id}/shifts?from=${new Date(now - 7 * 86_400_000 + 60_000).toISOString()}&to=${new Date(now + 60 * 86_400_000 - 60_000).toISOString()}`)).body.shifts as { userId: string; start: string }[];
    const ics = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const starts = [...text.matchAll(/DTSTART:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
    const mine = new Set(shifts.filter((x) => x.userId === member.id).map((x) => ics(x.start)));
    const theirs = new Set(shifts.filter((x) => x.userId === owner.id).map((x) => ics(x.start)));
    expect(theirs.size).toBeGreaterThan(20);
    expect(starts.filter((x) => theirs.has(x))).toEqual([]);
    expect(starts.filter((x) => mine.has(x)).length).toBeGreaterThanOrEqual(mine.size - 1);
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("SUMMARY:On call: Nights\\; EU");
    // alternate days: about half of 67 days are the member's
    const events = text.split("BEGIN:VEVENT").length - 1;
    expect(events).toBeGreaterThan(25);
    expect(events).toBeLessThan(40);
    expect((await call(member.cookie, "GET", "/oncall/calendar")).body.active).toBe(true);
    // replacing is explicit and says so; the old link stops; revoking ends it; a made-up token is not found
    const silent = await call(member.cookie, "POST", "/oncall/calendar");
    expect([silent.status, silent.body.code]).toEqual([409, "calendar_link_active"]);
    expect((await raw(path)).status).toBe(200);
    const again = await call(member.cookie, "POST", "/oncall/calendar?replace=true");
    expect(again.status).toBe(201);
    expect(again.body.replaced).toBe(true);
    expect(again.body.warning).toMatch(/previous link has stopped working/);
    expect((await raw(path)).status).toBe(404);
    expect((await raw(new URL(again.body.url).pathname)).status).toBe(200);
    expect((await call(member.cookie, "DELETE", "/oncall/calendar")).status).toBe(204);
    expect((await raw(new URL(again.body.url).pathname)).status).toBe(404);
    expect((await raw(`/api/public/oncall/${"0".repeat(64)}.ics`)).status).toBe(404);
    expect((await raw("/api/public/oncall/not-a-token.ics")).status).toBe(404);
  });

  it("override limits: start at most a year ahead, a cap per person enforced under concurrency, and per schedule", async () => {
    const { owner, member, orgId } = await team();
    const s = (await call(owner.cookie, "POST", "/oncall/schedules", { name: "Capped", timeZone: "UTC", layers: [layer([owner.id])] })).body;
    const far = Date.now() + 400 * 86_400_000;
    expect((await call(owner.cookie, "POST", `/oncall/schedules/${s.id}/overrides`, { userId: member.id, startsAt: new Date(far).toISOString(), endsAt: new Date(far + 3_600_000).toISOString() })).status).toBe(400);
    expect((await call(owner.cookie, "POST", `/oncall/schedules/${s.id}/overrides`, { userId: member.id, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 91 * 86_400_000).toISOString() })).status).toBe(400);
    // the API cap per person (50 open overrides on a schedule)
    const slot = (k: number) => ({ userId: member.id, startsAt: new Date(Date.now() + (k + 1) * 3_600_000).toISOString(), endsAt: new Date(Date.now() + (k + 1) * 3_600_000 + 1_800_000).toISOString() });
    const made: Res[] = [];
    for (let k = 0; k < 52; k++) made.push(await call(owner.cookie, "POST", `/oncall/schedules/${s.id}/overrides`, slot(k)));
    expect(made.filter((r) => r.status === 201)).toHaveLength(50);
    expect(made.filter((r) => r.status === 409).every((r) => r.body.code === "override_limit")).toBe(true);
    expect(made.filter((r) => r.status === 409)).toHaveLength(2);
    // the per-schedule count is taken under a lock: 10 concurrent writers against a cap of 3 create exactly 3
    const t = (await call(owner.cookie, "POST", "/oncall/schedules", { name: "Tiny cap", timeZone: "UTC", layers: [layer([owner.id])] })).body;
    const raced = await Promise.all(Array.from({ length: 10 }, (_, k) => db.repo.createOncallOverride(orgId, t.id, { userId: k % 2 ? owner.id : member.id, startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000), createdBy: owner.id }, { perSchedule: 3, perUser: 10 })));
    expect(raced.filter((r) => r && typeof r === "object")).toHaveLength(3);
    expect(raced.filter((r) => r === "limit_schedule")).toHaveLength(7);
  });

  it("an acknowledgement in the window between claiming a step and sending it stops the page", async () => {
    const { owner, member, orgId, projectId } = await team();
    const policy = (await call(owner.cookie, "POST", "/escalation-policies", { name: "Race", steps: [{ timeoutMin: 5, userIds: [member.id] }] })).body;
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Racy", type: "heartbeat", intervalSec: 3600, escalationPolicyId: policy.id })).body;
    // 1. acknowledged right after the claim, before anything is queued
    const first = await autoIncident(orgId, projectId, hb.id);
    const ackAfterClaim = new Proxy(db.repo, { get: (target, key) => key === "claimEscalations"
      ? async (limit: number) => { const due = await target.claimEscalations(limit); for (const d of due) if (d.incident.id === first.id) await target.acknowledgeIncident(orgId, first.id, owner.id); return due; }
      : (target as any)[key] });
    await sendEscalations(ackAfterClaim, unmetered, 100);
    // nobody was queued: the only row is the record of the skipped step
    expect((await deliveries(first.id)).map((r) => [r.target_user_id, r.channel_type, r.status])).toEqual([[null, "none", "skipped"]]);
    expect((await db.query<{ status_message: string }>(`select status_message from alert_delivery where incident_id = $1`, [first.id])).map((r) => r.status_message)).toEqual(["skipped: the incident was acknowledged or resolved before this escalation could be sent"]);
    expect((await call(owner.cookie, "GET", `/incidents/${first.id}`)).body.updates.some((u: any) => u.body.startsWith("Escalation level"))).toBe(false);
    // 2. acknowledged after the rows were queued, before the provider is called: the row ends skipped, no mail
    await call(owner.cookie, "POST", `/incidents/${first.id}/updates`, { status: "resolved", body: "ok" });
    const second = await autoIncident(orgId, projectId, hb.id);
    sent.length = 0;
    const ackAfterQueue = new Proxy(db.repo, { get: (target, key) => key === "queueDeliveries"
      ? async (rows: any[]) => { const out = await target.queueDeliveries(rows); if (rows.some((r) => r.incidentId === second.id)) await target.acknowledgeIncident(orgId, second.id, owner.id); return out; }
      : (target as any)[key] });
    await sendEscalations(ackAfterQueue, unmetered, 100);
    const rows = await deliveries(second.id);
    expect(rows.map((r) => [r.target_user_id, r.status])).toEqual([[member.id, "skipped"]]);
    expect(sent.filter((m) => m.to === member.email)).toEqual([]);
  });

  it("deleting a policy stops the escalation of its open incidents and says so on the timeline", async () => {
    const { owner, member, orgId, projectId } = await team();
    const policy = (await call(owner.cookie, "POST", "/escalation-policies", { name: "Doomed", steps: [{ timeoutMin: 5, userIds: [member.id] }, { timeoutMin: 5, userIds: [owner.id] }] })).body;
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Orphan", type: "heartbeat", intervalSec: 3600, escalationPolicyId: policy.id })).body;
    const inc = await autoIncident(orgId, projectId, hb.id);
    await sendEscalations(db.repo, unmetered, 100);
    expect((await incidentRow(inc.id)).next_escalation_at).not.toBeNull();
    expect((await call(owner.cookie, "DELETE", `/escalation-policies/${policy.id}`)).status).toBe(204);
    const row = await incidentRow(inc.id);
    expect([row.escalation_level, row.next_escalation_at]).toEqual([1, null]);
    await db.query(`update incident set next_escalation_at = null where id = $1`, [inc.id]);
    await sendEscalations(db.repo, unmetered, 100);
    expect(await deliveries(inc.id)).toHaveLength(1);
    const notes = (await call(owner.cookie, "GET", `/incidents/${inc.id}`)).body.updates.map((u: any) => [u.body, u.visibility]);
    expect(notes).toContainEqual(["Escalation stopped: the escalation policy Doomed was deleted.", "internal"]);
  });

  it("a channel already alerted when the incident opened is not paged again by the policy's first step", async () => {
    const { owner, member, orgId, projectId } = await team();
    const ch = (await call(owner.cookie, "POST", "/channels", { type: "email", name: "Ops mail", config: { to: `ops-${crypto.randomUUID()}@example.com` } })).body;
    const policy = (await call(owner.cookie, "POST", "/escalation-policies", { name: "Both", steps: [{ timeoutMin: 5, channelIds: [ch.id], userIds: [member.id] }] })).body;
    const hb = (await call(owner.cookie, "POST", "/monitors", { name: "Dup", type: "heartbeat", intervalSec: 3600, channelIds: [ch.id], escalationPolicyId: policy.id })).body;
    const inc = await autoIncident(orgId, projectId, hb.id);
    // the down alert went to the channel when the incident opened
    await db.repo.logDeliveries([{ organizationId: orgId, projectId, channelId: ch.id, channelName: ch.name, channelType: "email", kind: "incident.opened", incidentId: inc.id, monitorName: "Dup", ok: true, status: "sent" }]);
    await sendEscalations(db.repo, unmetered, 100);
    const rows = await db.query<{ channel_id: string | null; target_user_id: string | null; status: string }>(`select channel_id, target_user_id, status from alert_delivery where incident_id = $1 and kind = 'incident.escalated' order by created_at`, [inc.id]);
    expect(rows.filter((r) => r.channel_id === ch.id).map((r) => r.status)).toEqual(["skipped"]);
    expect(rows.filter((r) => r.target_user_id === member.id).map((r) => r.status)).toEqual(["sent"]);
  });
});
