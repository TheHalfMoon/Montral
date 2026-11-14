import { resolveRoute } from "./routes";
import { go } from "./locale-path";

export type Monitor = {
  id: string; name: string; type: "http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis" | "websocket" | "domain" | "certificate" | "ping" | "browser"; target: string; method: string; requestBody?: string | null;
  domainExpiryWarnDays?: number;
  domainExpiry?: { state: "valid" | "expiring" | "expired" | "unknown"; expiresAt: string | null; checkedAt: string; cacheUntil: string; source: string | null; error: string | null } | null;
  expectedStatus: number; intervalSec: number; timeoutMs: number; failureThreshold: number; recoveryThreshold?: number; consecutiveSuccesses?: number;
  status: "pending" | "up" | "degraded" | "down" | "paused"; paused: boolean;
  lastCheckedAt: string | null; heartbeatToken: string | null;
  uptime24h?: number | null; avgLatency24h?: number | null; spark?: (number | null)[];
  dnsRecordType?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS"; dnsExpectedValue?: string | null; dnsMatchMode?: "exact" | "contains";
  keyword?: string | null; keywordMode?: "contains" | "absent"; expectedLocation?: string | null; wsMessage?: string | null; graceSec?: number; channelIds?: string[]; headers?: Record<string, string>;
  /** http: one value of a JSON response body, picked by a path (dot keys, [index], ["quoted key"]) and tested */
  jsonPath?: string | null; jsonExpected?: string | null; jsonMatch?: "equals" | "contains" | "exists";
  /** the project the monitor belongs to (the lists of the "All projects" view mix several) */
  projectId?: string | null;
  tags?: string[]; slowThresholdMs?: number; slowAlertAfter?: number;
  /** where checks run from: `auto` (this deployment) or ids from `api.regions()` */
  regions?: string[];
  /** another monitor of the project; while it is down this one opens no incidents and sends no alerts */
  dependsOnMonitorId?: string | null;
  /** several regions: how many must fail before it goes down; 0 = a majority of those that answered */
  minRegionsFailing?: number;
  /** a workspace escalation policy used instead of the project's escalation levels; null = the project's */
  escalationPolicyId?: string | null;
  /** browser: the declarative journey; secrets are write-only (every name comes back as ••••••••) */
  browser?: BrowserJourney | null;
  browserSecrets?: Record<string, string>;
  /** browser: since when its checks have not been running (runtime errors or capacity); null while they run */
  uncheckedSince?: string | null;
};
export type BrowserRuntime = { enabled: boolean; mode: "runner" | "in-process"; available: boolean | null; checkedAt: string | null; lastError: string | null; lastErrorAt: string | null };
export type BrowserJourney = { steps: Record<string, unknown>[]; timeoutMs: number; screenshot: "never" | "on_failure" };
export type BrowserRun = { id: string; createdAt: string; ok: boolean; failedStep: number | null; error: string | null; durationMs: number; steps: { action: string; ms: number; ok: boolean }[]; blockedRequests: number; peakRssMb: number | null; cpuMs: number | null; hasScreenshot: boolean; kind: "run" | "deferred" | "error"; usedSecrets: boolean };
export type BillingStatus = {
  plan: string; status: string; billingConfigured: boolean; providerUpdatedAt: string | null; endsAt: string | null;
  /** the plan the subscription grants now (null: the default plan); past due beyond grace or refunded grants nothing */
  entitledPlan?: string | null; paymentState?: "paid" | "failed" | "refunded" | null; graceEndsAt?: string | null;
};
/** A plan the deployment offers. `price` is present only once the owner publishes prices. */
export type BillingPlan = { id: string; name: string; checkoutAvailable: boolean; price?: { amountMinor: number; currency: string; interval: "month" | "year" } };
export type HookInbox = { id: string; name: string; created_at: string };
export type HookEvent = { id: string; method: string; content_type: string | null; headers: Record<string,string>; body: string; created_at: string; response_status?: number | null };
export type HookResponseContentType = "text/plain" | "application/json" | "application/xml" | "text/xml" | "text/csv";
export type HookResponseVariant = { status: number; contentType: HookResponseContentType; body: string; headers: { name: string; value: string }[]; location?: string };
export type HookResponse = HookResponseVariant & { delayMs: number; methods?: Partial<Record<"POST" | "PUT" | "PATCH", HookResponseVariant>> };
export type Project = { id: string; name: string };
/** One project's line in the "All projects" overview. */
export type ProjectOverview = Project & { monitors: number; down: number; openIncidents: number };
export type Subscriber = { id: string; email: string; confirmedAt: string | null; createdAt: string };
export type Maintenance = { seriesId?: string | null; recurrence?: { frequency: "daily" | "weekly"; timeZone: string; until: string } | null; id: string; name: string; startsAt: string; endsAt: string; monitorIds: string[] };
export type CheckResult = { id: string; ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null; checkedAt: string; region?: string };
export type RegionStat = {
  region: string; checks24h: number; uptime24h: number | null; avgLatency24h: number | null;
  last: { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null; checkedAt: string } | null;
};
export type RegionList = { regions: { id: string; name: string; drained?: boolean }[]; types: string[]; maxPerMonitor: number | null };
export type SpotCheck = { ok: true; region?: string; result?: { ok: boolean; statusCode?: number; latencyMs?: number; error?: string } };
export type Incident = {
  id: string; title: string; status: "investigating" | "identified" | "monitoring" | "resolved";
  /** sequential inside the project, shown as INC-<number> */
  number?: number | null;
  projectId?: string | null;
  rootCause?: string | null;
  postmortem?: string | null;
  /** set once a person published the write-up to the status page */
  postmortemPublishedAt?: string | null;
  severity: string; startedAt: string; resolvedAt: string | null; acknowledgedAt: string | null; monitorName?: string | null;
  updates?: { id: string; status: Incident["status"]; body: string; visibility?: "public" | "internal"; createdAt: string }[];
  auto?: boolean;
  /** why an automatic incident opened, e.g. "3 consecutive failed checks; 3 of 3 regions failed" */
  evaluationNote?: string | null;
  monitorId?: string | null;
  monitor?: { id: string; name: string; status: string; target: string; type: string } | null;
  assignee?: { name: string; email: string } | null;
  checks?: CheckResult[];
  deliveries?: AlertDelivery[];
};

export type Channel = { id: string; type: "slack" | "webhook" | "email" | "telegram" | "pagerduty" | "lark" | "push" | "discord" | "teams" | "ntfy" | "googlechat" | "mattermost" | "gotify" | "pushover"; name: string; config: { url?: string; secret?: string; to?: string; chatId?: string; botToken?: string; routingKey?: string; topic?: string; token?: string; priority?: string; userKey?: string; device?: string }; enabled: boolean; autoEnable?: boolean; projectId?: string | null };
/** The workspace's single sign-on connection; the client secret is write-only and never part of it. */
/** SCIM provisioning of the workspace (owner only); the token itself is shown only when created. */
export type ScimStatus = { enabled: boolean; baseUrl: string; createdAt: string | null; lastUsedAt: string | null; users: { active: number; inactive: number } };

export type SsoSettings = {
  callbackUrl: string;
  instanceProvider: boolean;
  connection: null | {
    id: string; issuer: string; clientId: string; hasClientSecret: boolean; defaultRole: "member" | "admin"; requireSso: boolean; enabled: boolean;
    domains: { domain: string; verified: boolean; verifiedAt: string | null; txtName: string; txtValue: string; checkError?: string | null; failingSince?: string | null }[];
  };
};
export type SsoInput = { issuer: string; clientId: string; clientSecret?: string; domains: string[]; defaultRole: "member" | "admin"; requireSso: boolean; enabled: boolean };
export type WorkspaceSettings = { alertLogRetentionDays: number; checkRetentionDays: number; monthlyReport: boolean };
/** Staged owner-only internal operations: no recipient email or provider evidence is returned. */
export type MonthlyReconciliationSummary = { pending: number; unresolved: number; confirmed: number };
export type MonthlyReviewCandidate = {
  recipientUserId: string; state: "attempted" | "uncertain"; attemptedAt: string;
};
export type MonthlyReviewInput = {
  month: string; recipientUserId: string;
  decision: "provider_accepted" | "unresolved"; evidenceRef: string;
  acknowledgment: "I_verified_external_provider_evidence";
};

export type ShareLink = { id: string; label: string | null; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null };
/** The DNS record that proves control of a status page's custom domain. */
export type DomainRecord = { type: "TXT"; name: string; value: string };
/** why the last scheduled TXT re-check failed */
export type DomainCheckError = "missing" | "mismatch" | "lookup_failed";
export type StatusPage = { id: string; projectId?: string | null; slug: string; customDomain?: string | null; customDomainVerifiedAt?: string | null; customDomainRecord?: DomainRecord | null; customDomainCheckedAt?: string | null; customDomainFailingSince?: string | null; customDomainCheckError?: DomainCheckError | null; title: string; theme: "light" | "dark" | "auto"; showLatency: boolean; externalUrl?: string | null; hideBranding?: boolean; uptimeOkPct?: number; uptimeWarnPct?: number; mcpEnabled?: boolean; maintenanceReminderHours?: number; visibility?: "public" | "members" | "password"; hasPassword?: boolean; password?: string; branding?: { allowed: boolean; upgradeUrl?: string }; monitorIds?: string[]; components?: { monitorId: string; groupName: string | null }[] };

// Requests started as soon as the page's HTML is parsed (lib/boot.ts), in parallel with the JS bundles loading:
// the first GET for a path is answered by that in-flight request, so a page load is HTML (static) + one parallel API round.
// Entries expire after a few seconds and any mutation drops them, so a prefetched page never shows stale data.
const EARLY_TTL = 10_000;
const early = new Map<string, { at: number; p: Promise<unknown> }>();
function takeEarly(path: string): Promise<unknown> | undefined {
  const e = early.get(path);
  return e && Date.now() - e.at < EARLY_TTL ? e.p : undefined;
}
export type Quota = { limit: number; used: number; periodStart: string; periodEnd: string };
export type Usage =
  | { metered: false }
  | {
      metered: true;
      /** Whether the current workspace role may access owner/admin billing actions. */
      canManageBilling?: boolean;
      /** when every allowance resets (the start of the next UTC month in this preview) */
      periodEnd?: string;
      credits: Quota | null;
      emails: Quota | null;
      /** captured webhook requests this month; absent or null when not metered */
      webhookEvents?: Quota | null;
      /** browser-check runtime seconds this month; absent or null when not metered */
      browserSeconds?: Quota | null;
      activeMonitors: number;
      plan: { id: string; name: string; maxActiveMonitors: number | null; minIntervalSec: number; maxRegions?: number | null; upgradeUrl?: string; manageUrl?: string } | null;
    };

/** Starts the shell's reads and the data of the route at `pathname` right away. */
export function prefetch(pathname: string) {
  const hit = resolveRoute(pathname);
  // "/usage" too: boot.ts (the Plan & usage entry) and the usage banner both read it on every load; this one request answers both
  for (const path of ["/me", "/counts", "/projects", "/usage", ...(hit ? hit.route.data(hit.params) : [])]) {
    if (early.has(path)) continue;
    const p = fetchJson<unknown>(path);
    p.catch(() => {});
    early.set(path, { at: Date.now(), p });
  }
}

// Revisits: every GET is remembered, and the first read of a path right after a route change is answered from memory
// (instant paint) while a background request checks it. A mutation drops everything so edits are never shown stale.
const STORE_TTL = 60_000;
const store = new Map<string, { at: number; data: unknown }>();
let armedUntil = 0;
/** Called by the router on every navigation: the page's mount-time reads may use remembered data. */
export const armCache = () => { armedUntil = Date.now() + 1500; };

// Switching workspace or project changes what every path returns: forget everything, and let no read that was already
// in flight for the old scope be remembered.
let scope = 0;
export function resetCache() {
  scope++;
  armedUntil = 0;
  store.clear();
  early.clear();
  // another workspace: whether it is suspended is learned from its own answers
  suspended = false;
}

/**
 * The active workspace was suspended by a platform operator (docs/OPERATOR.md): every workspace API call answers 403
 * with this code. The first such answer flips the flag and tells the shell, which replaces the page with a notice.
 */
export const WORKSPACE_SUSPENDED = "workspace_suspended";
let suspended = false;
export const isSuspended = () => suspended;
/** Paths whose answer says nothing about the active workspace (public config; creating another workspace). */
const OUTSIDE_WORKSPACE = new Set(["/config", "/workspaces"]);
/** A refusal or success counts only for the workspace the request was made in (`asked`), never for one switched to since. */
function noteSuspension(path: string, asked: number, refused: boolean) {
  if (asked !== scope || typeof window === "undefined") return;
  if (refused && !suspended) {
    suspended = true;
    window.dispatchEvent(new Event("montral:suspended"));
  } else if (!refused && suspended && !OUTSIDE_WORKSPACE.has(path.split("?")[0])) {
    // the operator lifted the suspension: a workspace call went through again
    suspended = false;
    window.dispatchEvent(new Event("montral:unsuspended"));
  }
}

/** Interval of the suspended-workspace re-check (only while the tab is visible). */
export const SUSPENSION_RECHECK_MS = 60_000;
/**
 * One cheap workspace call while the notice shows, past every cache: its success (the operator lifted the suspension)
 * clears the notice through the same path as any other successful call; a refusal changes nothing.
 */
export const recheckSuspension = (): Promise<void> => fetchJson<unknown>("/me", { cache: "no-store" }).then(() => {}, () => {});

/** An API refusal: `code` and the rest of the body let the UI explain plan limits (HTTP 402) instead of just printing the message. */
export class ApiError extends Error {
  status: number;
  code?: string;
  upgradeUrl?: string;
  /** quota refusals: when the allowance resets (ISO) */
  resetsAt?: string;
  constructor(message: string, status: number, body: { code?: string; upgradeUrl?: string; resetsAt?: string } | null) {
    super(message);
    this.status = status;
    this.code = body?.code;
    this.upgradeUrl = body?.upgradeUrl;
    this.resetsAt = typeof body?.resetsAt === "string" ? body.resetsAt : undefined;
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const asked = scope;
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    go("/login");
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string; upgradeUrl?: string; resetsAt?: string } | null;
    if (res.status === 403 && body?.code === WORKSPACE_SUSPENDED) noteSuspension(path, asked, true);
    // a used-up allowance: the shell's usage banner reads the new state
    if ((res.status === 402 || res.status === 429) && typeof body?.code === "string" && /_exhausted$/.test(body.code)) window.dispatchEvent(new Event("montral:usage"));
    throw new ApiError(body?.error ?? res.statusText, res.status, body);
  }
  noteSuspension(path, asked, false);
  return res.status === 204 ? (undefined as T) : res.json();
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== "GET") {
    store.clear();
    early.clear();
    return fetchJson<T>(path, init);
  }
  const asked = scope;
  const keep = (data: unknown) => { if (asked === scope) store.set(path, { at: Date.now(), data }); };
  const pending = takeEarly(path);
  if (pending) {
    try {
      const data = await pending;
      keep(data);
      return data as T;
    } catch { /* fall through to a fresh request */ }
  }
  const hit = store.get(path);
  if (hit && Date.now() < armedUntil && Date.now() - hit.at < STORE_TTL) {
    store.delete(path);
    fetchJson<T>(path, init).then((fresh) => {
      if (asked !== scope) return;
      keep(fresh);
      if (JSON.stringify(fresh) !== JSON.stringify(hit.data)) window.dispatchEvent(new Event("montral:stale"));
    }).catch(() => {});
    return hit.data as T;
  }
  const data = await fetchJson<T>(path, init);
  keep(data);
  return data;
}

export type AlertDelivery = {
  id: string; channelId: string | null; channelName: string; channelType: string;
  kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated" | "test" | string;
  monitorName: string | null; ok: boolean; error: string | null; createdAt: string;
  /** null on rows written before delivery states existed */
  status?: "pending" | "sending" | "sent" | "failed" | "skipped" | null;
  /** why a delivery was skipped or failed, in words */
  statusMessage?: string | null;
  /** when the incident was acknowledged after this alert went out */
  acknowledgedAt?: string | null;
};

export type ProjectAlerting = {
  reminderIntervalMin: number | null;
  reminderEmail: boolean;
  escalation: { channelIds: string[]; escalateAfterMin: number; userIds?: string[]; scheduleIds?: string[] }[];
};

export type OncallRestriction = { days: number[]; start: string; end: string };
export type OncallLayer = {
  id?: string; name: string; userIds: string[]; rotationType: "daily" | "weekly" | "custom"; shiftLengthHours: number | null;
  handoffTime: string; handoffWeekday: number | null; startDate: string; restrictions: OncallRestriction[];
};
export type OncallShift = { userId: string; name: string | null; start: string; end: string; source: "layer" | "override"; layerId: string | null; overrideId: string | null };
export type OncallSchedule = { id: string; projectId: string | null; name: string; timeZone: string; version: number; layers: OncallLayer[]; onCallNow?: OncallShift | null };
export type OncallOverride = { id: string; scheduleId: string; userId: string; startsAt: string; endsAt: string; createdBy: string | null; createdAt: string };
export type OncallMember = { userId: string; name: string; email?: string; role?: string };
export type PolicyStep = { timeoutMin: number; channelIds: string[]; userIds: string[]; scheduleIds: string[] };
export type EscalationPolicy = { id: string; projectId: string | null; name: string; steps: PolicyStep[]; repeatCount: number; version: number; monitors?: { id: string; name: string }[] };

export type TimeCoverage = {
  from: string; to: string; totalMs: number;
  states: Record<"up" | "down" | "degraded" | "paused" | "unknown", number>;
  observedMaintenanceMs: number; policy: "bounded-observation-v1";
};

/** One workspace audit log entry (GET /api/audit-events). `changes` names the fields a request set, never secret values. */
export type AuditEvent = {
  id: string; projectId: string | null; actorType: "user" | "api_key" | "system"; actorId: string | null; actorLabel: string | null;
  action: string; targetType: string; targetId: string | null;
  changes: { fields: string[]; values?: Record<string, string | number | boolean | null> } | null;
  ip: string | null; createdAt: string;
};

export const api = {
  /** `query` is a URLSearchParams string of filters and the cursor, without the leading "?". */
  auditEvents: (query: string) => fetchJson<{ events: AuditEvent[]; next: string | null }>(`/audit-events${query ? "?" + query : ""}`, { cache: "no-store" }),
  billingStatus: () => req<BillingStatus>("/billing"),
  billingPlans: () => req<{ defaultPlan: string; plans: BillingPlan[] }>("/billing/plans"),
  billingCheckout: (plan: string) => req<{ url: string; testMode: true }>("/billing/checkout", { method: "POST", body: JSON.stringify({ plan }) }),
  revokeStatusAccess: (id: string) => req<{ ok: true }>(`/status-pages/${id}/access/revoke`, { method: "POST" }),
  setStatusDomain: (id: string, domain: string) =>
    req<{ customDomain: string; customDomainVerifiedAt: null; customDomainRecord: DomainRecord }>(`/status-pages/${id}/domain`, { method: "PUT", body: JSON.stringify({ domain }) }),
  clearStatusDomain: (id: string) => req<void>(`/status-pages/${id}/domain`, { method: "DELETE" }),
  verifyStatusDomain: (id: string) =>
    req<{ verified: true; customDomain: string; customDomainVerifiedAt: string; customDomainCheckedAt: string; record: DomainRecord }>(`/status-pages/${id}/domain/verify`, { method: "POST" }),
  shareLinks: (id: string) => req<ShareLink[]>(`/status-pages/${id}/share-links`),
  createShareLink: (id: string, b: { label?: string; expiresInHours?: number }) =>
    req<{ id: string; label: string | null; expiresAt: string; url: string; warning: string }>(`/status-pages/${id}/share-links`, { method: "POST", body: JSON.stringify(b) }),
  revokeShareLink: (id: string, linkId: string) => req<void>(`/status-pages/${id}/share-links/${linkId}`, { method: "DELETE" }),
  hookInboxes: () => req<{ inboxes: HookInbox[] }>("/hooks/inboxes"),
  createHookInbox: (name: string) => req<{ id: string; name: string; path: string }>("/hooks/inboxes", { method: "POST", body: JSON.stringify({ name }) }),
  hookEvents: (id: string, f: { before?: string; method?: string; q?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
    return req<{ events: HookEvent[]; next: string | null }>(`/hooks/inboxes/${id}/events${qs ? "?" + qs : ""}`);
  },
  deleteHookInbox: (id: string) => req<void>(`/hooks/inboxes/${id}`, { method: "DELETE" }),
  deleteHookEvent: (inbox: string, event: string) => req<void>(`/hooks/inboxes/${inbox}/events/${event}`, { method: "DELETE" }),
  /** this month's accepted replay attempts (owners and admins; 403 otherwise). A count, never billed. */
  hookReplayUsage: () => req<{ attempts: string; periodStart: string; periodEnd: string; billable: false }>("/hooks/replay-usage"),
  replayHookEvent: (inbox: string, event: string, url: string) =>
    req<{ status: number; contentType: string | null; body: string; truncated: boolean; durationMs: number }>(`/hooks/inboxes/${inbox}/events/${event}/replay`, { method: "POST", body: JSON.stringify({ url }) }),
  hookResponse: (id: string) => req<{ response: HookResponse | null }>(`/hooks/inboxes/${id}/response`),
  setHookResponse: (id: string, response: HookResponse) => req<{ response: HookResponse }>(`/hooks/inboxes/${id}/response`, { method: "PUT", body: JSON.stringify(response) }),
  resetHookResponse: (id: string) => req<void>(`/hooks/inboxes/${id}/response`, { method: "DELETE" }),
  browserRuntime: () => req<BrowserRuntime>("/monitors/browser-runtime"),
  browserRuns: (id: string) => req<{ runs: BrowserRun[] }>(`/monitors/${id}/browser-runs`),
  timeCoverage: (id: string, days: 7 | 30) => req<TimeCoverage>(`/monitors/${id}/time-coverage?days=${days}`),
  monitors: () => req<Monitor[]>("/monitors"),
  monitor: (id: string) => req<Monitor & { results: CheckResult[]; regionStats: RegionStat[] }>(`/monitors/${id}`),
  regions: () => req<RegionList>("/regions"),
  createMonitor: (b: Partial<Monitor> & { name: string }) => req<Monitor>("/monitors", { method: "POST", body: JSON.stringify(b) }),
  updateMonitor: (id: string, b: Partial<Monitor>) => req<Monitor>(`/monitors/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteMonitor: (id: string) => req<void>(`/monitors/${id}`, { method: "DELETE" }),
  /** Without `region` the monitor's own check runs and is recorded; with it one request is sent from there and only returned. */
  checkNow: (id: string, region?: string) => req<SpotCheck>(`/monitors/${id}/check`, { method: "POST", ...(region ? { body: JSON.stringify({ region }) } : {}) }),
  me: () => req<{ userId: string; organization: { id: string; name: string }; projectId: string; user: { name: string; email: string; locale: string | null; emailVerified?: boolean; twoFactorEnabled?: boolean | null } | null }>("/me"),
  onboardingDismissed: () => req<{ dismissed: boolean }>("/onboarding/dismissal"),
  dismissOnboarding: () => req<{ dismissed: boolean }>("/onboarding/dismissal", { method: "POST" }),
  setLocale: (locale: "en" | "zh-CN") => req<{ locale: string }>("/me/locale", { method: "PATCH", body: JSON.stringify({ locale }) }),
  counts: () => req<Record<string, number>>("/counts"),
  usage: () => req<Usage>("/usage"),
  projects: () => req<Project[]>("/projects"),
  projectOverview: () => req<ProjectOverview[]>("/projects/overview"),
  createWorkspace: (name: string) => req<{ id: string; name: string }>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  createProject: (name: string) => req<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) => req<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  maintenance: () => req<Maintenance[]>("/maintenance"),
  createMaintenance: (b: Omit<Maintenance, "id">) => req<Maintenance>("/maintenance", { method: "POST", body: JSON.stringify(b) }),
  endMaintenance: (id: string) => req<{ ok: boolean }>(`/maintenance/${id}/end`, { method: "POST" }),
  cancelMaintenanceSeries: (id: string) => req<void>(`/maintenance/series/${id}`, { method: "DELETE" }),
  deleteMaintenance: (id: string) => req<void>(`/maintenance/${id}`, { method: "DELETE" }),
  /** What this deployment can do (public). */
  config: () => req<{ push?: { apns: boolean } }>("/config"),
  channels: () => req<Channel[]>("/channels"),
  projectAlerting: (projectId: string) => req<ProjectAlerting>(`/projects/${projectId}/alerting`),
  saveProjectAlerting: (projectId: string, b: ProjectAlerting) => req<ProjectAlerting>(`/projects/${projectId}/alerting`, { method: "PUT", body: JSON.stringify(b) }),
  /** newest first; `before` (ISO time) pages back through older deliveries */
  alertLog: (limit = 30, before?: string) => req<AlertDelivery[]>(`/alert-log?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  reconciliationSummary: (month: string) => req<MonthlyReconciliationSummary>(`/monthly-reconciliation/summary?month=${encodeURIComponent(month)}`),
  reconciliationPending: (month: string) => req<{ items: MonthlyReviewCandidate[] }>(`/monthly-reconciliation/pending?month=${encodeURIComponent(month)}`),
  reconcileMonthlyReport: (input: MonthlyReviewInput) => req<{ applied: boolean }>("/monthly-reconciliation/review", { method: "POST", body: JSON.stringify(input) }),
  sso: () => fetchJson<SsoSettings>("/sso"),
  saveSso: (b: SsoInput) => fetchJson<SsoSettings & { warning?: string }>("/sso", { method: "PUT", body: JSON.stringify(b) }),
  deleteSso: () => fetchJson<void>("/sso", { method: "DELETE" }),
  scim: () => fetchJson<ScimStatus>("/sso/scim"),
  createScimToken: () => fetchJson<{ token: string; baseUrl: string; replaced: boolean }>("/sso/scim/token", { method: "POST" }),
  revokeScimToken: () => fetchJson<void>("/sso/scim/token", { method: "DELETE" }),
  testSso: (issuer: string) => fetchJson<{ ok: true; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; algorithms: string[] }>("/sso/test", { method: "POST", body: JSON.stringify({ issuer }) }),
  verifySsoDomain: (domain: string) => fetchJson<{ verified: boolean }>(`/sso/domains/${encodeURIComponent(domain)}/verify`, { method: "POST" }),
  settings: () => req<WorkspaceSettings>("/settings"),
  updateSettings: (b: Partial<WorkspaceSettings>) =>
    req<WorkspaceSettings>("/settings", { method: "PATCH", body: JSON.stringify(b) }),
  createChannel: (b: { type: Channel["type"]; name: string; config: Record<string, string>; autoEnable?: boolean }) =>
    req<Channel>("/channels", { method: "POST", body: JSON.stringify(b) }),
  updateChannel: (id: string, b: { name?: string; enabled?: boolean; autoEnable?: boolean; config?: Record<string, string> }) => req<Channel>(`/channels/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  testChannel: (id: string) => req<{ ok: boolean }>(`/channels/${id}/test`, { method: "POST" }),
  deleteChannel: (id: string) => req<void>(`/channels/${id}`, { method: "DELETE" }),
  statusPages: () => req<StatusPage[]>("/status-pages"),
  subscribers: (pageId: string) => req<Subscriber[]>(`/status-pages/${pageId}/subscribers`),
  deleteSubscriber: (pageId: string, id: string) => req<void>(`/status-pages/${pageId}/subscribers/${id}`, { method: "DELETE" }),
  statusPage: (id: string) => req<StatusPage>(`/status-pages/${id}`),
  createStatusPage: (b: { slug: string; title: string; monitorIds: string[] }) =>
    req<StatusPage>("/status-pages", { method: "POST", body: JSON.stringify(b) }),
  updateStatusPage: (id: string, b: Partial<StatusPage>) => req(`/status-pages/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteStatusPage: (id: string) => req<void>(`/status-pages/${id}`, { method: "DELETE" }),
  incidents: () => req<Incident[]>("/incidents"),
  declareIncident: (b: { title: string; body?: string; severity?: "minor" | "major"; monitorId?: string | null; visibility?: "public" | "internal" }) =>
    req<Incident>("/incidents", { method: "POST", body: JSON.stringify(b) }),
  incident: (id: string) => req<Incident>(`/incidents/${id}`),
  postUpdate: (id: string, b: { status: Incident["status"]; body: string; visibility?: "public" | "internal" }) =>
    req(`/incidents/${id}/updates`, { method: "POST", body: JSON.stringify(b) }),
  saveWriteUp: (id: string, b: { rootCause?: string | null; postmortem?: string | null; publishPostmortem?: boolean }) =>
    req<Incident>(`/incidents/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  ack: (id: string) => req(`/incidents/${id}/ack`, { method: "POST" }),
  oncallMembers: () => req<OncallMember[]>("/oncall/members"),
  oncallSchedules: () => fetchJson<OncallSchedule[]>("/oncall/schedules", { cache: "no-store" }),
  createOncallSchedule: (b: { name: string; timeZone: string; layers: OncallLayer[] }) => req<OncallSchedule>("/oncall/schedules", { method: "POST", body: JSON.stringify(b) }),
  updateOncallSchedule: (id: string, b: { version: number; name?: string; timeZone?: string; layers?: OncallLayer[] }) => req<OncallSchedule>(`/oncall/schedules/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteOncallSchedule: (id: string, version: number) => req<void>(`/oncall/schedules/${id}?version=${version}`, { method: "DELETE" }),
  oncallShifts: (id: string, from: string, to: string) => fetchJson<{ timeZone: string; shifts: OncallShift[] }>(`/oncall/schedules/${id}/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cache: "no-store" }),
  oncallOverrides: (id: string, from: string, to: string) => fetchJson<OncallOverride[]>(`/oncall/schedules/${id}/overrides?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cache: "no-store" }),
  createOncallOverride: (id: string, b: { userId: string; startsAt: string; endsAt: string }) => req<OncallOverride>(`/oncall/schedules/${id}/overrides`, { method: "POST", body: JSON.stringify(b) }),
  deleteOncallOverride: (id: string, overrideId: string) => req<void>(`/oncall/schedules/${id}/overrides/${overrideId}`, { method: "DELETE" }),
  escalationPolicies: () => req<EscalationPolicy[]>("/escalation-policies"),
  createEscalationPolicy: (b: { name: string; steps: PolicyStep[]; repeatCount: number }) => req<EscalationPolicy>("/escalation-policies", { method: "POST", body: JSON.stringify(b) }),
  updateEscalationPolicy: (id: string, b: { version: number; name?: string; steps?: PolicyStep[]; repeatCount?: number }) => req<EscalationPolicy>(`/escalation-policies/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteEscalationPolicy: (id: string, version: number) => req<void>(`/escalation-policies/${id}?version=${version}`, { method: "DELETE" }),
  oncallCalendar: () => fetchJson<{ active: boolean; createdAt: string | null; lastUsedAt: string | null }>("/oncall/calendar", { cache: "no-store" }),
  createOncallCalendar: (replace = false) => req<{ url: string; createdAt: string; replaced: boolean; warning: string }>(`/oncall/calendar${replace ? "?replace=true" : ""}`, { method: "POST" }),
  revokeOncallCalendar: () => req<void>("/oncall/calendar", { method: "DELETE" }),
};

/** A check interval in its shortest form: 30s, 5m, 2h, 1d (45m stays 45m; 90 s stays 90s). */
export const everyShort = (sec: number) => {
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]] as const) if (sec >= size && sec % size === 0) return `${sec / size}${unit}`;
  return `${sec}s`;
};

export const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
