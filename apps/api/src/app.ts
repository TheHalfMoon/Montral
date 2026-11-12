import type { OpenDatabase } from "@montral/repo";
import { isLang } from "./mail-i18n";
import { Hono, type Context, type ErrorHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createAuth, currentSession, NATIVE_CALLBACK, signupDisabled, slugify, turnstile } from "./auth";
import { connectionString, type AppEnv } from "./env";
import { mountMcp } from "./mcp-route";
import { isManager, rejectInAllProjects, requireOrg, ssoAllowsPrincipal } from "./middleware";
import { alertLog, settings } from "./routes/alert-log";
import { auditEvents } from "./routes/audit";
import { channels } from "./routes/channels";
import { push } from "./routes/push";
import { incidents } from "./routes/incidents";
import { maintenance } from "./routes/maintenance";
import { escalationPolicies, oncall } from "./routes/oncall";
import { icsFeed, personalShifts, tokenHash } from "./oncall";
import { monthlyReconciliation } from "./routes/monthly-reconciliation";
import { monitors } from "./routes/monitors";
import { projects } from "./routes/projects";
import { publicStatus, statusPages } from "./routes/status";
import { configureEmail, emailEnabled } from "./email";
import { apnsConfigured, configureApns } from "./apns";
import { configureNetGuard } from "./netguard";
import { configureSso } from "./sso-oidc";
import { instanceConnection, ssoAllows, ssoSatisfiesAll } from "./sso-store";
import { ssoAdmin } from "./routes/sso";
import { scimApi } from "./scim";
import { configureBrowserChecks } from "./browser-check";
import { configureProbes } from "./probes";
import { allow, clientIp, safeEqual } from "./ratelimit";
import { AuthBodyTimeoutError, limitedAuthBody } from "./auth-body-budget";
import { limitedJsonBody } from "./json-body-budget";
import { community, type Edition } from "./edition";
import { migrateMontralSchema } from "./schema-migrate";
import { availableRegions } from "./probes";
import { PROBE_TYPES } from "./regions";
import { completeRecovery, runDueChecks } from "./scheduler";
import { auditRetentionDays } from "./audit";
import { suspendedResponse, workspaceSuspended } from "./suspension";
import { allowanceResetUtc } from "./entitlements";
import { operatorApi } from "./operator";

export function createApp(openDatabase: OpenDatabase, options: { edition?: Edition } = {}) {
  const edition = options.edition ?? community;
  const app = new Hono<AppEnv>();

  // the database and auth are created per request: required on Workers (no cross-request I/O objects).
  app.use("*", async (c, next) => {
    configureEmail(c.env);
    configureNetGuard(c.env);
    configureSso(c.env);
    configureBrowserChecks(c.env);
    configureProbes(c.env);
    configureApns(c.env);
    const database = openDatabase(connectionString(c.env), { max: 1 });
    c.set("repo", database.repo);
    c.set("database", database);
    // an edition's request middleware may query after the route has answered (edition.ts): never release early then
    c.set("earlyDatabaseRelease", !edition.requestMiddleware);
    c.set("auth", createAuth(database, c.env));
    c.set("entitlements", edition.entitlements({ database, env: c.env }));
    try {
      await next();
    } finally {
      // a handler that gave the database back early (releaseDatabase) has closed it already
      if (!c.get("databaseReleased")) {
        // a streamed response (the audit export) still reads after the handler returned: close once it is done
        const held = c.get("databaseHeldUntil");
        const close = held ? held.then(() => database.close(1), () => database.close(1)) : database.close(1);
        try {
          c.executionCtx.waitUntil(close); // Workers
        } catch {
          // Node has no ExecutionContext. Awaiting a held database here would wait for a stream nobody can read yet.
          if (held) close.catch(() => console.error("database close failed; private diagnostics suppressed"));
          else await close;
        }
      }
    }
  });

  const privateCors = cors({
    origin: (origin, c) => (origin === c.env.WEB_ORIGIN ? origin : null),
    credentials: true,
    allowHeaders: ["content-type", "authorization", "x-api-key", "x-project-id", "x-workspace-id", "x-captcha-response", "mcp-protocol-version", "mcp-session-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  // status summaries and badges are public reads meant to be embedded on any site
  const publicCors = cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86400 });
  app.use("/api/*", (c, next) => (c.req.path.startsWith("/api/public/status/") && c.req.method !== "POST" ? publicCors(c, next) : privateCors(c, next)));

  // discovery documents are public and read by browser-based agent clients too
  app.use("/.well-known/*", cors({ origin: "*", allowMethods: ["GET"] }));

  // Register after CORS and before the routes (auth and MCP included), so a response or exception from the hook still
  // carries CORS headers. CORS answers preflights itself, so they never reach the hook. Request cleanup remains the
  // outermost middleware. The hook also sees /health and /internal/* requests.
  if (edition.requestMiddleware) app.use("*", edition.requestMiddleware);

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  // "Sign in with SSO" is offered when the operator configured OIDC_* or some workspace has an enabled connection
  const ssoOffered = async (c: Context<AppEnv>) => {
    if (instanceConnection(c.env)) return true;
    try {
      return (await c.get("database").query(`SELECT 1 AS one FROM sso_connection WHERE enabled LIMIT 1`)).length > 0;
    } catch {
      return false;
    }
  };
  const authInfo = async (c: Context<AppEnv>) => ({
    github: !!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    signup: !signupDisabled(c.env),
    turnstileSiteKey: turnstile(c.env)?.siteKey ?? null,
    legal: c.env.LEGAL_LINKS === "true",
    sso: await ssoOffered(c),
  });
  app.get("/api/auth-providers", async (c) => c.json(await authInfo(c)));
  // what this deployment can do, for clients that must adapt before anyone has signed in (the mobile app). Clients
  // read capabilities, never the edition name, so a hosted build only changes the values here.
  app.get("/api/config", async (c) =>
    c.json({
      apiVersion: 1,
      edition: edition.id ?? "community",
      auth: { emailPassword: true, ...(await authInfo(c)), emailDelivery: emailEnabled(), nativeHandoff: true },
      features: { multiRegion: availableRegions().length > 2, statusPages: true, webhooks: edition.id === "montral" },
      push: { apns: apnsConfigured() },
    }),
  );
  // password guessing, sign-up floods and mail bombing: the library's own limiter is per isolate on Workers, so the
  // endpoints that matter are counted in the database. A client address is used when it can be told; the email address
  // in the body always counts, so one account cannot be hammered from many addresses either.
  const AUTH_LIMITS: Record<string, { limit: number; windowSec: number; perEmail?: number }> = {
    "/api/auth/sign-in/email": { limit: 30, windowSec: 600, perEmail: 15 },
    "/api/auth/sign-up/email": { limit: 10, windowSec: 3600, perEmail: 3 },
    "/api/auth/two-factor/verify-totp": { limit: 30, windowSec: 600 },
    "/api/auth/two-factor/verify-backup-code": { limit: 30, windowSec: 600 },
    "/api/auth/request-password-reset": { limit: 5, windowSec: 3600, perEmail: 3 },
    "/api/auth/forget-password": { limit: 5, windowSec: 3600, perEmail: 3 },
    "/api/auth/reset-password": { limit: 20, windowSec: 3600 },
    "/api/auth/one-time-token/verify": { limit: 30, windowSec: 600 },
    "/api/auth/unlink-account": { limit: 20, windowSec: 600 },
    "/api/auth/send-verification-email": { limit: 5, windowSec: 3600, perEmail: 3 },
    "/api/auth/sso/start": { limit: 30, windowSec: 600 },
  };
  app.post("/api/auth/*", async (c, next) => {
    const rule = AUTH_LIMITS[c.req.path.replace(/\/+$/, "")];
    if (rule) {
      const repo = c.get("repo");
      const ip = clientIp(c);
      // A Node backend without a configured trusted proxy cannot reliably
      // identify the peer IP. Never skip all limits in that case: use a
      // conservative shared quota, plus the tighter per-account/email limit.
      // Production deployments should still supply a trusted IP at ingress.
      const limitKey = ip ? `auth:ip:${ip}:${c.req.path}` : `auth:unknown:${c.req.path}`;
      const cap = ip ? rule.limit : Math.max(300, rule.limit * 15);
      let ok = await allow(repo, limitKey, cap, rule.windowSec);
      if (ok && rule.perEmail) {
        let body: Awaited<ReturnType<typeof limitedAuthBody>>;
        try {
          body = await limitedAuthBody(c.req.raw);
        } catch (error) {
          if (error instanceof AuthBodyTimeoutError) {
            c.header("cache-control", "no-store");
            c.header("referrer-policy", "no-referrer");
            c.header("x-content-type-options", "nosniff");
            return c.json({ error: error.message }, 408);
          }
          throw error;
        }
        if (body.oversized) return c.json({ error: "Payload too large" }, 413);
        const email = body.email;
        if (typeof email === "string" && email) {
          const normalized = email.trim().toLowerCase();
          // Never store attacker-controlled megabyte-long rate-limit keys.
          if (normalized.length > 254) return c.json({ error: "Invalid email" }, 400);
          ok = await allow(repo, `auth:mail:${normalized}:${c.req.path}`, rule.perEmail, rule.windowSec);
        }
      }
      if (!ok) return c.json({ error: "Too many attempts, try again later" }, 429);
    }
    await next();
  });
  // Start of the native GitHub sign-in. The OAuth state lives in a cookie of whichever browser starts the flow, so the
  // app must not start it with its own HTTP client: it opens this URL inside ASWebAuthenticationSession, which is
  // redirected to GitHub with the state cookie set, and back through the callback to montral://auth?token=...
  app.get("/api/auth/native/github", async (c) => {
    if (!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET)) return c.json({ error: "GitHub sign-in is not configured" }, 404);
    const ip = clientIp(c);
    if (!(await allow(c.get("repo"), ip
      ? `auth:ip:${ip}:/api/auth/native/github`
      : "auth:unknown:/api/auth/native/github", ip ? 30 : 450, 600))) {
      return c.json({ error: "Too many attempts, try again later" }, 429);
    }
    const res = await c.get("auth").api.signInSocial({ body: { provider: "github", callbackURL: NATIVE_CALLBACK, errorCallbackURL: NATIVE_CALLBACK, disableRedirect: true }, headers: c.req.raw.headers, asResponse: true });
    const url = ((await res.json().catch(() => null)) as { url?: string } | null)?.url;
    if (!res.ok || !url) return c.json({ error: "Could not start GitHub sign-in" }, 502);
    const headers = new Headers({ location: url, "cache-control": "no-store" });
    for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  });
  // the SSO redirect URI makes outbound requests to the identity provider: counted per client address like sign-in
  app.get("/api/auth/sso/callback", async (c, next) => {
    const ip = clientIp(c);
    if (!(await allow(c.get("repo"), ip ? `auth:ip:${ip}:/api/auth/sso/callback` : "auth:unknown:/api/auth/sso/callback", ip ? 30 : 450, 600))) {
      return c.json({ error: "Too many attempts, try again later" }, 429);
    }
    await next();
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));

  // public
  app.route("/api/public/status", publicStatus);
  // SCIM 2.0 provisioning by the workspace's identity provider; its own bearer token, never a session (scim.ts)
  app.route("/api/scim/v2", scimApi);
  // platform staff (MONTRAL_OPERATOR_USER_IDS, signed-in session with two-factor): never workspace-scoped, so outside
  // requireOrg; see operator.ts and docs/OPERATOR.md
  app.route("/api/operator", operatorApi);
  // a person's on-call shifts as an iCalendar feed; the secret token in the path is the only credential (revocable)
  app.get("/api/public/oncall/:file", async (c) => {
    const m = /^([0-9a-f]{64})\.ics$/.exec(c.req.param("file"));
    if (!m) return c.json({ error: "Not found" }, 404);
    const repo = c.get("repo");
    const ip = clientIp(c);
    const hash = await tokenHash(m[1]);
    // With a known client address it is limited per address. Without one (no trusted proxy) a shared bucket would let
    // anyone lock every feed out with random tokens, so the token is looked up first and only a real feed is limited,
    // per token; guessing a 256-bit token is not a concern.
    if (ip && !(await allow(repo, `oncall-ics:ip:${ip}`, 120, 3600))) return c.json({ error: "Too many requests, try again later" }, 429);
    const owner = await repo.oncallCalendarByToken(hash);
    if (!owner) return c.json({ error: "Not found" }, 404);
    // the shifts of a suspended workspace are not served (docs/OPERATOR.md)
    const database = c.get("database");
    if (await workspaceSuspended((sql, params) => database.query(sql, params), owner.organizationId)) return c.json({ error: "Not found" }, 404);
    if (!ip && !(await allow(repo, `oncall-ics:token:${hash}`, 120, 3600))) return c.json({ error: "Too many requests, try again later" }, 429);
    return new Response(icsFeed(await personalShifts(repo, owner.organizationId, owner.userId)), {
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
    });
  });
  app.on(["GET", "POST"], "/api/heartbeat/:token", async (c) => {
    const repo = c.get("repo");
    const m = await repo.monitorByHeartbeatToken(c.req.param("token"));
    if (!m) return c.json({ error: "Unknown token" }, 404);
    // a suspended workspace records nothing: no check, no recovery, no alert
    const database = c.get("database");
    if (await workspaceSuspended((sql, params) => database.query(sql, params), m.organizationId)) return suspendedResponse(c);
    // a paused monitor stays paused: the ping is acknowledged but changes nothing
    if (m.status === "paused") return c.json({ ok: true, paused: true });
    const accepted = await repo.recordHeartbeatObservation(m);
    if (!accepted) return c.json({ ok: true, paused: true });
    await repo.recordCheck({ monitorId: m.id, ok: true });
    const wasDown = accepted.status === "down";
    const ready = (accepted.consecutiveSuccesses ?? 0) >= (accepted.recoveryThreshold ?? 1);
    // the status stays "down" until the incident is resolved, so a failed resolve is retried by the next ping
    if (wasDown && ready) {
      await completeRecovery(repo, accepted, "up", 0, c.get("entitlements"));
    }
    return c.json({ ok: true });
  });

  // trigger checks from an external scheduler when Workers Cron is not available
  app.post("/internal/run-checks", async (c) => {
    if (!c.env.CRON_SECRET || !safeEqual(c.req.header("x-cron-secret"), c.env.CRON_SECRET)) return c.json({ error: "Forbidden" }, 403);
    return c.json({ checked: await runDueChecks(c.get("repo"), c.env.CHECK_QUEUE, c.get("entitlements"), { monthlyReportsPaused: c.env.MONTRAL_MONTHLY_REPORTS_PAUSED === "true", auditRetentionDays: auditRetentionDays(c.env) }) });
  });

  // applies pending migrations over HTTP, for deployments that cannot run `pnpm db:migrate` from a shell
  app.post("/internal/migrate", async (c) => {
    if (!c.env.CRON_SECRET || !safeEqual(c.req.header("x-cron-secret"), c.env.CRON_SECRET)) return c.json({ error: "Forbidden" }, 403);
    const database = c.get("database");
    return c.json({ applied: await migrateMontralSchema(database, edition) });
  });

  mountMcp(app, edition.mcpTools);

  // the authorization screen's picker: the signed-in user's workspaces with their projects (before any workspace is active)
  app.get("/api/oauth/picker", async (c) => {
    const session = await currentSession(c.get("auth"), c.req.raw.headers);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const repo = c.get("repo");
    const db = c.get("database");
    // workspaces that require single sign-on are only offered to a session their connection created
    const all = await repo.workspacesOf(session.user.id);
    const allowed = await Promise.all(all.map((w) => ssoAllows((sql, params) => db.query(sql, params), w.id, session.user.id, session.session.id)));
    const spaces = all.filter((_, i) => allowed[i]);
    const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    return c.json({
      active: active && spaces.some((w) => w.id === active) ? active : (spaces[0]?.id ?? null),
      workspaces: await Promise.all(spaces.map(async (w) => ({ ...w, projects: (await repo.listProjects(w.id, null)).map((p) => ({ id: p.id, name: p.name })) }))),
    });
  });

  // authenticated
  const authed = new Hono<AppEnv>();
  authed.use("*", requireOrg);
  // routes that act on the active project: in the "All projects" view only their reads work
  for (const path of ["/monitors", "/incidents", "/channels", "/alert-log", "/maintenance", "/status-pages"]) authed.use(`${path}/*`, rejectInAllProjects);
  authed.route("/projects", projects);
  authed.route("/monitors", monitors);
  authed.route("/incidents", incidents);
  authed.route("/channels", channels);
  authed.route("/push", push);
  authed.route("/alert-log", alertLog);
  authed.route("/settings", settings);
  authed.route("/maintenance", maintenance);
  authed.route("/monthly-reconciliation", monthlyReconciliation);
  authed.route("/status-pages", statusPages);
  authed.route("/audit-events", auditEvents);
  // on-call schedules and escalation policies belong to the workspace (optionally to one project), not to the active project
  authed.route("/oncall", oncall);
  authed.route("/escalation-policies", escalationPolicies);
  authed.route("/sso", ssoAdmin);
  // what this credential may reach: a session sees every workspace of the user, a key or an agent only what it was given
  authed.get("/workspaces", async (c) => {
    const repo = c.get("repo");
    const granted = c.get("workspaceGrant");
    let spaces = await repo.workspacesOf(c.get("userId"));
    if (granted instanceof Map) spaces = spaces.filter((w) => granted.has(w.id));
    // a workspace that requires single sign-on is not listed (names, projects) to a credential it would refuse
    const allowed = await Promise.all(spaces.map((w) => ssoAllowsPrincipal(c, w.id, c.get("userId"))));
    spaces = spaces.filter((_, i) => allowed[i]);
    const workspaces = await Promise.all(
      spaces.map(async (w) => ({
        id: w.id,
        name: w.name,
        projects: (await repo.listProjects(w.id, granted instanceof Map ? (granted.get(w.id) ?? null) : null)).map((p) => ({ id: p.id, name: p.name })),
      })),
    );
    return c.json({ current: { workspace: c.get("orgId"), project: c.get("projectId") }, workspaces });
  });
  // a new workspace (with its first project): for sessions and for agents authorized for every workspace, never for
  // keys or agents that were given specific workspaces
  authed.post("/workspaces", async (c) => {
    const granted = c.get("workspaceGrant");
    if (granted !== null && granted !== "all") return c.json({ error: "This API key or authorization is limited to specific workspaces" }, 403);
    const name = String(((await limitedJsonBody(c.req.raw, 1024)) as { name?: unknown } | null)?.name ?? "").trim();
    if (!name || name.length > 60) return c.json({ error: "name must be 1 to 60 characters" }, 400);
    const repo = c.get("repo");
    const userId = c.get("userId");
    if ((await repo.ownedWorkspaces(userId)).length >= 10) return c.json({ error: "You can own at most 10 workspaces" }, 400);
    const id = crypto.randomUUID();
    await repo.createPersonalWorkspace({ id, name, slug: slugify(name), ownerId: userId });
    return c.json({ id, name, projects: (await repo.listProjects(id, null)).map((p) => ({ id: p.id, name: p.name })) }, 201);
  });
  authed.get("/me", async (c) => {
    const repo = c.get("repo");
    const [organization, user] = await Promise.all([repo.organization(c.get("orgId")), repo.userProfile(c.get("userId"))]);
    return c.json({ userId: c.get("userId"), user, organization, projectId: c.get("projectId") });
  });
  // Onboarding dismissal is a personal preference scoped to the active workspace.
  // API keys and OAuth agents cannot read/write a human browser's preference.
  authed.get("/onboarding/dismissal", async (c) => {
    if (c.get("workspaceGrant") !== null) return c.json({ error: "A signed-in session is required" }, 403);
    c.header("cache-control", "private, no-store");
    return c.json({ dismissed: await c.get("repo").onboardingDismissed(c.get("userId"), c.get("orgId")) });
  });
  authed.post("/onboarding/dismissal", async (c) => {
    if (c.get("workspaceGrant") !== null) return c.json({ error: "A signed-in session is required" }, 403);
    await c.get("repo").dismissOnboarding(c.get("userId"), c.get("orgId"));
    c.header("cache-control", "private, no-store");
    return c.json({ dismissed: true });
  });
  // everything we hold about this user (GDPR export); workspace contents only for workspaces they own or administer
  // interactive sessions only: an API key or agent token (even a project-limited one) never gets the whole account
  authed.get("/me/export", async (c) => {
    if (c.get("workspaceGrant") !== null) return c.json({ error: "Account export needs a signed-in session, not an API key or agent authorization" }, 403);
    // the export holds the contents of workspaces the user owns or administers: every require-SSO one among them must
    // accept this session
    const proof = c.get("ssoProof");
    const db = c.get("database");
    if (!(await ssoSatisfiesAll((sql, params) => db.query(sql, params), c.get("userId"), proof?.id ?? ""))) {
      return c.json({ error: "A workspace of yours requires single sign-on: sign in with SSO to export your account" }, 403);
    }
    c.header("content-disposition", 'attachment; filename="montral-account-export.json"');
    return c.json({ exportedAt: new Date().toISOString(), ...(await c.get("repo").exportAccount(c.get("userId"))) });
  });
  // preferred language for emails sent to this user
  authed.patch("/me/locale", async (c) => {
    if (c.get("workspaceGrant") !== null) return c.json({ error: "This needs a signed-in session, not an API key or agent authorization" }, 403);
    const body = (await limitedJsonBody(c.req.raw, 1024)) as { locale?: unknown } | null;
    if (!isLang(body?.locale)) return c.json({ error: "Unsupported language" }, 400);
    await c.get("repo").setUserLocale(c.get("userId"), body.locale);
    return c.json({ locale: body.locale });
  });
  // plan, allowances and usage of the active workspace; `metered: false` when this deployment has no plans or limits
  authed.get("/usage", async (c) => {
    const e = c.get("entitlements");
    const orgId = c.get("orgId");
    const [credits, emails, plan, activeMonitors, webhookEvents, browserSeconds] = await Promise.all([
      e.creditBalance(orgId), e.emailBalance(orgId), e.plan(orgId), c.get("repo").activeMonitorCount(orgId),
      e.meterBalance ? e.meterBalance(orgId, "webhookEvents") : null, e.meterBalance ? e.meterBalance(orgId, "browserSeconds") : null,
    ]);
    if (!credits && !emails && !plan) return c.json({ metered: false });
    // when the allowances reset: every meter of this preview counts the calendar month in UTC
    const periodEnd = (credits ?? emails ?? webhookEvents ?? browserSeconds)?.periodEnd ?? allowanceResetUtc();
    const canManageBilling = await isManager(c);
    return c.json({ metered: true, ...(credits ?? {}), periodEnd, credits, emails, webhookEvents, browserSeconds, plan, activeMonitors, canManageBilling });
  });
  // where checks can run from on this deployment, and how many of those one monitor may use under the workspace's plan (null: no limit)
  authed.get("/regions", async (c) => {
    const plan = await c.get("entitlements").plan(c.get("orgId"));
    return c.json({ regions: availableRegions(), types: PROBE_TYPES, maxPerMonitor: plan?.maxRegions ?? null });
  });
  // sidebar badges: one round trip, four counts
  authed.get("/counts", async (c) => {
    const repo = c.get("repo");
    const counts = await repo.counts(c.get("orgId"), c.get("projectId"));
    if (!c.get("allProjects")) return c.json(counts);
    // the all-projects view: the two badges that have a merged list add up over every project the caller may see
    const overview = await repo.projectOverview(c.get("orgId"), c.get("projectScope"));
    return c.json({ ...counts, monitors: overview.reduce((n, p) => n + p.monitors, 0), incidents: overview.reduce((n, p) => n + p.openIncidents, 0) });
  });
  edition.mount?.({ app, authed });
  app.route("/api", authed);

  app.onError(handleApiError);
  return app;
}

/**
 * PostgreSQL rolled back the whole transaction (40P01 deadlock_detected, 40001 serialization_failure); nothing was
 * committed, so the client may safely retry. Answer 503 + Retry-After instead of an opaque 500.
 */
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);
export const RETRY_AFTER_SECONDS = "1";

export const handleApiError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  const errClass = errorClass(err);
  if (RETRYABLE_SQLSTATES.has(errClass)) {
    console.error(`Retryable API database conflict (${errClass}); private diagnostics suppressed`);
    c.header("retry-after", RETRY_AFTER_SECONDS);
    c.header("cache-control", "no-store");
    return c.json({ error: "Temporarily unavailable, please retry" }, 503);
  }
  console.error(`Unhandled API error (${errClass}); private diagnostics suppressed`);
  return c.json({ error: "Internal error" }, 500);
};

/**
 * A classifier that is safe to log: a PostgreSQL SQLSTATE (e.g. 53300 too_many_connections, 40P01 deadlock) or a Node
 * system code (ECONNRESET), else the error's constructor name. Never the message, which can carry credentials,
 * targets or personal data.
 */
export function errorClass(err: unknown): string {
  try {
    // SQLSTATEs, Node system codes, and postgres.js connection codes such as CONNECTION_CLOSED; Drizzle wraps the
    // driver error, so its code sits on `cause`
    const safe = (code: unknown) => typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30}|[A-Z]+(?:_[A-Z]+){1,4})$/.test(code);
    const code = (err as { code?: unknown } | null)?.code;
    if (safe(code)) return code as string;
    const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (safe(causeCode)) return causeCode as string;
    const name = (err as { constructor?: { name?: unknown } } | null)?.constructor?.name;
    return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "unknown";
  } catch {
    // a throwing getter or a Proxy must not turn the error handler itself into a failure
    return "unknown";
  }
}

export type AppType = ReturnType<typeof createApp>;
