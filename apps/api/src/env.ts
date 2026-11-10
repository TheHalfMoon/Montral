import type { Database, Repo, Scope } from "@montral/repo";
import type { createAuth } from "./auth";
import type { Entitlements } from "./entitlements";
import type { CheckQueue } from "./scheduler";

export type Bindings = {
  /** Cloudflare Hyperdrive binding (production). */
  HYPERDRIVE?: { connectionString: string };
  /** Direct connection string (local dev / non-Cloudflare). */
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Origin of the Astro app, allowed for CORS + cookies. */
  WEB_ORIGIN: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /**
   * Instance-wide single sign-on (OpenID Connect) for self-hosters: the provider's issuer URL, and the client id and
   * secret registered there with the redirect URI <BETTER_AUTH_URL origin>/api/auth/sso/callback. All three, or none.
   */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  /** Comma-separated email domains the instance-wide provider may sign in. Unset: any address the provider verified. */
  OIDC_ALLOWED_DOMAINS?: string;
  /** "true" lets single sign-on reach an identity provider on a private network or over plain http (default: refused). */
  SSO_ALLOW_PRIVATE_IDP?: string;
  /** All billing is fail-closed and restricted to provider TEST MODE in the private preview. */
  MONTRAL_METERING_ENABLED?: string;
  /** Self-hosted development only: let webhook replay reach private addresses (never link-local or metadata). */
  MONTRAL_REPLAY_PRIVATE_TARGETS?: string;
  /** Staged owner-only evidence review: OFF by default, and metered edition only. No dispatch enabled. */
  MONTRAL_RECONCILIATION_ENABLED?: string;
  /** Emergency transition guard: prevent new monthly digest claims, without silencing monitors or alert deliveries. OFF by default. */
  MONTRAL_MONTHLY_REPORTS_PAUSED?: string;
  MONTRAL_BILLING_ENABLED?: string;
  MONTRAL_BILLING_MODE?: string;
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_VARIANT_PRO?: string;
  LEMONSQUEEZY_VARIANT_BUSINESS?: string;
  /** Cloudflare Queue the cron fans checks out to. Unset locally: checks then run inline. */
  CHECK_QUEUE?: CheckQueue;
  /** Cloudflare Email Service `send_email` binding. Unset (local dev): emails are logged instead of sent. */
  EMAIL?: { send(msg: { from: string | { email: string; name: string }; to: string; subject: string; html?: string; text?: string; headers?: Record<string, string> }): Promise<{ messageId?: string }> };
  /** Sender address on a domain onboarded to Email Sending, e.g. "alerts@example.com". */
  EMAIL_FROM?: string;
  /** Node/Docker only: SMTP connection URL, e.g. smtps://user:pass@smtp.example.com. With EMAIL_FROM it enables outgoing mail. */
  SMTP_URL?: string;
  /** Alternative to SMTP_URL: host, port (default 587, or 465 with SMTP_SECURE=true), SMTP_USER/SMTP_PASS. */
  /** Shortcut for Resend: sends through smtp.resend.com:465 with this API key (also set EMAIL_FROM on a verified domain). */
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** "true" closes registration: new accounts can only be created by someone with a pending invitation. */
  DISABLE_SIGNUP?: string;
  /** Cloudflare Turnstile: with both keys set, email sign-up shows the widget and the API verifies the token. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** "true" makes sign-up show "you agree to the Terms and Privacy Policy" (the bundled pages describe the hosted service, so off by default). */
  LEGAL_LINKS?: string;
  /** "true" when exactly one reverse proxy sits in front (Docker/Node): its x-forwarded-for is then trusted for rate limits. */
  TRUST_PROXY?: string;
  /** Node only: exact IP(s) of the trusted proxy TCP socket peer; never a CIDR. */
  TRUST_PROXY_PEER_IPS?: string;
  /** Days a team invitation stays valid. Default 7. */
  INVITE_TTL_DAYS?: string;
  /** Days workspace audit events are kept (30 to 3650). Default 365. */
  AUDIT_RETENTION_DAYS?: string;
  /** "true" lets monitors and alert webhooks target private, loopback and link-local addresses (default: refused). */
  ALLOW_PRIVATE_TARGETS?: string;
  /** "enabled" turns on browser (multi-step) checks; needs playwright-core and Chromium on the server (Node only). */
  BROWSER_CHECKS?: string;
  /** Browser checks running at once on this server (1-16, default 2); more are deferred (inconclusive), never queued without bound. */
  MAX_BROWSER_CHECKS?: string;
  /** Memory limit of one browser check's whole process tree, MiB (256-8192, default 1024); measured on Linux. */
  BROWSER_CHECK_MAX_RSS_MB?: string;
  /** Chromium executable for browser checks; default: the one Playwright installed. */
  BROWSER_EXECUTABLE_PATH?: string;
  /** "off" disables Chromium's own sandbox for browser checks: accepted only with NODE_ENV=development, refused otherwise. */
  BROWSER_CHECK_SANDBOX?: string;
  /** "true" lets browser checks reach private and internal addresses (separate from ALLOW_PRIVATE_TARGETS); never loopback, metadata or this server. */
  BROWSER_CHECK_ALLOW_PRIVATE_TARGETS?: string;
  /** URL of the browser-runner service (docker-compose.browser.yml); unset = browser checks run in this process. */
  BROWSER_RUNNER_URL?: string;
  /** Shared HMAC token for the browser-runner channel, at least 32 characters (openssl rand -hex 32). */
  BROWSER_RUNNER_TOKEN?: string;
  /** User-Agent of HTTP checks. Default: Montral/0.1 (+https://github.com/TheHalfMoon/Montral). */
  CHECK_USER_AGENT?: string;
  /** Comma-separated URLs a failed network-level check fetches to tell "the target is down" from "this machine is offline". Unset: three well-known public URLs; empty: no self-check. */
  SELFCHECK_URLS?: string;
  /** Shared secret that lets an external cron hit POST /internal/run-checks. */
  CRON_SECRET?: string;
  /**
   * Remote check regions: JSON object of region id to the probe's URL (or `{"url", "name"}`), e.g.
   * {"us-east":"https://probe.example.app/api/probe/us-east"}. Unset: monitors can only run from `auto`.
   */
  PROBE_REGIONS?: string;
  /** Secret the probes in PROBE_REGIONS verify requests with (required for those regions to be usable). */
  PROBE_SECRET?: string;
  /**
   * iOS push notifications (APNs). All four must be set: the APNs Auth Key (.p8 file contents; literal `\n` is accepted),
   * its key id, the Apple team id and the app's bundle id.
   */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
};

export type Auth = ReturnType<typeof createAuth>;

/** Verified credential metadata only: never contains a token, API-key value, cookie or session secret. */
export type RequestIdentity = { kind: "session" } | { kind: "api-key"; credentialId: string } | { kind: "oauth"; clientId: string };
export type RequestPrincipal = Readonly<RequestIdentity & {
  userId: string;
  orgId: string;
  /** Selected project, or the middleware's fallback in the all-projects view. */
  projectId: string;
  allProjects: boolean;
  /** Effective allowed project IDs for this workspace, null for unrestricted membership. */
  projectScope: readonly string[] | null;
}>;

export type Variables = {
  /** Present only after requireOrg has successfully verified identity, membership and selected project access. */
  requestPrincipal?: RequestPrincipal;
  statusResponsePrivate?: boolean;
  repo: Repo;
  database: Database;
  auth: Auth;
  /** Usage allowance of workspaces: unmetered unless the hosted edition passes its own. */
  entitlements: Entitlements;
  userId: string;
  orgId: string;
  /** Active project inside the workspace (cookie `montral_project` / header `x-project-id`, else the oldest). */
  projectId: string;
  /**
   * The request asked for the "All projects" view (cookie `montral_project=all` / header `x-project-id: all`). `projectId` is
   * then only the fallback project; the monitor and incident lists read every project the caller may see, and writes
   * to project-scoped routes are refused (see rejectInAllProjects).
   */
  allProjects: boolean;
  /** Set for API keys limited to some projects: the only project ids this request may touch (null = no limit). */
  projectScope: Scope;
  /**
   * Workspaces a key or an OAuth grant may switch between with `x-workspace-id`, each with its project limit
   * (null = no limit); "all" = any workspace the user belongs to. null for a signed-in session.
   */
  workspaceGrant: null | "all" | Map<string, string[] | null>;
  /**
   * What proves how this request's credential came to be, for "require SSO" (middleware.ts ssoAllowsPrincipal): the
   * session id, the API key id, or the session that authorized an agent token (null when the token has none).
   */
  ssoProof?: { kind: "session" | "api-key" | "oauth"; id: string | null };
  /** A streamed response still reading from the request's database: it is closed once this settles, not before. */
  databaseHeldUntil?: Promise<void>;
  /** The request gave its database back early (releaseDatabase): nothing may query it afterwards. */
  databaseReleased?: boolean;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export function connectionString(env: Bindings): string {
  const cs = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!cs) throw new Error("No database configured: bind HYPERDRIVE or set DATABASE_URL");
  return cs;
}
