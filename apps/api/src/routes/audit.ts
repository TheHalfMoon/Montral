import { zValidator } from "../bounded-validator";
import { Hono } from "hono";
import { z } from "zod";
import { audit, auditChanges, AUDIT_EXPORT_CAP, decodeCursor, exportAuditEvents, listAuditEvents, type AuditFilters } from "../audit";
import type { AppEnv } from "../env";
import { requireManager } from "../middleware";

const filterShape = {
  /** a prefix: "monitor" matches monitor.create and monitor.delete, "status_page.domain" the domain actions */
  action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
  actorId: z.string().min(1).max(200).optional(),
  targetType: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  targetId: z.string().min(1).max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
};
const listQuery = z.object({ ...filterShape, cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const exportQuery = z.object({ ...filterShape, format: z.enum(["csv", "jsonl"]).default("csv") }).strict();

const toFilters = (q: z.infer<typeof listQuery> | z.infer<typeof exportQuery>): AuditFilters => ({
  action: q.action, actorId: q.actorId, targetType: q.targetType, targetId: q.targetId,
  from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined,
});

/**
 * The workspace audit log, for owners and admins (members get 403). It spans every project of the workspace, so a
 * credential limited to some projects cannot read it either.
 */
export const auditEvents = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    // actor emails, IP addresses and what changed: never cached or indexed, on denials too
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    await next();
  })
  .use("*", requireManager)
  .use("*", async (c, next) => {
    if (c.get("projectScope")) return c.json({ error: "The audit log covers the whole workspace; this API key or authorization is limited to specific projects" }, 403);
    await next();
  })
  .get("/", zValidator("query", listQuery), async (c) => {
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return c.json({ error: "Invalid cursor" }, 400);
    const database = c.get("database");
    return c.json(await listAuditEvents((sql, params) => database.query(sql, params), c.get("orgId"), toFilters(q), { limit: q.limit, cursor }));
  })
  .get("/export", zValidator("query", exportQuery), async (c) => {
    const q = c.req.valid("query");
    const database = c.get("database");
    // exporting the log is itself recorded: the format and which filters were used, never their values
    const { format, ...filters } = q;
    await audit(c, "audit.export", { type: "audit_log", id: null, projectId: null }, auditChanges(filters, { format }));
    // the stream reads after this handler has returned: keep the request's database open until it is finished
    let release!: () => void;
    c.set("databaseHeldUntil", new Promise<void>((resolve) => { release = resolve; }));
    const stream = exportAuditEvents((sql, params) => database.query(sql, params), c.get("orgId"), toFilters(q), q.format, { cap: AUDIT_EXPORT_CAP, done: () => release() });
    const day = new Date().toISOString().slice(0, 10);
    c.header("content-type", q.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
    c.header("content-disposition", `attachment; filename="montral-audit-${day}.${q.format}"`);
    return c.body(stream);
  });
