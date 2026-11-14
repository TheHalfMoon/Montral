import { zValidator } from "../bounded-validator";
import { Hono } from "hono";
import { z } from "zod";
import { deliver, safeDeliveryReason } from "../alerts";
import { apnsConfigured } from "../apns";
import type { AppEnv } from "../env";
import { isManager, requireManager, uuidParams } from "../middleware";
import { audit, auditChanges } from "../audit";
import { urlProblem } from "../netguard";
import { maskConfig, restoreConfig, sameJson } from "../secrets";

const TYPES = ["email", "slack", "telegram", "webhook", "pagerduty", "lark", "push", "discord", "teams", "ntfy", "googlechat", "mattermost", "gotify", "pushover"] as const;
type ChannelType = (typeof TYPES)[number];

const url = z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");
/** What each channel type needs; anything else in `config` is dropped. */
const CONFIG: Record<ChannelType, z.ZodType<Record<string, unknown>>> = {
  email: z.object({ to: z.string().trim().max(254).email() }),
  slack: z.object({ url }),
  discord: z.object({ url }),
  teams: z.object({ url }),
  ntfy: z.object({
    url: url.refine((v) => { const u = new URL(v); return u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password; }, "Use the server origin without a topic, query or credentials"),
    topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use 1–64 letters, digits, underscores or hyphens"),
    // printable ASCII only: anything else cannot be sent in a header and would surface as "Could not reach host"; empty clears it
    token: z.string().trim().max(500).regex(/^[\x20-\x7E]*$/, "Use printable ASCII characters only").transform((v) => v || undefined).optional(),
    priority: z.enum(["1", "2", "3", "4", "5"]).default("3"),
  }).refine((v) => !v.token || v.url.toLowerCase().startsWith("https://"), { path: ["token"], message: "An access token is only sent to an https:// server" }),
  /** an incoming webhook of a Chat space: always https://chat.googleapis.com/v1/spaces/<space>/messages?key=…&token=… */
  googlechat: z.object({
    url: url.refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && u.host === "chat.googleapis.com" && /^\/v1\/spaces\/[^/]+\/messages$/.test(u.pathname) && u.searchParams.has("key") && u.searchParams.has("token") && !u.username && !u.password && !u.hash;
    }, "Use the webhook URL Google Chat gives you (https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…)"),
  }),
  /** self-hosted: any server the SSRF guard allows, http included; the hook id in the path is the credential */
  mattermost: z.object({
    url: url.refine((v) => { const u = new URL(v); return /\/hooks\/[A-Za-z0-9]+$/.test(u.pathname) && !u.username && !u.password && !u.hash; }, "Use the incoming webhook URL (https://<your server>/hooks/<id>)"),
  }),
  /** the server's base URL (a reverse-proxy path prefix is fine); the token travels in a header, so only to https */
  gotify: z.object({
    url: url.refine((v) => { const u = new URL(v); return !u.search && !u.hash && !u.username && !u.password && !/\/message\/?$/.test(u.pathname); }, "Use the server URL without /message, a query or credentials")
      .refine((v) => v.toLowerCase().startsWith("https://"), "An application token is only sent to an https:// server"),
    token: z.string().trim().min(1).max(200).regex(/^[\x21-\x7E]+$/, "Use the application token as shown in Gotify"),
  }),
  /** Pushover's app tokens and user/group keys are 30 letters and digits; devices are comma-separated names of up to 25 */
  pushover: z.object({
    token: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, "Use the 30-character application token"),
    userKey: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, "Use the 30-character user or group key"),
    device: z.string().trim().max(200).regex(/^([A-Za-z0-9_-]{1,25}(,[A-Za-z0-9_-]{1,25})*)?$/, "Use device names (letters, digits, _ or -), comma-separated").transform((v) => v || undefined).optional(),
  }),
  webhook: z.object({ url }),
  lark: z.object({ url, secret: z.string().max(200).optional() }),
  telegram: z.object({ botToken: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(100) }),
  pagerduty: z.object({ routingKey: z.string().trim().min(1).max(200) }),
  /** every member's registered phones; nothing to configure */
  push: z.object({}),
};
/** Exported for unit tests of the per-type settings. */
export const parseConfig = (type: ChannelType, config: unknown) => CONFIG[type].safeParse(config);
const configError = (e: z.ZodError) => `Invalid channel settings: ${e.issues.map((i) => `${i.path.join(".") || "config"} ${i.message}`).join("; ")}`;

/** A webhook-style URL must point at a public address (see netguard.ts). */
async function configProblem(config: Record<string, unknown>): Promise<string | null> {
  return typeof config.url === "string" ? urlProblem(config.url) : null;
}

const body = z.object({
  type: z.enum(TYPES),
  name: z.string().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  /** New monitors of this project start out alerting this channel. */
  autoEnable: z.boolean().default(false),
  /** "workspace" (default): shared by every project. "project": only the active project. */
  scope: z.enum(["workspace", "project"]).default("workspace"),
});

/** Credentials in the settings are shown to owners and admins only. */
const shown = async <T extends { config: unknown }>(c: Parameters<typeof isManager>[0], rows: T[]) =>
  (await isManager(c)) ? rows : rows.map((r) => ({ ...r, config: maskConfig(r.config as Record<string, unknown>) }));

export const channels = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await shown(c, await c.get("repo").listChannels(c.get("orgId"), c.get("projectId")))))
  .post("/", zValidator("json", body), async (c) => {
    const v = c.req.valid("json");
    if (v.type === "push" && !apnsConfigured()) return c.json({ error: "Push notifications are not set up on this server. Configure APNs first (see the self-hosting docs).", code: "push_not_configured" }, 400);
    const cfg = parseConfig(v.type, v.config);
    if (!cfg.success) return c.json({ error: configError(cfg.error) }, 400);
    const refused = await configProblem(cfg.data);
    if (refused) return c.json({ error: refused, code: "target_not_allowed" }, 400);
    // a key limited to some projects cannot create what other projects would share
    const projectId = v.scope === "project" || c.get("projectScope") ? c.get("projectId") : null;
    const { scope: _scope, ...channel } = v;
    const created = await c.get("repo").createChannel(c.get("orgId"), projectId, { ...channel, config: cfg.data });
    // "config" is recorded by name only: it holds webhook URLs, bot tokens and routing keys
    await audit(c, "channel.create", { type: "channel", id: created.id, projectId }, auditChanges(v));
    return c.json((await shown(c, [created]))[0], 201);
  })
  .patch("/:id", uuidParams, zValidator("json", z.object({ name: z.string().min(1).max(80).optional(), enabled: z.boolean().optional(), autoEnable: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() })), async (c) => {
    const repo = c.get("repo");
    const patch = c.req.valid("json");
    if (patch.config) {
      // the settings are checked against the channel's own type
      const current = await repo.getChannel(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      // placeholders stand for the stored credential; settings that end up identical are not a change
      const next = restoreConfig(patch.config, current.config as Record<string, unknown>);
      if (sameJson(next, current.config)) delete patch.config;
      else {
        // where alerts go (and the credentials used) is a manager's call; a member may still rename or toggle
        if (!(await isManager(c))) return c.json({ error: "Only workspace owners and admins can change a channel's destination" }, 403);
        const cfg = parseConfig(current.type as ChannelType, next);
        if (!cfg.success) return c.json({ error: configError(cfg.error) }, 400);
        const refused = await configProblem(cfg.data);
        if (refused) return c.json({ error: refused, code: "target_not_allowed" }, 400);
        patch.config = cfg.data;
      }
    }
    const row = await repo.updateChannel(c.get("orgId"), c.req.param("id"), c.get("projectScope"), patch);
    if (!row) return c.json({ error: "Not found" }, 404);
    await audit(c, "channel.update", { type: "channel", id: row.id, projectId: row.projectId }, auditChanges(patch));
    return c.json((await shown(c, [row]))[0]);
  })
  // sends a harmless test message so people can verify the destination before an outage
  .post("/:id/test", uuidParams, async (c) => {
    const repo = c.get("repo");
    // each call makes an outbound request to a destination of the caller's choosing
    if (!(await repo.withinLimit(`chtest:${c.get("userId")}`, 20, 600))) return c.json({ error: "Too many test messages, try again in a few minutes" }, 429);
    const ch = await repo.getChannel(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!ch) return c.json({ error: "Not found" }, 404);
    const log = (error: string | null) =>
      repo.logDeliveries([{ organizationId: ch.organizationId, projectId: ch.projectId, channelId: ch.id, channelName: ch.name, channelType: ch.type, kind: "test", ok: !error, error, statusMessage: error && (error.startsWith("skipped:") ? error : `failed: ${error}`), status: !error ? "sent" : error.startsWith("skipped:") ? "skipped" : "failed" }]);
    try {
      await deliver(ch, { kind: "incident.resolved", incident: { id: crypto.randomUUID(), title: "Test alert" }, monitor: { name: "Montral test", target: "" }, test: true }, "🔔 Test alert from Montral — this channel is connected.", "en", repo);
      await log(null);
      return c.json({ ok: true });
    } catch (e) {
      // SMTP, push and third-party webhook exceptions can include credentials,
      // private recipients, and token-bearing destination paths. Never relay or
      // persist raw provider errors via this user-triggered test endpoint.
      const error = safeDeliveryReason(e);
      await log(error).catch(() => console.error("channel test delivery audit unavailable"));
      return c.json({ error }, 502);
    }
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const id = c.req.param("id");
    // a channel some monitors still alert through is only removed once they have let go of it
    const using = await repo.monitorsUsingChannel(c.get("orgId"), id);
    if (using.length) {
      const names = using.slice(0, 5).map((m) => m.name).join(", ") + (using.length > 5 ? ", …" : "");
      return c.json({ error: `This channel is used by ${using.length} monitor${using.length === 1 ? "" : "s"} (${names}). Turn it off on ${using.length === 1 ? "that monitor" : "those monitors"} before removing it.`, code: "channel_in_use", monitors: using }, 409);
    }
    const existing = await repo.getChannel(c.get("orgId"), id, c.get("projectScope"));
    await repo.deleteChannel(c.get("orgId"), id, c.get("projectScope"));
    if (existing) await audit(c, "channel.delete", { type: "channel", id: existing.id, projectId: existing.projectId }, auditChanges({}, { name: existing.name, type: existing.type }));
    return c.body(null, 204);
  });
