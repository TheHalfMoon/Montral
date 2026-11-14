import { zValidator } from "../bounded-validator";
import type { EscalationPolicy, OncallLayerInput, OncallSchedule, PolicyStep, Repo, Scope } from "@montral/repo";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, auditChanges } from "../audit";
import { isManager, requireManager, uuidParams } from "../middleware";
import { isValidTimeZone, layerProblem } from "../oncall-engine";
import { onCallNow, scheduleShifts, shiftRange, tokenHash } from "../oncall";

/**
 * On-call schedules, overrides, escalation policies and calendar feeds.
 *
 * Permissions: workspace owners and admins create, change and delete schedules, layers, policies and anyone's overrides.
 * Every member can read them, see who is on call and list shifts, and may add an override for themselves only (taking a
 * shift, a swap) and remove an override they created for themselves. Each person manages their own calendar feed.
 * A key limited to some projects reads its projects' and workspace-wide rows and changes only its projects' rows.
 * Everything is bound to the caller's workspace: ids from another workspace are simply not found.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const restriction = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
  start: hhmm,
  end: hhmm,
});
const layerFields = {
  name: z.string().trim().min(1).max(80),
  userIds: z.array(z.string().min(1).max(200)).min(1).max(50),
  rotationType: z.enum(["daily", "weekly", "custom"]),
  shiftLengthHours: z.number().int().min(1).max(2016).nullable(),
  handoffTime: hhmm,
  handoffWeekday: z.number().int().min(0).max(6).nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  restrictions: z.array(restriction).max(7),
};
const layer = z.object({
  id: z.string().uuid().optional(),
  name: layerFields.name.default("Layer"),
  userIds: layerFields.userIds,
  rotationType: layerFields.rotationType,
  shiftLengthHours: layerFields.shiftLengthHours.optional().default(null),
  handoffTime: layerFields.handoffTime.default("09:00"),
  handoffWeekday: layerFields.handoffWeekday.optional().default(null),
  startDate: layerFields.startDate,
  restrictions: layerFields.restrictions.default([]),
});
const version = z.number().int().min(1);
const timeZone = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown IANA time zone");
const scheduleCreate = z.object({ name: z.string().trim().min(1).max(80), timeZone, projectId: z.string().uuid().nullable().default(null), layers: z.array(layer).max(10).default([]) });
const schedulePatch = z.object({ version, name: z.string().trim().min(1).max(80).optional(), timeZone: timeZone.optional(), layers: z.array(layer).max(10).optional() });
const layerCreate = z.object({ version, layer });
const layerPatch = z.object({ version, ...Object.fromEntries(Object.entries(layerFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof layerFields]: z.ZodOptional<(typeof layerFields)[K]> } });
const overrideCreate = z.object({ userId: z.string().min(1).max(200), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) });
const step = z.object({
  timeoutMin: z.number().int().min(1).max(1440),
  channelIds: z.array(z.string().uuid()).max(10).default([]),
  userIds: z.array(z.string().min(1).max(200)).max(20).default([]),
  scheduleIds: z.array(z.string().uuid()).max(5).default([]),
});
const policyCreate = z.object({ name: z.string().trim().min(1).max(80), projectId: z.string().uuid().nullable().default(null), steps: z.array(step).min(1).max(10), repeatCount: z.number().int().min(0).max(5).default(0) });
const policyPatch = z.object({ version, name: z.string().trim().min(1).max(80).optional(), steps: z.array(step).min(1).max(10).optional(), repeatCount: z.number().int().min(0).max(5).optional() });

const MAX_OVERRIDE_DAYS = 90;
/** An override may start at most this far ahead. */
const MAX_OVERRIDE_LEAD_DAYS = 366;
/** Overrides that have not ended yet, per schedule and per person on a schedule: keeps every evaluation small. */
export const MAX_OPEN_OVERRIDES_PER_SCHEDULE = 500;
export const MAX_OPEN_OVERRIDES_PER_PERSON = 50;
/** Overrides one person may create per hour in a workspace. */
const OVERRIDE_RATE_PER_HOUR = 60;
const DAY = 86_400_000;

type C = Context<AppEnv>;
const repoOf = (c: C) => c.get("repo");
const conflict = (c: C, current: number | null) =>
  c.json({ error: "Someone else changed this since you loaded it. Reload and apply your change again.", code: "version_conflict", ...(current != null ? { currentVersion: current } : {}) }, 409);

/** A layer as stored: fields that do not apply to its rotation are cleared. */
const normalLayer = (l: z.infer<typeof layer> | OncallLayerInput): OncallLayerInput => ({
  ...(l.id ? { id: l.id } : {}),
  name: l.name, userIds: [...l.userIds], rotationType: l.rotationType,
  shiftLengthHours: l.rotationType === "custom" ? (l.shiftLengthHours ?? null) : null,
  handoffTime: l.handoffTime, handoffWeekday: l.rotationType === "weekly" ? (l.handoffWeekday ?? null) : null,
  startDate: l.startDate, restrictions: l.restrictions ?? [],
});

/** What is wrong with these layers for this workspace, or null. */
async function layersProblem(repo: Repo, orgId: string, layers: OncallLayerInput[]): Promise<string | null> {
  for (const l of layers) {
    const bad = layerProblem({ ...l, id: l.id ?? "new" });
    if (bad) return bad;
  }
  const members = new Set((await repo.listMembers(orgId)).map((m) => m.userId));
  if (layers.some((l) => l.userIds.some((u) => !members.has(u)))) return "Every person in a rotation must be a member of the workspace";
  return null;
}

/** Whether a row belonging to `projectId` (null = workspace-wide) may be created with this credential. */
async function projectProblem(c: C, projectId: string | null): Promise<string | null> {
  const scope = c.get("projectScope");
  if (projectId === null) return scope ? "This API key or authorization is limited to specific projects; give a projectId" : null;
  if (scope && !scope.includes(projectId)) return "This API key or authorization has no access to that project";
  const projects = await repoOf(c).listProjects(c.get("orgId"), null);
  return projects.some((p) => p.id === projectId) ? null : "Project not found";
}

/** What is wrong with these escalation targets for a row of `projectId`, or null. */
export async function targetsProblem(repo: Repo, orgId: string, projectId: string | null, steps: { channelIds?: string[]; userIds?: string[]; scheduleIds?: string[] }[]): Promise<string | null> {
  if (steps.some((s) => !(s.channelIds?.length || s.userIds?.length || s.scheduleIds?.length))) return "Each step needs at least one channel, person or schedule";
  const channelIds = [...new Set(steps.flatMap((s) => s.channelIds ?? []))];
  if (channelIds.length) {
    const found = await repo.channelsByIds(orgId, channelIds);
    if (found.length !== channelIds.length) return "A step names a channel that does not exist";
    if (found.some((ch) => ch.projectId && ch.projectId !== projectId)) return "A step names a channel that belongs to another project";
  }
  const userIds = [...new Set(steps.flatMap((s) => s.userIds ?? []))];
  if (userIds.length) {
    const members = new Set((await repo.listMembers(orgId)).map((m) => m.userId));
    if (userIds.some((u) => !members.has(u))) return "A step names a person who is not a member of the workspace";
  }
  const scheduleIds = [...new Set(steps.flatMap((s) => s.scheduleIds ?? []))];
  if (scheduleIds.length) {
    const found = await repo.oncallSchedulesByIds(orgId, scheduleIds);
    if (found.length !== scheduleIds.length) return "A step names a schedule that does not exist";
    if (found.some((s) => s.projectId && s.projectId !== projectId)) return "A step names a schedule that belongs to another project";
  }
  return null;
}

const scheduleAudit = (s: OncallSchedule) => ({ type: "oncall_schedule", id: s.id, projectId: s.projectId });
const policyAudit = (p: EscalationPolicy) => ({ type: "escalation_policy", id: p.id, projectId: p.projectId });

async function currentVersion<T extends { version: number }>(load: Promise<T | null>) {
  return (await load)?.version ?? null;
}

export const oncall = new Hono<AppEnv>()
  // ── people and the current picture ────────────────────────────────────────────────────────────────────────────
  // People to put in rotations. A signed-in member sees what the Team page shows (name, email, role); an API key or an
  // agent only gets ids and names, which is all a schedule needs.
  .get("/members", async (c) => {
    const members = await repoOf(c).listMembers(c.get("orgId"));
    const session = c.get("workspaceGrant") === null;
    return c.json(members.map(({ userId, name, email, role }) => (session ? { userId, name, email, role } : { userId, name })));
  })
  .get("/now", async (c) => {
    const repo = repoOf(c);
    const schedules = await repo.listOncallSchedules(c.get("orgId"), c.get("projectScope"));
    c.header("cache-control", "no-store");
    return c.json({ at: new Date().toISOString(), schedules: await onCallNow(repo, c.get("orgId"), schedules) });
  })

  // ── schedules ─────────────────────────────────────────────────────────────────────────────────────────────────
  .get("/schedules", async (c) => {
    const repo = repoOf(c);
    const schedules = await repo.listOncallSchedules(c.get("orgId"), c.get("projectScope"));
    const now = new Map((await onCallNow(repo, c.get("orgId"), schedules)).map((n) => [n.scheduleId, n.onCall]));
    return c.json(schedules.map((s) => ({ ...s, onCallNow: now.get(s.id) ?? null })));
  })
  .post("/schedules", requireManager, zValidator("json", scheduleCreate), async (c) => {
    const repo = repoOf(c);
    const v = c.req.valid("json");
    const badProject = await projectProblem(c, v.projectId);
    if (badProject) return c.json({ error: badProject }, badProject === "Project not found" ? 400 : 403);
    const layers = v.layers.map(normalLayer).map(({ id: _id, ...l }) => l);
    const bad = await layersProblem(repo, c.get("orgId"), layers);
    if (bad) return c.json({ error: bad }, 400);
    const s = await repo.createOncallSchedule(c.get("orgId"), { projectId: v.projectId, name: v.name, timeZone: v.timeZone, layers });
    await audit(c, "oncall_schedule.create", scheduleAudit(s), auditChanges({ name: v.name, timeZone: v.timeZone, layers: v.layers.length ? v.layers : undefined, projectId: v.projectId ?? undefined }));
    return c.json(s, 201);
  })
  .get("/schedules/:id", uuidParams, async (c) => {
    const repo = repoOf(c);
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s) return c.json({ error: "Not found" }, 404);
    const [now] = await onCallNow(repo, c.get("orgId"), [s]);
    return c.json({ ...s, onCallNow: now?.onCall ?? null });
  })
  .patch("/schedules/:id", uuidParams, requireManager, zValidator("json", schedulePatch), async (c) => {
    const repo = repoOf(c);
    const { version: expected, ...v } = c.req.valid("json");
    if (v.name === undefined && v.timeZone === undefined && v.layers === undefined) return c.json({ error: "No changes" }, 400);
    const layers = v.layers?.map(normalLayer);
    if (layers) {
      const bad = await layersProblem(repo, c.get("orgId"), layers);
      if (bad) return c.json({ error: bad }, 400);
    }
    const r = await repo.updateOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"), expected, { name: v.name, timeZone: v.timeZone, layers });
    if (r === null) return c.json({ error: "Not found" }, 404);
    if (r === "conflict") return conflict(c, await currentVersion(repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"))));
    await audit(c, "oncall_schedule.update", scheduleAudit(r), auditChanges(v, { version: r.version }));
    return c.json(r);
  })
  .delete("/schedules/:id", uuidParams, requireManager, async (c) => {
    const repo = repoOf(c);
    const raw = c.req.query("version");
    const expected = raw === undefined ? undefined : Number(raw);
    if (expected !== undefined && !(Number.isInteger(expected) && expected >= 1)) return c.json({ error: "version must be a positive integer" }, 400);
    const r = await repo.deleteOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"), expected);
    if (r.status === "not_found") return c.json({ error: "Not found" }, 404);
    if (r.status === "in_use") return c.json({ error: `The schedule is still used by ${r.usedBy!.join(", ")}. Remove it there first.`, code: "schedule_in_use", usedBy: r.usedBy }, 409);
    if (r.status === "conflict") return conflict(c, await currentVersion(repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"))));
    await audit(c, "oncall_schedule.delete", { type: "oncall_schedule", id: c.req.param("id"), projectId: r.projectId ?? null });
    return c.body(null, 204);
  })

  // ── layers (each change bumps the schedule's version, like editing the whole schedule) ──────────────────────────
  .post("/schedules/:id/layers", uuidParams, requireManager, zValidator("json", layerCreate), async (c) => {
    const repo = repoOf(c);
    const v = c.req.valid("json");
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s) return c.json({ error: "Not found" }, 404);
    if (s.layers.length >= 10) return c.json({ error: "A schedule can have at most 10 layers" }, 400);
    const { id: _id, ...added } = normalLayer(v.layer);
    const layers = [...s.layers.map(normalLayer), added];
    const bad = await layersProblem(repo, c.get("orgId"), [added]);
    if (bad) return c.json({ error: bad }, 400);
    const r = await repo.updateOncallSchedule(c.get("orgId"), s.id, c.get("projectScope"), v.version, { layers });
    if (r === null) return c.json({ error: "Not found" }, 404);
    if (r === "conflict") return conflict(c, s.version);
    await audit(c, "oncall_layer.create", { type: "oncall_schedule", id: r.id, projectId: r.projectId }, auditChanges(v.layer, { version: r.version }));
    return c.json(r, 201);
  })
  .patch("/schedules/:id/layers/:layerId", uuidParams, requireManager, zValidator("json", layerPatch), async (c) => {
    const repo = repoOf(c);
    const { version: expected, ...v } = c.req.valid("json");
    const layerId = c.req.param("layerId");
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    const current = s?.layers.find((l) => l.id === layerId);
    if (!s || !current || !UUID.test(layerId)) return c.json({ error: "Not found" }, 404);
    const changed = normalLayer({ ...current, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) });
    const bad = await layersProblem(repo, c.get("orgId"), [changed]);
    if (bad) return c.json({ error: bad }, 400);
    const r = await repo.updateOncallSchedule(c.get("orgId"), s.id, c.get("projectScope"), expected, { layers: s.layers.map((l) => (l.id === layerId ? changed : normalLayer(l))) });
    if (r === null) return c.json({ error: "Not found" }, 404);
    if (r === "conflict") return conflict(c, s.version);
    await audit(c, "oncall_layer.update", { type: "oncall_schedule", id: r.id, projectId: r.projectId }, auditChanges(v, { version: r.version }));
    return c.json(r);
  })
  .delete("/schedules/:id/layers/:layerId", uuidParams, requireManager, async (c) => {
    const repo = repoOf(c);
    const expected = Number(c.req.query("version"));
    if (!(Number.isInteger(expected) && expected >= 1)) return c.json({ error: "version is required: the schedule version you loaded" }, 400);
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s || !s.layers.some((l) => l.id === c.req.param("layerId"))) return c.json({ error: "Not found" }, 404);
    const r = await repo.updateOncallSchedule(c.get("orgId"), s.id, c.get("projectScope"), expected, { layers: s.layers.filter((l) => l.id !== c.req.param("layerId")).map(normalLayer) });
    if (r === null) return c.json({ error: "Not found" }, 404);
    if (r === "conflict") return conflict(c, s.version);
    await audit(c, "oncall_layer.delete", { type: "oncall_schedule", id: r.id, projectId: r.projectId }, auditChanges({}, { version: r.version }));
    return c.json(r);
  })

  // ── shifts ────────────────────────────────────────────────────────────────────────────────────────────────────
  .get("/schedules/:id/shifts", uuidParams, async (c) => {
    const repo = repoOf(c);
    const range = shiftRange(c.req.query("from"), c.req.query("to"));
    if ("error" in range) return c.json({ error: range.error }, 400);
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s) return c.json({ error: "Not found" }, 404);
    c.header("cache-control", "no-store");
    return c.json({ scheduleId: s.id, timeZone: s.timeZone, from: range.from.toISOString(), to: range.to.toISOString(), shifts: await scheduleShifts(repo, c.get("orgId"), s, range.from, range.to) });
  })

  // ── overrides ─────────────────────────────────────────────────────────────────────────────────────────────────
  .get("/schedules/:id/overrides", uuidParams, async (c) => {
    const repo = repoOf(c);
    const range = shiftRange(c.req.query("from"), c.req.query("to"));
    if ("error" in range) return c.json({ error: range.error }, 400);
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s) return c.json({ error: "Not found" }, 404);
    return c.json(await repo.listOncallOverrides(c.get("orgId"), [s.id], range.from, range.to));
  })
  .post("/schedules/:id/overrides", uuidParams, zValidator("json", overrideCreate), async (c) => {
    const repo = repoOf(c);
    const v = c.req.valid("json");
    const manager = await isManager(c);
    // members may take a shift themselves (a swap, covering a colleague), never assign one to someone else
    if (!manager && v.userId !== c.get("userId")) return c.json({ error: "Members can only add overrides for themselves; owners and admins can add them for anyone" }, 403);
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s) return c.json({ error: "Not found" }, 404);
    const scope: Scope = c.get("projectScope");
    if (scope && !(s.projectId && scope.includes(s.projectId))) return c.json({ error: "This API key or authorization is limited to specific projects" }, 403);
    const startsAt = new Date(v.startsAt);
    const endsAt = new Date(v.endsAt);
    if (endsAt <= startsAt) return c.json({ error: "endsAt must be after startsAt" }, 400);
    if (endsAt.getTime() - startsAt.getTime() > MAX_OVERRIDE_DAYS * DAY) return c.json({ error: `An override can last at most ${MAX_OVERRIDE_DAYS} days` }, 400);
    if (endsAt.getTime() <= Date.now()) return c.json({ error: "The override has already ended" }, 400);
    if (startsAt.getTime() > Date.now() + MAX_OVERRIDE_LEAD_DAYS * DAY) return c.json({ error: "An override can start at most a year ahead" }, 400);
    if (!(await repo.isMember(v.userId, c.get("orgId")))) return c.json({ error: "The person must be a member of the workspace" }, 400);
    if (!(await repo.withinLimit(`oncall-override:${c.get("orgId")}:${c.get("userId")}`, OVERRIDE_RATE_PER_HOUR, 3600))) return c.json({ error: "Too many overrides created, try again later" }, 429);
    const o = await repo.createOncallOverride(c.get("orgId"), s.id, { userId: v.userId, startsAt, endsAt, createdBy: c.get("userId") }, { perSchedule: MAX_OPEN_OVERRIDES_PER_SCHEDULE, perUser: MAX_OPEN_OVERRIDES_PER_PERSON });
    if (o === "limit_schedule") return c.json({ error: `A schedule can have at most ${MAX_OPEN_OVERRIDES_PER_SCHEDULE} overrides that have not ended`, code: "override_limit" }, 409);
    if (o === "limit_user") return c.json({ error: `A person can have at most ${MAX_OPEN_OVERRIDES_PER_PERSON} overrides on a schedule that have not ended`, code: "override_limit" }, 409);
    if (!o) return c.json({ error: "Not found" }, 404);
    await audit(c, "oncall_override.create", { type: "oncall_schedule", id: s.id, projectId: s.projectId }, auditChanges({ userId: v.userId, startsAt: v.startsAt, endsAt: v.endsAt }));
    return c.json(o, 201);
  })
  .delete("/schedules/:id/overrides/:overrideId", uuidParams, async (c) => {
    const repo = repoOf(c);
    const overrideId = c.req.param("overrideId");
    if (!UUID.test(overrideId)) return c.json({ error: "Not found" }, 404);
    const s = await repo.getOncallSchedule(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!s) return c.json({ error: "Not found" }, 404);
    const o = await repo.getOncallOverride(c.get("orgId"), s.id, overrideId);
    if (!o) return c.json({ error: "Not found" }, 404);
    const own = o.userId === c.get("userId") && o.createdBy === c.get("userId");
    if (!own && !(await isManager(c))) return c.json({ error: "Members can only remove overrides they added for themselves" }, 403);
    const scope: Scope = c.get("projectScope");
    if (scope && !(s.projectId && scope.includes(s.projectId))) return c.json({ error: "This API key or authorization is limited to specific projects" }, 403);
    await repo.deleteOncallOverride(c.get("orgId"), s.id, overrideId);
    await audit(c, "oncall_override.delete", { type: "oncall_schedule", id: s.id, projectId: s.projectId }, auditChanges({ userId: o.userId }));
    return c.body(null, 204);
  })

  // ── calendar feed (each person their own) ─────────────────────────────────────────────────────────────────────
  .get("/calendar", async (c) => {
    const status = await repoOf(c).oncallCalendarStatus(c.get("orgId"), c.get("userId"));
    return c.json({ active: !!status, createdAt: status?.createdAt ?? null, lastUsedAt: status?.lastUsedAt ?? null });
  })
  .post("/calendar", async (c) => {
    // A bearer link to someone's shifts is minted only by the person, signed in: never by an API key or an agent.
    if (c.get("workspaceGrant") !== null) return c.json({ error: "A calendar link can only be created from a signed-in session, not with an API key or agent authorization" }, 403);
    const repo = repoOf(c);
    const previous = await repo.oncallCalendarStatus(c.get("orgId"), c.get("userId"));
    // replacing is explicit: with a link already active the caller must say so, and the old link then stops working
    const replace = c.req.query("replace") === "true";
    if (previous && !replace) return c.json({ error: "A calendar link is already active. Replacing it stops the current link at once; send replace=true to do so.", code: "calendar_link_active" }, 409);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const row = await repo.createOncallCalendarToken(c.get("orgId"), c.get("userId"), await tokenHash(token));
    await audit(c, previous ? "oncall_calendar.replace" : "oncall_calendar.create", { type: "user", id: c.get("userId"), projectId: null });
    const base = new URL(c.req.url).origin;
    return c.json({
      url: `${base}/api/public/oncall/${token}.ics`, createdAt: row.createdAt, replaced: !!previous,
      warning: `Anyone with this link can read your on-call shifts. It is shown once.${previous ? " Your previous link has stopped working." : ""}`,
    }, 201);
  })
  .delete("/calendar", async (c) => {
    const n = await repoOf(c).revokeOncallCalendarTokens(c.get("orgId"), c.get("userId"));
    if (n) await audit(c, "oncall_calendar.revoke", { type: "user", id: c.get("userId"), projectId: null });
    return c.body(null, 204);
  });

export const escalationPolicies = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await repoOf(c).listEscalationPolicies(c.get("orgId"), c.get("projectScope"))))
  .post("/", requireManager, zValidator("json", policyCreate), async (c) => {
    const repo = repoOf(c);
    const v = c.req.valid("json");
    const badProject = await projectProblem(c, v.projectId);
    if (badProject) return c.json({ error: badProject }, badProject === "Project not found" ? 400 : 403);
    const steps: PolicyStep[] = v.steps.map((s) => ({ timeoutMin: s.timeoutMin, channelIds: [...new Set(s.channelIds)], userIds: [...new Set(s.userIds)], scheduleIds: [...new Set(s.scheduleIds)] }));
    const bad = await targetsProblem(repo, c.get("orgId"), v.projectId, steps);
    if (bad) return c.json({ error: bad }, 400);
    const p = await repo.createEscalationPolicy(c.get("orgId"), { projectId: v.projectId, name: v.name, steps, repeatCount: v.repeatCount });
    await audit(c, "escalation_policy.create", policyAudit(p), auditChanges({ name: v.name, steps: v.steps, repeatCount: v.repeatCount }, { count: steps.length }));
    return c.json(p, 201);
  })
  .get("/:id", uuidParams, async (c) => {
    const repo = repoOf(c);
    const p = await repo.getEscalationPolicy(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!p) return c.json({ error: "Not found" }, 404);
    return c.json({ ...p, monitors: await repo.monitorsUsingPolicy(c.get("orgId"), p.id, c.get("projectScope")) });
  })
  .patch("/:id", uuidParams, requireManager, zValidator("json", policyPatch), async (c) => {
    const repo = repoOf(c);
    const { version: expected, ...v } = c.req.valid("json");
    if (v.name === undefined && v.steps === undefined && v.repeatCount === undefined) return c.json({ error: "No changes" }, 400);
    const current = await repo.getEscalationPolicy(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!current) return c.json({ error: "Not found" }, 404);
    const steps = v.steps?.map((s) => ({ timeoutMin: s.timeoutMin, channelIds: [...new Set(s.channelIds)], userIds: [...new Set(s.userIds)], scheduleIds: [...new Set(s.scheduleIds)] }));
    if (steps) {
      const bad = await targetsProblem(repo, c.get("orgId"), current.projectId, steps);
      if (bad) return c.json({ error: bad }, 400);
    }
    const r = await repo.updateEscalationPolicy(c.get("orgId"), current.id, c.get("projectScope"), expected, { name: v.name, steps, repeatCount: v.repeatCount });
    if (r === null) return c.json({ error: "Not found" }, 404);
    if (r === "conflict") return conflict(c, await currentVersion(repo.getEscalationPolicy(c.get("orgId"), current.id, c.get("projectScope"))));
    await audit(c, "escalation_policy.update", policyAudit(r), auditChanges(v, { version: r.version }));
    return c.json(r);
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = repoOf(c);
    const raw = c.req.query("version");
    const expected = raw === undefined ? undefined : Number(raw);
    if (expected !== undefined && !(Number.isInteger(expected) && expected >= 1)) return c.json({ error: "version must be a positive integer" }, 400);
    const r = await repo.deleteEscalationPolicy(c.get("orgId"), c.req.param("id"), c.get("projectScope"), expected);
    if (r.status === "not_found") return c.json({ error: "Not found" }, 404);
    if (r.status === "conflict") return conflict(c, await currentVersion(repo.getEscalationPolicy(c.get("orgId"), c.req.param("id"), c.get("projectScope"))));
    await audit(c, "escalation_policy.delete", { type: "escalation_policy", id: c.req.param("id"), projectId: r.projectId ?? null }, auditChanges({}, { count: r.monitors ?? 0 }));
    return c.body(null, 204);
  });
