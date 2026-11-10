import type { EscalationPolicy, OncallLayer, OncallLayerInput, OncallOverride, OncallSchedule, PolicyStep, Repo, Scope } from "@montral/repo";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";

type ScheduleRow = typeof schema.oncallSchedule.$inferSelect;
type LayerRow = typeof schema.oncallLayer.$inferSelect;
type PolicyRow = typeof schema.escalationPolicy.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Col = Parameters<typeof inArray>[0];

/** Reads: a project-limited key sees its projects' rows and the workspace-wide ones. */
const readable = (scope: Scope, col: Col): SQL | undefined => (scope ? or(isNull(col), inArray(col, scope)) : undefined);
/** Writes: a project-limited key changes only its projects' rows, never workspace-wide ones. */
const writable = (scope: Scope, col: Col): SQL | undefined => (scope ? inArray(col, scope) : undefined);

const toLayer = (r: LayerRow): OncallLayer => ({
  id: r.id, position: r.position, name: r.name, userIds: r.userIds, rotationType: r.rotationType, shiftLengthHours: r.shiftLengthHours,
  handoffTime: r.handoffTime, handoffWeekday: r.handoffWeekday, startDate: r.startDate, restrictions: r.restrictions ?? [],
});
const toSchedule = (r: ScheduleRow, layers: LayerRow[]): OncallSchedule => ({
  id: r.id, organizationId: r.organizationId, projectId: r.projectId, name: r.name, timeZone: r.timeZone, version: r.version,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
  layers: layers.filter((l) => l.scheduleId === r.id).sort((a, b) => a.position - b.position).map(toLayer),
});
const toPolicy = (r: PolicyRow): EscalationPolicy => ({
  id: r.id, organizationId: r.organizationId, projectId: r.projectId, name: r.name, repeatCount: r.repeatCount, version: r.version,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
  steps: (r.steps ?? []).map((s: Partial<PolicyStep>) => ({ timeoutMin: s.timeoutMin ?? 30, channelIds: s.channelIds ?? [], userIds: s.userIds ?? [], scheduleIds: s.scheduleIds ?? [] })),
});
const layerValues = (scheduleId: string, l: OncallLayerInput, position: number) => ({
  scheduleId, position, name: l.name, userIds: l.userIds, rotationType: l.rotationType,
  shiftLengthHours: l.rotationType === "custom" ? l.shiftLengthHours : null, handoffTime: l.handoffTime,
  handoffWeekday: l.rotationType === "weekly" ? l.handoffWeekday : null, startDate: l.startDate, restrictions: l.restrictions ?? [],
});

/** The on-call part of the Postgres repo (schedules, layers, overrides, escalation policies, calendar feeds, notices). */
export function oncallRepo(db: Db) {
  async function withLayers(rows: ScheduleRow[], q: Db | Tx = db): Promise<OncallSchedule[]> {
    if (!rows.length) return [];
    const layers = await q.select().from(schema.oncallLayer).where(inArray(schema.oncallLayer.scheduleId, rows.map((r) => r.id)));
    return rows.map((r) => toSchedule(r, layers));
  }

  /** Replaces a schedule's layers: listed ids are kept and updated, unknown or missing ids are new, the rest are removed. */
  async function replaceLayers(tx: Tx, scheduleId: string, layers: OncallLayerInput[]) {
    const existing = new Set((await tx.select({ id: schema.oncallLayer.id }).from(schema.oncallLayer).where(eq(schema.oncallLayer.scheduleId, scheduleId))).map((r) => r.id));
    const kept = new Set(layers.map((l) => l.id).filter((id): id is string => !!id && existing.has(id)));
    const gone = [...existing].filter((id) => !kept.has(id));
    if (gone.length) await tx.delete(schema.oncallLayer).where(and(eq(schema.oncallLayer.scheduleId, scheduleId), inArray(schema.oncallLayer.id, gone)));
    for (const [position, l] of layers.entries()) {
      if (l.id && kept.has(l.id)) await tx.update(schema.oncallLayer).set(layerValues(scheduleId, l, position)).where(and(eq(schema.oncallLayer.id, l.id), eq(schema.oncallLayer.scheduleId, scheduleId)));
      else await tx.insert(schema.oncallLayer).values(layerValues(scheduleId, l, position));
    }
  }

  const methods = {
    async listMembers(orgId) {
      const rows = await db
        .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.member.role, locale: schema.user.locale })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, orgId))
        .orderBy(asc(schema.user.name), asc(schema.user.email));
      return rows;
    },

    async listOncallSchedules(orgId, scope) {
      const t = schema.oncallSchedule;
      return withLayers(await db.select().from(t).where(and(eq(t.organizationId, orgId), readable(scope, t.projectId))).orderBy(asc(t.name), asc(t.createdAt)));
    },
    async getOncallSchedule(orgId, id, scope) {
      const t = schema.oncallSchedule;
      const rows = await db.select().from(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), readable(scope, t.projectId)));
      return (await withLayers(rows))[0] ?? null;
    },
    async oncallSchedulesByIds(orgId, ids) {
      if (!ids.length) return [];
      const t = schema.oncallSchedule;
      return withLayers(await db.select().from(t).where(and(eq(t.organizationId, orgId), inArray(t.id, ids))));
    },
    async createOncallSchedule(orgId, s) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.oncallSchedule).values({ organizationId: orgId, projectId: s.projectId, name: s.name, timeZone: s.timeZone }).returning();
        if (s.layers.length) await tx.insert(schema.oncallLayer).values(s.layers.map((l, i) => layerValues(row.id, l, i)));
        return (await withLayers([row], tx))[0];
      });
    },
    async updateOncallSchedule(orgId, id, scope, version, patch) {
      const t = schema.oncallSchedule;
      return db.transaction(async (tx) => {
        // One conditional UPDATE: it takes the row lock, so a concurrent writer holding the same version waits here and then
        // finds the version moved on (0 rows) instead of overwriting this change.
        const [row] = await tx
          .update(t)
          .set({ version: sql`${t.version} + 1`, updatedAt: sql`now()`, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}) })
          .where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId), eq(t.version, version)))
          .returning();
        if (!row) {
          const [exists] = await tx.select({ id: t.id }).from(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId)));
          return exists ? ("conflict" as const) : null;
        }
        if (patch.layers) await replaceLayers(tx, id, patch.layers);
        return (await withLayers([row], tx))[0];
      });
    },
    async deleteOncallSchedule(orgId, id, scope, version) {
      const t = schema.oncallSchedule;
      const [found] = await db.select({ id: t.id, projectId: t.projectId }).from(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId)));
      if (!found) return { status: "not_found" as const };
      const needle = JSON.stringify([{ scheduleIds: [id] }]);
      const policies = await db.select({ name: schema.escalationPolicy.name, projectId: schema.escalationPolicy.projectId }).from(schema.escalationPolicy)
        .where(and(eq(schema.escalationPolicy.organizationId, orgId), sql`${schema.escalationPolicy.steps} @> ${needle}::jsonb`));
      const projects = await db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project)
        .where(and(eq(schema.project.organizationId, orgId), sql`${schema.project.escalation} @> ${needle}::jsonb`));
      if (policies.length || projects.length) {
        // a project-limited key learns only the names it could read anyway; the rest is a count
        const visible = (projectId: string | null) => !scope || projectId === null || scope.includes(projectId);
        const named = [...policies.filter((p) => visible(p.projectId)).map((p) => `escalation policy ${p.name}`), ...projects.filter((p) => visible(p.id)).map((p) => `project ${p.name} escalation`)];
        const hidden = policies.length + projects.length - named.length;
        return { status: "in_use" as const, usedBy: hidden ? [...named, `${hidden} in other projects`] : named };
      }
      const gone = await db.delete(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId), version === undefined ? undefined : eq(t.version, version))).returning({ id: t.id });
      return gone.length ? { status: "deleted" as const, projectId: found.projectId } : { status: "conflict" as const };
    },

    async listOncallOverrides(orgId, scheduleIds, from, to) {
      if (!scheduleIds.length) return [];
      const o = schema.oncallOverride;
      return db.select({ id: o.id, scheduleId: o.scheduleId, userId: o.userId, startsAt: o.startsAt, endsAt: o.endsAt, createdBy: o.createdBy, createdAt: o.createdAt })
        .from(o)
        .where(and(eq(o.organizationId, orgId), inArray(o.scheduleId, scheduleIds), gt(o.endsAt, from), lt(o.startsAt, to)))
        .orderBy(asc(o.startsAt), asc(o.createdAt));
    },
    async createOncallOverride(orgId, scheduleId, v, limits) {
      return db.transaction(async (tx) => {
        const [s] = await tx.select({ id: schema.oncallSchedule.id }).from(schema.oncallSchedule).where(and(eq(schema.oncallSchedule.id, scheduleId), eq(schema.oncallSchedule.organizationId, orgId)));
        if (!s) return null;
        const o = schema.oncallOverride;
        if (limits) {
          // counted under a per-schedule lock: concurrent requests queue here instead of all passing the same count
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"oncall-override:" + scheduleId}))`);
          const [{ total, mine }] = await tx
            .select({ total: sql<number>`count(*)::int`, mine: sql<number>`count(*) filter (where ${o.userId} = ${v.userId})::int` })
            .from(o)
            .where(and(eq(o.scheduleId, scheduleId), gt(o.endsAt, sql`now()`)));
          if (total >= limits.perSchedule) return "limit_schedule" as const;
          if (mine >= limits.perUser) return "limit_user" as const;
        }
        const [row] = await tx.insert(o).values({ organizationId: orgId, scheduleId, userId: v.userId, startsAt: v.startsAt, endsAt: v.endsAt, createdBy: v.createdBy })
          .returning({ id: o.id, scheduleId: o.scheduleId, userId: o.userId, startsAt: o.startsAt, endsAt: o.endsAt, createdBy: o.createdBy, createdAt: o.createdAt });
        return row;
      });
    },
    async getOncallOverride(orgId, scheduleId, id) {
      const o = schema.oncallOverride;
      const [row] = await db.select({ id: o.id, scheduleId: o.scheduleId, userId: o.userId, startsAt: o.startsAt, endsAt: o.endsAt, createdBy: o.createdBy, createdAt: o.createdAt })
        .from(o).where(and(eq(o.id, id), eq(o.scheduleId, scheduleId), eq(o.organizationId, orgId)));
      return row ?? null;
    },
    async deleteOncallOverride(orgId, scheduleId, id) {
      const o = schema.oncallOverride;
      const [row] = await db.delete(o).where(and(eq(o.id, id), eq(o.scheduleId, scheduleId), eq(o.organizationId, orgId)))
        .returning({ id: o.id, scheduleId: o.scheduleId, userId: o.userId, startsAt: o.startsAt, endsAt: o.endsAt, createdBy: o.createdBy, createdAt: o.createdAt });
      return row ?? null;
    },

    async listEscalationPolicies(orgId, scope) {
      const t = schema.escalationPolicy;
      return (await db.select().from(t).where(and(eq(t.organizationId, orgId), readable(scope, t.projectId))).orderBy(asc(t.name), asc(t.createdAt))).map(toPolicy);
    },
    async getEscalationPolicy(orgId, id, scope) {
      const t = schema.escalationPolicy;
      const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), readable(scope, t.projectId)));
      return row ? toPolicy(row) : null;
    },
    async createEscalationPolicy(orgId, p) {
      const [row] = await db.insert(schema.escalationPolicy).values({ organizationId: orgId, projectId: p.projectId, name: p.name, steps: p.steps, repeatCount: p.repeatCount }).returning();
      return toPolicy(row);
    },
    async updateEscalationPolicy(orgId, id, scope, version, patch) {
      const t = schema.escalationPolicy;
      const [row] = await db
        .update(t)
        .set({
          version: sql`${t.version} + 1`, updatedAt: sql`now()`,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
          ...(patch.repeatCount !== undefined ? { repeatCount: patch.repeatCount } : {}),
        })
        .where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId), eq(t.version, version)))
        .returning();
      if (row) return toPolicy(row);
      const [exists] = await db.select({ id: t.id }).from(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId)));
      return exists ? ("conflict" as const) : null;
    },
    async deleteEscalationPolicy(orgId, id, scope, version) {
      const t = schema.escalationPolicy;
      const [found] = await db.select({ id: t.id }).from(t).where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId)));
      if (!found) return { status: "not_found" as const };
      return db.transaction(async (tx) => {
        // the row lock decides between concurrent deletes and edits; a stale version changes nothing
        const [locked] = await tx.select({ id: t.id, name: t.name, projectId: t.projectId }).from(t)
          .where(and(eq(t.id, id), eq(t.organizationId, orgId), writable(scope, t.projectId), version === undefined ? undefined : eq(t.version, version)))
          .for("update");
        if (!locked) return { status: "conflict" as const };
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.monitor).where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.escalationPolicyId, id)));
        // Open incidents that were escalating under this policy stop escalating: their level counts the policy's steps,
        // which mean nothing for the project's levels. The timeline says so; reminders and acknowledgement are unchanged.
        const stopped = (await tx.execute(sql`update incident i set next_escalation_at = null
          from monitor m
          where m.id = i.monitor_id and m.organization_id = ${orgId} and m.escalation_policy_id = ${id}
            and i.resolved_at is null and i.acknowledged_at is null and i.next_escalation_at is not null
          returning i.id`)) as unknown as { id: string }[];
        for (const r of stopped) {
          await tx.execute(sql`insert into incident_update (incident_id, status, body, visibility, by_person)
            select i.id, i.status, ${`Escalation stopped: the escalation policy ${locked.name} was deleted.`}, 'internal', false from incident i where i.id = ${r.id}`);
        }
        await tx.delete(t).where(and(eq(t.id, id), eq(t.organizationId, orgId)));
        return { status: "deleted" as const, monitors: n, projectId: locked.projectId };
      });
    },
    async monitorsUsingPolicy(orgId, policyId, scope = null) {
      return db.select({ id: schema.monitor.id, name: schema.monitor.name }).from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.escalationPolicyId, policyId), scope ? inArray(schema.monitor.projectId, scope) : undefined)).orderBy(asc(schema.monitor.name));
    },

    async createOncallCalendarToken(orgId, userId, tokenHash) {
      const t = schema.oncallCalendarToken;
      return db.transaction(async (tx) => {
        await tx.update(t).set({ revokedAt: sql`now()` }).where(and(eq(t.organizationId, orgId), eq(t.userId, userId), isNull(t.revokedAt)));
        const [row] = await tx.insert(t).values({ organizationId: orgId, userId, tokenHash }).returning({ id: t.id, createdAt: t.createdAt });
        return row;
      });
    },
    async revokeOncallCalendarTokens(orgId, userId) {
      const t = schema.oncallCalendarToken;
      return (await db.update(t).set({ revokedAt: sql`now()` }).where(and(eq(t.organizationId, orgId), eq(t.userId, userId), isNull(t.revokedAt))).returning({ id: t.id })).length;
    },
    async oncallCalendarByToken(tokenHash) {
      const t = schema.oncallCalendarToken;
      // a person removed from the workspace loses their feed with their membership
      const [row] = await db
        .update(t)
        .set({ lastUsedAt: sql`now()` })
        .where(and(eq(t.tokenHash, tokenHash), isNull(t.revokedAt), sql`exists (select 1 from member m where m.organization_id = ${t.organizationId} and m.user_id = ${t.userId})`))
        .returning({ organizationId: t.organizationId, userId: t.userId });
      return row ?? null;
    },
    async oncallCalendarStatus(orgId, userId) {
      const t = schema.oncallCalendarToken;
      const [row] = await db.select({ createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }).from(t)
        .where(and(eq(t.organizationId, orgId), eq(t.userId, userId), isNull(t.revokedAt))).orderBy(desc(t.createdAt)).limit(1);
      return row ?? null;
    },

    async incidentFollowUpState(incidentId) {
      const [row] = await db.select({ acknowledgedAt: schema.incident.acknowledgedAt, resolvedAt: schema.incident.resolvedAt }).from(schema.incident).where(eq(schema.incident.id, incidentId));
      return row ?? null;
    },
    async recordEscalationNotice(n) {
      await db.transaction(async (tx) => {
        // Team-only timeline entry, written with the incident's current status and only while it is unresolved: a
        // "resolved" row from the system must never stand in for a person's resolution.
        await tx.execute(sql`insert into incident_update (incident_id, status, body, visibility, by_person)
          select i.id, i.status, ${n.body.slice(0, 4000)}, 'internal', false from incident i
          where i.id = ${n.incidentId} and i.organization_id = ${n.organizationId} and i.resolved_at is null`);
        const projectId = n.projectId && /^[0-9a-f-]{36}$/i.test(n.projectId) ? n.projectId : null;
        const rows = [
          { organizationId: n.organizationId, projectId, actorType: "system", actorId: null, actorLabel: "Escalation", action: "incident.escalate", targetType: "incident", targetId: n.incidentId,
            changes: { fields: ["level", "userIds", "channelIds", ...(n.scheduleIds?.length ? ["scheduleIds"] : []), ...(n.policyId ? ["policyId"] : [])], values: { level: n.level, count: n.userIds.length + n.channelCount } } },
          ...n.userIds.map((userId) => ({ organizationId: n.organizationId, projectId, actorType: "system", actorId: null, actorLabel: "Escalation", action: "incident.escalation_notify", targetType: "user", targetId: userId,
            changes: { fields: ["incidentId", "level"], values: { level: n.level } } })),
        ];
        await tx.insert(schema.auditEvent).values(rows);
      });
    },
  } satisfies Partial<Repo>;
  return methods;
}
