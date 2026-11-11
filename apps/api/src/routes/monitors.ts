import { zValidator } from "@hono/zod-validator";
import { MANUAL_CHECK_WINDOW_SEC, MANUAL_CHECKS_PER_WINDOW, manualChecks } from "../manual-check-gate";
import type { Repo } from "@montral/repo";
import { Hono, type Context } from "hono";
import { limitedJsonBody } from "../json-body-budget";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, auditChanges } from "../audit";
import { ALL_PROJECTS, cookieValue, isManager, listedProjects, requireManager, uuidParams } from "../middleware";
import { creditCost } from "../entitlements";
import { isWorkers, targetProblem } from "../netguard";
import { WORKERS_UNSUPPORTED } from "../certificate";
import { PING_WORKERS_UNSUPPORTED } from "../ping";
import { BROWSER_MIN_INTERVAL_SEC, browserCreationProblem, browserRuntimeHealth, browserUrlProblem } from "../browser-check";
import { browserConfigSchema, browserSecretsSchema, missingSecretProblem, secretRefs, type BrowserConfig } from "../browser-steps";
import { applySecretUpdate, maskedSecrets } from "../browser-secrets";
import { MASK, maskHeaders, restoreHeaders, sameJson } from "../secrets";
import { checkOne, nextAfter, refundCredits, spendAllOrNothing } from "../scheduler";
import { isRegionConfigured, runInRegion } from "../probes";
import { AUTO, PROBE_TYPES, REGION_ID } from "../regions";

import { HTTP_METHODS, MAX_REQUEST_BODY_BYTES, requestBodyProblem } from "../http-request";
import { JSON_MATCH_MODES, MAX_JSON_EXPECTED_LENGTH, MAX_JSON_PATH_LENGTH, jsonPathProblem } from "../json-assertion";

const fields = {
  name: z.string().min(1).max(120).describe("Display name shown in the dashboard, alerts and status-page components."),
  type: z.enum(["http", "tcp", "dns", "heartbeat", "postgres", "mysql", "redis", "websocket", "domain", "certificate", "ping", "browser"]).describe("Check protocol; immutable after creation. HTTP checks a URL, WebSocket checks the handshake (and optionally a reply), certificate checks the TLS certificate a host presents and ping sends one ICMP echo request (both self-hosted Node runtime only), browser runs a declarative multi-step journey in headless Chromium (self-hosted Node server with BROWSER_CHECKS=enabled only), heartbeat waits for incoming pings, and other types check a service."),
  target: z.string().max(2048).describe("HTTP: absolute http(s) URL. WebSocket: ws:// or wss:// URL. TCP: host:port. DNS: hostname. Domain: explicit registered domain, without scheme or path; not a subdomain. Certificate: host or host:port (default port 443). Ping: hostname or IP address, without scheme, port or path. Browser: set from the first goto step (ignored when given). Database/Redis: connection URL for that protocol. Heartbeat: leave empty. Public targets only by default."),
  domainExpiryWarnDays: z.number().int().min(1).max(365).describe("Domain and certificate monitors: fail when the registration or certificate expiration is this many days away or closer; unknown domain dates also fail explicitly."),
  method: z.enum(HTTP_METHODS).describe("HTTP request method; ignored for other monitor types."),
  requestBody: z.string().max(MAX_REQUEST_BODY_BYTES).nullable().describe("HTTP request body, up to 16384 UTF-8 bytes; unavailable with GET or HEAD. Set Content-Type using headers. Null clears it. Masked values preserve stored secrets on update; owners and admins can read bodies."),
  expectedStatus: z.number().int().min(100).max(599).describe("HTTP response status that counts as healthy; an expected 3xx is checked without following the redirect."),
  intervalSec: z.number().int().min(60).max(86400).describe("Seconds between checks, or the expected heartbeat period. Domain and certificate checks are bounded to 3600-86400 seconds; daily domain checks are recommended. Hosted plans may require a longer interval."),
  timeoutMs: z.number().int().min(1000).max(30000).describe("Maximum duration of a check in milliseconds; for domain checks, each IANA/registry request has this timeout and shared cache locks wait at most 3 seconds."),
  failureThreshold: z.number().int().min(1).max(10).describe("Consecutive failed checks required before opening an incident."),
  recoveryThreshold: z.number().int().min(1).max(10).describe("Consecutive successful runs (or heartbeat pings) required to recover from down. Default 1; a multi-region vote counts once. Does not delay latency-only recovery."),
  // no count limit of its own: a region must be configured on the deployment, and only a plan can cap how many one monitor uses
  regions: z.array(z.string().regex(REGION_ID)).min(1).transform((r) => [...new Set(r)]).describe("Region ids from list_regions. auto uses this deployment; explicit regions work for HTTP, TCP and WebSocket only. A supplied list replaces the existing one."),
  keyword: z.string().max(500).nullable().describe("HTTP response-body text, or for WebSocket the first message received, to test; null disables keyword matching."),
  keywordMode: z.enum(["contains", "absent"]).describe("Whether the HTTP response body (or the WebSocket message) must contain keyword or must not contain it."),
  // blank means "no JSON assertion"; the syntax is checked by jsonAssertionProblem, so a bad path gets a plain { error }
  jsonPath: z.string().max(MAX_JSON_PATH_LENGTH).transform((v) => v || null).nullable().describe("HTTP only: path of one value in the JSON response body, such as status, $.data.items[0].state or [\"key with space\"]. Dot keys, [index] and [\"quoted key\"] only, at most 32 segments. Null or empty string disables the JSON assertion; HEAD requests skip it."),
  jsonExpected: z.string().max(MAX_JSON_EXPECTED_LENGTH).nullable().describe("HTTP only: text the value at jsonPath must equal or contain. Strings compare as they are; numbers, booleans, null, objects and arrays compare as compact JSON, so \"true\" matches true and \"42\" matches 42. Required for equals and contains; ignored by exists."),
  jsonMatch: z.enum(JSON_MATCH_MODES).describe("How the value at jsonPath is tested: equals (whole value), contains (substring of its text form) or exists (present, any value including null)."),
  // an absolute http(s) URL or a path; blank means "any destination"
  expectedLocation: z.string().trim().max(2048).refine((v) => v === "" || v.startsWith("/") || /^https?:\/\/\S+$/i.test(v), "Use a full http(s) URL or a path starting with /").transform((v) => v || null).nullable().describe("For an expected HTTP redirect (3xx), require this Location URL or path; null or empty string accepts any destination."),
  headers: z.record(z.string().max(100), z.string().max(2000)).describe("HTTP (or WebSocket handshake) request headers; replaces the header map. An empty object removes all custom headers. Existing masked values preserve stored secrets."),
  // sent as one text message after the handshake; blank means "handshake only"
  wsMessage: z.string().max(2000).transform((v) => v || null).nullable().describe("WebSocket only: text message sent once the connection is open; a message must then come back within the timeout. Not a secret: put credentials in headers. Null or empty string checks the handshake only."),
  browser: browserConfigSchema.nullable().describe("Browser monitors only: { steps, timeoutMs, screenshot }. steps (1-20, the first a goto): goto {url}, click {selector}, fill {selector, value | secretRef}, press {key}, waitFor {selector | text}, assertText {selector?, contains | equals}, assertUrl {pattern; * wildcard, a leading / matches path and query}, assertStatus {code}; each may set timeoutMs (500-30000, default 10000). timeoutMs is the whole journey (5000-60000, default 30000). screenshot: never (default) or on_failure (PNG up to 200 KB, secret fields masked). evaluate {script} runs page JavaScript that must return true (owners and admins only; no secrets in such a journey)."),
  browserSecrets: browserSecretsSchema.describe("Browser monitors only: secrets for fill steps (secretRef), name -> value. Write-only: responses show every name with ••••••••. Send •••••••• to keep a stored value, null to delete it; the map replaces the stored one. Encrypted at rest. Changing the journey while keeping stored secrets requires an owner or admin."),
  dnsRecordType: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]).describe("DNS record type; default A. Queries Cloudflare's public DoH resolver."),
  dnsExpectedValue: z.string().max(2000).transform((v) => v || null).nullable().describe("Optional DNS answer value. At least one answer of the selected type must match. TXT uses quoted DNS presentation; MX includes priority. Empty or null accepts any answer of that type."),
  dnsMatchMode: z.enum(["exact", "contains"]).describe("DNS answer match: exact or case-sensitive substring. Hostnames in CNAME/NS and MX exact matches ignore case and trailing dots."),
  graceSec: z.number().int().min(0).max(86400).describe("Extra seconds allowed after a heartbeat deadline before it counts as missed; used only for heartbeat monitors."),
  channelIds: z.array(z.string().uuid()).max(50).describe("Alert-channel UUIDs from list_channels. Replaces the selected channels; an empty list clears them. Newly created monitors also inherit auto-enabled channels."),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).describe("Dashboard filter labels; a supplied list replaces the existing tags, and an empty list clears them."),
  slowThresholdMs: z.number().int().min(100).max(60000).describe("Latency in milliseconds above which a successful check counts as slow."),
  slowAlertAfter: z.number().int().min(0).max(20).describe("Consecutive slow checks required for a slow-response alert; zero disables these alerts."),
  // another monitor of the same project; while it is down this one opens no incidents and sends no alerts
  dependsOnMonitorId: z.string().uuid().nullable().describe("Parent monitor UUID in the same project; suppresses new incidents and alerts while the parent is down. Null removes the dependency."),
  // several regions: how many must fail before the monitor goes down; 0 = a majority of the regions that answered
  minRegionsFailing: z.number().int().min(0).max(20).describe("Failed regions needed to mark a multi-region monitor down; zero uses a majority of regions that answered."),
  // a workspace escalation policy (GET /escalation-policies) that replaces the project's escalation levels for this monitor
  escalationPolicyId: z.string().uuid().nullable().describe("Escalation policy UUID from the escalation policies API (workspace-wide or this project's). Unacknowledged incidents follow its steps, notifying channels, people and whoever is on call, instead of the project's escalation levels. Null uses the project's levels."),
};

/** Create: omitted fields take defaults. */
const body = z.object({
  ...fields,
  type: fields.type.default("http"),
  target: fields.target.default(""),
  method: fields.method.default("GET"),
  requestBody: fields.requestBody.default(null),
  domainExpiryWarnDays: fields.domainExpiryWarnDays.default(30),
  expectedStatus: fields.expectedStatus.default(200),
  intervalSec: fields.intervalSec.default(60),
  timeoutMs: fields.timeoutMs.default(10000),
  failureThreshold: fields.failureThreshold.default(3),
  recoveryThreshold: fields.recoveryThreshold.default(1),
  regions: fields.regions.default(["auto"]),
  keyword: fields.keyword.default(null),
  keywordMode: fields.keywordMode.default("contains"),
  jsonPath: fields.jsonPath.default(null),
  jsonExpected: fields.jsonExpected.default(null),
  jsonMatch: fields.jsonMatch.default("equals"),
  expectedLocation: fields.expectedLocation.default(null),
  headers: fields.headers.default({}),
  wsMessage: fields.wsMessage.default(null),
  browser: fields.browser.default(null),
  browserSecrets: fields.browserSecrets.default({}),
  dnsRecordType: fields.dnsRecordType.default("A"),
  dnsExpectedValue: fields.dnsExpectedValue.default(null),
  dnsMatchMode: fields.dnsMatchMode.default("exact"),
  graceSec: fields.graceSec.default(0),
  channelIds: fields.channelIds.default([]),
  tags: fields.tags.default([]),
  slowThresholdMs: fields.slowThresholdMs.default(1500),
  slowAlertAfter: fields.slowAlertAfter.default(0),
  dependsOnMonitorId: fields.dependsOnMonitorId.default(null),
  minRegionsFailing: fields.minRegionsFailing.default(0),
  escalationPolicyId: fields.escalationPolicyId.default(null),
});

const IMPORT_MAX = 500;
const sourceSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/);
export const monitorImportSchema = z.object({
  source: sourceSchema.optional().describe("Stable source namespace, such as uptime-kuma:production. Reuse it on retries; defaults to json. Per-row source takes precedence."),
  destination: z.object({ organizationId: z.string(), projectId: z.string().uuid() }).optional().describe("Optional on preview. For import_monitors, pass the destination returned by the preview: the import is then refused if the active workspace or project changed. Without it the monitors go to the active project."),
  monitors: z.array(z.record(z.string(), z.unknown())).min(1).max(IMPORT_MAX).describe("Monitor records. Give each a stable sourceId (or id). Source IDs ignore surrounding whitespace. Missing ids use a hash of type, name and target. Repeated identities are skipped, never overwritten."),
});
const FIELD_KEYS = Object.keys(fields);
/** Never exported: values are write-only, and the export would only carry the mask. */
const NOT_EXPORTED = ["channelIds", "dependsOnMonitorId", "escalationPolicyId", "browserSecrets"];

/** Accepts our own export plus the common spellings of other tools (UptimeRobot, Uptime Kuma, common monitoring tool style). */
function normaliseImport(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  r.name ??= r.friendly_name ?? r.friendlyName ?? r.id;
  r.target ??= r.url ?? r.hostname ?? r.host;
  if (r.target != null && r.port && typeof r.target === "string" && !r.target.includes(":") && r.type === "port") r.target = `${r.target}:${r.port}`;
  r.intervalSec ??= typeof r.interval === "number" ? Math.max(60, r.interval) : undefined;
  if (Array.isArray(r.regions) && r.regions.length === 0) delete r.regions;
  r.keyword ??= r.keyword_value ?? r.expectedKeyword ?? undefined;
  const t = typeof r.type === "string" ? r.type.toLowerCase() : undefined;
  if (t) r.type = ({ https: "http", keyword: "http", port: "tcp", "tcp-port": "tcp", mysql: "mysql", postgres: "postgres", postgresql: "postgres", "websocket-upgrade": "websocket", ws: "websocket" } as Record<string, string>)[t] ?? t;
  const o: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
  if (r.keyword === null) o.keyword = null;
  // a new monitor never carries over ids, so a bad channel or dependency reference cannot slip in
  delete o.channelIds;
  delete o.dependsOnMonitorId;
  delete o.escalationPolicyId;
  // an export taken by a non-manager carries placeholders instead of header values: they are not real values
  if (o.headers && typeof o.headers === "object" && !Array.isArray(o.headers)) {
    o.headers = Object.fromEntries(Object.entries(o.headers as Record<string, unknown>).filter(([, v]) => v !== MASK));
  }
  return o;
}

/** Update: only named fields change (defaults here would silently reset the rest); type is immutable. */
const patchBody = z.object(fields).partial().omit({ type: true }).extend({ paused: z.boolean().optional().describe("True pauses checks and alerts; false resumes checking with pending status. Prefer pause_monitor or resume_monitor for this change alone.") });

/** Exposed for the MCP tool definitions so they cannot drift from the REST validation. */
export const monitorCreateSchema = body;
export const monitorPatchSchema = patchBody;

const DNS_DEFAULTS = { dnsRecordType: "A", dnsExpectedValue: null, dnsMatchMode: "exact" } as const;

/**
 * What is wrong with a monitor's JSON assertion, or null. Only HTTP monitors have one, its path must parse, and equals /
 * contains need something to compare with ("" is a value; null is not).
 */
export function jsonAssertionProblem(v: { type: string; method?: string | null; jsonPath?: string | null; jsonExpected?: string | null; jsonMatch?: string | null }): string | null {
  if (v.type !== "http") return v.jsonPath || v.jsonExpected != null ? "JSON assertions are supported for HTTP monitors only" : null;
  // a HEAD response has no body: the assertion would be skipped and the monitor pass on its status alone
  if (v.jsonPath && (v.method ?? "GET").toUpperCase() === "HEAD") return "A JSON assertion needs a response body; HEAD requests have none";
  const badPath = jsonPathProblem(v.jsonPath);
  if (badPath) return badPath;
  if (v.jsonPath && (v.jsonMatch ?? "equals") !== "exists" && v.jsonExpected == null) return "jsonExpected is required when jsonMatch is equals or contains";
  return null;
}

/** Browser fields on a monitor of another type, or a browser monitor without its journey. */
/** Whether a journey has a script (evaluate) step. */
const hasScript = (b: unknown) => !!b && typeof b === "object" && Array.isArray((b as { steps?: unknown }).steps) && (b as { steps: { action?: unknown }[] }).steps.some((s) => s?.action === "evaluate");
const scriptForbidden = (c: Context<AppEnv>) => c.json({ error: "Only workspace owners and admins can add or change a browser journey with a script step", code: "browser_script_requires_manager" }, 403);
const browserFieldProblem = (type: string, v: { browser?: unknown; browserSecrets?: Record<string, unknown> }) =>
  type === "browser" ? (v.browser ? null : "A browser monitor needs a journey (browser.steps)") : v.browser || Object.keys(v.browserSecrets ?? {}).length ? "browser and browserSecrets are for browser monitors only" : null;

function creationProblem(v: z.infer<typeof body>): string | null {
  if (v.requestBody === MASK) return "A masked request body cannot be imported or created; supply the original body";
  if (Object.values(v.browserSecrets).some((x) => x === MASK || x === null)) return "Browser secrets must be given as values when a monitor is created";
  const browser = browserFieldProblem(v.type, v);
  if (browser) return browser;
  if (v.type === "certificate" && isWorkers()) return `${WORKERS_UNSUPPORTED}; this deployment runs on Cloudflare Workers`;
  if (v.type === "ping" && isWorkers()) return `${PING_WORKERS_UNSUPPORTED}; this deployment runs on Cloudflare Workers`;
  return requestBodyProblem(v) ?? jsonAssertionProblem(v);
}

/**
 * What a spot check returns: the verdict fields only. Never the browser run (steps, screenshot bytes) or any other
 * nested object a check type may add, so nothing binary or secret-derived is ever serialised into a response.
 */
export function spotCheckResult(o: { ok: boolean; statusCode?: number; latencyMs?: number; error?: string }) {
  return { ok: o.ok === true, ...(typeof o.statusCode === "number" ? { statusCode: o.statusCode } : {}), ...(typeof o.latencyMs === "number" ? { latencyMs: o.latencyMs } : {}), ...(typeof o.error === "string" ? { error: o.error } : {}) };
}

/** Every goto of a journey must be a target this deployment allows (the egress policy refuses the rest at run time too). */
async function journeyTargetProblem(config: BrowserConfig): Promise<string | null> {
  for (const s of config.steps) {
    if (s.action !== "goto") continue;
    const problem = await browserUrlProblem(s.url);
    if (problem) return problem;
  }
  return null;
}

/** Types whose expiry is checked rather than their availability: an interval of 1 hour to 1 day is enough and is enforced. */
const EXPIRY_TYPES: readonly string[] = ["domain", "certificate"];
const expiryInterval = (sec: number) => Math.min(86400, Math.max(sec, 3600));

const newMonitor = (v: z.infer<typeof body>) => ({
  ...v,
  // by now every value is ciphertext (create) or the map is empty (other types): nulls and masks were refused
  browserSecrets: v.browserSecrets as Record<string, string>,
  ...(v.type !== "dns" ? DNS_DEFAULTS : {}),
  heartbeatToken: v.type === "heartbeat" ? crypto.randomUUID().replace(/-/g, "") : null,
  // a new heartbeat monitor must not be "missed" before its first ping is even due
  ...(v.type === "heartbeat" ? { nextCheckAt: nextAfter({ ...v, type: "heartbeat" as const }) } : {}),
});

/** A new monitor also alerts the project's auto-enable channels, on top of whatever it was given. */
async function withAutoChannels(repo: Repo, orgId: string, projectId: string, channelIds: string[]) {
  const auto = await repo.autoEnabledChannelIds(orgId, projectId);
  return auto.length ? [...new Set([...channelIds, ...auto])] : channelIds;
}

/**
 * What the workspace's plan refuses (HTTP 402), or null. `add` is how many active monitors the request would add and
 * `intervalSec` the interval it asks for. Deployments without plans (self-hosted) never refuse.
 */
async function overPlan(c: Context<AppEnv>, o: { add?: number; intervalSec?: number }) {
  const orgId = c.get("orgId");
  const plan = await c.get("entitlements").plan(orgId);
  if (!plan) return null;
  if (o.intervalSec !== undefined && o.intervalSec < plan.minIntervalSec) {
    return c.json({ error: `The ${plan.name} plan checks at most every ${plan.minIntervalSec / 60} min`, code: "interval_not_allowed", minIntervalSec: plan.minIntervalSec, plan: plan.id, upgradeUrl: plan.upgradeUrl }, 402);
  }
  if (o.add && plan.maxActiveMonitors !== null) {
    const active = await c.get("repo").activeMonitorCount(orgId);
    if (active + o.add > plan.maxActiveMonitors) {
      return c.json({ error: `The ${plan.name} plan allows ${plan.maxActiveMonitors} active monitors`, code: "monitor_limit", limit: plan.maxActiveMonitors, active, plan: plan.id, upgradeUrl: plan.upgradeUrl }, 402);
    }
  }
  return null;
}

/**
 * What is wrong with asking for these regions (HTTP 400 or 402), or null. Regions are explicit opt-in: `auto` alone is the
 * default and always fine. Anything else needs a probe configured on this deployment, a type a probe can run, and room in
 * the plan.
 */
async function regionProblem(c: Context<AppEnv>, type: string, regions: string[]) {
  const wanted = [...new Set(regions)];
  if (wanted.every((r) => r === AUTO)) return null;
  if (!(PROBE_TYPES as readonly string[]).includes(type)) {
    return c.json({ error: `Regions other than auto are available for ${PROBE_TYPES.join(" and ")} monitors only`, code: "regions_not_supported" }, 400);
  }
  const unknown = wanted.filter((r) => !isRegionConfigured(r));
  if (unknown.length) return c.json({ error: `Unknown region: ${unknown.join(", ")}`, code: "unknown_region", regions: unknown }, 400);
  const plan = await c.get("entitlements").plan(c.get("orgId"));
  if (plan?.maxRegions != null && wanted.length > plan.maxRegions) {
    return c.json({ error: `The ${plan.name} plan checks from at most ${plan.maxRegions} region${plan.maxRegions === 1 ? "" : "s"} per monitor`, code: "regions_not_allowed", limit: plan.maxRegions, plan: plan.id, upgradeUrl: plan.upgradeUrl }, 402);
  }
  return null;
}

/** How far up a chain of dependencies is followed; a longer one is refused as well. */
const MAX_DEPENDENCY_DEPTH = 10;

/**
 * HTTP 400 when `parentId` cannot be the parent of monitor `selfId` (null when creating): it must be another monitor of the
 * same project, and following the chain upwards must neither lead back to the monitor nor go on for ever.
 */
async function dependencyProblem(c: Context<AppEnv>, projectId: string | null, selfId: string | null, parentId: string | null) {
  if (parentId === null) return null;
  const refuse = (error: string, code: string) => c.json({ error, code }, 400);
  if (parentId === selfId) return refuse("A monitor cannot depend on itself", "dependency_self");
  const repo = c.get("repo");
  const parent = (await repo.monitorsByIds([parentId]))[0];
  if (!parent || parent.organizationId !== c.get("orgId") || parent.projectId !== projectId) {
    return refuse("The monitor it depends on must be another monitor of the same project", "dependency_not_found");
  }
  let at = parent;
  for (let depth = 0; depth < MAX_DEPENDENCY_DEPTH; depth++) {
    if (at.dependsOnMonitorId === null) return null;
    if (at.dependsOnMonitorId === selfId) return refuse("That would make the monitors depend on each other", "dependency_cycle");
    const next = (await repo.monitorsByIds([at.dependsOnMonitorId]))[0];
    if (!next) return null;
    at = next;
  }
  return refuse("Dependencies are nested too deeply", "dependency_cycle");
}

/** HTTP 400 unless the policy belongs to the workspace and is workspace-wide or the monitor's project's own, or null. */
async function policyProblem(c: Context<AppEnv>, projectId: string | null, policyId: string | null | undefined) {
  if (!policyId) return null;
  const policy = await c.get("repo").getEscalationPolicy(c.get("orgId"), policyId, null);
  if (!policy || (policy.projectId && policy.projectId !== projectId)) return c.json({ error: "The escalation policy must be a workspace-wide one or one of this project's", code: "policy_not_found" }, 400);
  return null;
}

/** HTTP 400 for a target that points at a private address (unless the deployment allows those), or null. */
async function refuseTarget(c: Context<AppEnv>, type: string, target: string) {
  // browser checks follow their own policy (BROWSER_CHECK_ALLOW_PRIVATE_TARGETS, loopback and own addresses never)
  const error = type === "browser" ? await browserUrlProblem(target) : await targetProblem(type, target);
  return error ? c.json({ error, code: "target_not_allowed" }, 400) : null;
}

/** Request headers and bodies (often tokens) are shown to owners and admins only; browser secrets to nobody. */
/** Scheduler bookkeeping of run coalescing (beginRuns): never part of the API (it would add ~150 bytes per monitor to every list). */
// and of browser checks: the deferral streak, digest bookkeeping and the secrets version (uncheckedSince is shown)
const SCHEDULER_ONLY = new Set(["checkedThroughGeneration", "checkedStartedAt", "runStartedThroughGeneration", "runStartedAt", "deferredSince", "lastDeferredRunAt", "uncheckedNotifiedAt", "browserSecretsVersion"]);
// One output object per monitor, built in a single pass. GET /api/monitors returns every monitor of the project (5.6 MB
// of JSON for 4,000 monitors), so each intermediate copy is multiplied by the rows and by concurrent requests: the
// previous spread + Object.entries/fromEntries (+ a second spread for members) made two to three full copies of every
// row and two-element arrays for each of its ~60 fields, all garbage by the time the response was sent. Same keys,
// order and masking as before.
const shown = async <T extends { headers?: Record<string, string> | null; requestBody?: string | null; browserSecrets?: Record<string, string> | null }>(c: Context<AppEnv>, rows: T[]): Promise<T[]> => {
  const manager = await isManager(c);
  return rows.map((m) => {
    const out: Record<string, unknown> = {};
    for (const k in m) {
      if (!Object.hasOwn(m, k) || SCHEDULER_ONLY.has(k)) continue;
      const v = (m as Record<string, unknown>)[k];
      if (k === "browserSecrets") out[k] = v === undefined ? v : maskedSecrets(v as Record<string, string> | null);
      else if (!manager && k === "headers" && v) out[k] = maskHeaders(v as Record<string, string>);
      else if (!manager && k === "requestBody" && v) out[k] = MASK;
      else out[k] = v;
    }
    return out as T;
  });
};

/** Source fields that look like credentials: a record carrying one is refused rather than imported without its authentication. */
const CREDENTIAL_KEY = /auth|user|pass|secret|token|cred|bearer|oauth/i;

/** Preview and execution share normalization and validation; only execution writes monitor rows. */
async function importMonitors(c: Context<AppEnv>, preview: boolean) {
  // the project asked for by header or by the dashboard's cookie; a stale or unknown id would otherwise fall back silently to another project
  const explicitProject = c.req.header("x-project-id") ?? cookieValue(c.req.header("cookie"), "montral_project");
  if (explicitProject && explicitProject !== ALL_PROJECTS && explicitProject !== c.get("projectId")) return c.json({ error: "The selected import project is unavailable", code: "import_project_unavailable" }, 403);
  const raw: unknown = await limitedJsonBody(c.req.raw, 4 * 1024 * 1024);
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (!preview && envelope.destination !== undefined) {
    const expected = envelope.destination as { organizationId?: unknown; projectId?: unknown } | null;
    if (expected?.organizationId !== c.get("orgId") || expected?.projectId !== c.get("projectId")) return c.json({ error: "The import destination changed; preview again", code: "import_destination_changed" }, 409);
  }
  const list = Array.isArray(raw) ? raw : envelope.monitors;
  if (!Array.isArray(list) || list.length < 1 || list.length > IMPORT_MAX) return c.json({ error: `Import between 1 and ${IMPORT_MAX} monitors` }, 400);
  const defaultSource = sourceSchema.safeParse(envelope.source ?? "json");
  if (!defaultSource.success) return c.json({ error: "Invalid source namespace" }, 400);
  type Row = { index: number; name: string | null; source?: string; sourceId?: string; status: string; monitorId?: string | null; error?: string; warnings: string[]; type?: string; intervalSec?: number; regions?: string[] };
  const report: Row[] = [];
  const candidates: { row: Row; value: z.infer<typeof body>; source: string; sourceId: string }[] = [];
  const plan = await c.get("entitlements").plan(c.get("orgId"));
  const aliases = new Set(["source", "sourceId", "id", "friendly_name", "friendlyName", "url", "hostname", "host", "port", "interval", "keyword_value", "expectedKeyword"]);
  const lookups = new Map<string, Promise<string | null>>();
  for (const [index, item] of list.entries()) {
    const r = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const row: Row = { index, name: typeof r.name === "string" ? r.name : null, status: "skipped", warnings: [] };
    report.push(row);
    const parsed = body.safeParse(normaliseImport(item));
    if (!parsed.success) { row.error = parsed.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; "); continue; }
    const v = parsed.data;
    row.name = v.name;
    const invalid = v.type === "browser" ? "Browser monitors cannot be imported; create them with POST /api/monitors" : creationProblem(v);
    if (invalid) { row.error = invalid; continue; }
    const source = sourceSchema.safeParse(r.source ?? defaultSource.data);
    if (!source.success) { row.error = "Invalid source namespace"; continue; }
    const unknown = Object.keys(r).filter((k) => !FIELD_KEYS.includes(k) && !aliases.has(k));
    if (unknown.length) row.warnings.push(`Unsupported fields: ${unknown.sort().join(", ")}`);
    // Never turn a secret placeholder or unsupported authentication into an unauthenticated monitor.
    if (r.headers && typeof r.headers === "object" && Object.values(r.headers).some((v) => v === MASK)) { row.error = "Masked headers cannot be restored; supply original credentials"; continue; }
    if (Object.keys(r).some((k) => !FIELD_KEYS.includes(k) && !aliases.has(k) && (k === "body" || CREDENTIAL_KEY.test(k)) && r[k] != null && r[k] !== "")) { row.error = "Unsupported authentication or request body; map it explicitly before importing"; continue; }
    if (Array.isArray(r.channelIds) && r.channelIds.length) row.warnings.push("Source channel references are not imported; destination auto-enabled channels apply");
    if (r.dependsOnMonitorId) row.warnings.push("Source monitor dependencies are not imported");
    if (v.type !== "heartbeat" && !v.target.trim()) { row.error = "target: required"; continue; }
    // a file often repeats a host; resolve each distinct target once (a read-only grant may run previews)
    const lookupKey = `${v.type}\0${v.target}`;
    if (!lookups.has(lookupKey)) lookups.set(lookupKey, targetProblem(v.type, v.target));
    const problem = await lookups.get(lookupKey)!;
    if (problem) { row.error = `target: ${problem}`; continue; }
    let sourceId: string;
    const identity = r.sourceId ?? r.id;
    if (identity !== undefined) {
      if ((typeof identity !== "string" && typeof identity !== "number") || !String(identity).trim() || String(identity).trim().length > 200 || /[\u0000-\u001f]/.test(String(identity))) { row.error = "sourceId must be a nonempty string of at most 200 characters"; continue; }
      sourceId = String(identity).trim();
    } else {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([v.type, v.name, v.target])));
      sourceId = "sha256:" + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
      row.warnings.push("No sourceId supplied; identity is derived from type, name and target. Changing them creates a new monitor");
    }
    const room = plan?.maxRegions ?? Infinity;
    const usable = (PROBE_TYPES as readonly string[]).includes(v.type) ? [...new Set(v.regions)].filter(isRegionConfigured).slice(0, room) : [];
    const regions = usable.length ? usable : [AUTO];
    if (JSON.stringify(v.regions) !== JSON.stringify(regions)) row.warnings.push("Regions adjusted to this deployment and plan");
    v.regions = regions;
    if (EXPIRY_TYPES.includes(v.type)) {
      const bounded = expiryInterval(v.intervalSec);
      if (bounded !== v.intervalSec) { v.intervalSec = bounded; row.warnings.push(`Interval adjusted to the 1 hour to 1 day range for ${v.type} checks`); }
    }
    if (v.type !== "heartbeat" && v.intervalSec < (plan?.minIntervalSec ?? 0)) { v.intervalSec = plan!.minIntervalSec; row.warnings.push("Interval raised to the plan minimum"); }
    Object.assign(row, { source: source.data, sourceId, type: v.type, intervalSec: v.intervalSec, regions: v.regions });
    candidates.push({ row, value: v, source: source.data, sourceId });
  }
  const repo = c.get("repo");
  const auto = candidates.length ? await repo.autoEnabledChannelIds(c.get("orgId"), c.get("projectId")) : [];
  const batch = await repo.importMonitors(c.get("orgId"), c.get("projectId"), candidates.map(({ value, source, sourceId }) => ({ source, sourceId, input: newMonitor({ ...value, channelIds: auto }) })), { preview, maxActive: plan?.maxActiveMonitors ?? null });
  batch.rows.forEach((r, i) => {
    const { existing, ...rest } = r;
    Object.assign(candidates[i].row, rest);
    if (r.status !== "duplicate" || !existing) return;
    const row = candidates[i].row as Row & { existing?: unknown };
    row.existing = existing;
    const v = candidates[i].value;
    if (existing.name !== v.name || existing.target !== v.target) row.warnings.push(`Skipped: this source ID already belongs to "${existing.name}" (${existing.target || "no target"}), which differs from this record; use a different source or sourceId if both are wanted`);
  });
  const created = report.filter((r) => r.status === "created").length;
  const duplicates = report.filter((r) => r.status === "duplicate").length;
  const ready = report.filter((r) => r.status === "ready").length;
  const skipped = report.filter((r) => r.status === "skipped").map(({ index, name, error }) => ({ index, name, error }));
  const project = (await repo.listProjects(c.get("orgId"), c.get("projectScope"))).find((p) => p.id === c.get("projectId"));
  const result = { destination: { organizationId: c.get("orgId"), projectId: c.get("projectId"), projectName: project?.name ?? null }, preview, created, duplicates, ready, skipped, report, canImport: !batch.limit && candidates.length > 0, autoChannelCount: auto.length, capacity: batch.limit };
  // same fields as the single-create 402 (error text, numeric limit, active, plan); the batch detail is under `capacity`
  if (batch.limit && !preview) return c.json({ ...result, error: `The ${plan?.name} plan allows ${batch.limit.max} active monitors`, code: "monitor_limit", limit: batch.limit.max, active: batch.limit.active, plan: plan?.id, upgradeUrl: plan?.upgradeUrl }, 402);
  if (!preview && created) await audit(c, "monitor.import", { type: "monitor", id: null }, auditChanges({}, { count: created }));
  return c.json(result, preview || (!created && duplicates) ? 200 : created ? 201 : 400);
}

export const monitors = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await shown(c, await c.get("repo").listMonitors(c.get("orgId"), await listedProjects(c)))))
  .post("/", zValidator("json", body), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    const invalid = creationProblem(v);
    if (invalid) return c.json({ error: invalid }, 400);
    if (hasScript(v.browser) && !(await isManager(c))) return scriptForbidden(c);
    if (EXPIRY_TYPES.includes(v.type)) v.intervalSec = expiryInterval(v.intervalSec);
    // the id is chosen here so the secrets can be encrypted bound to this monitor (see browser-secrets.ts)
    const id = crypto.randomUUID();
    if (v.type === "browser") v.intervalSec = Math.max(v.intervalSec, BROWSER_MIN_INTERVAL_SEC);
    if (v.type === "browser" && v.browser) {
      const unsupported = await browserCreationProblem();
      if (unsupported) return c.json(unsupported, 400);
      // the monitor's target is where the journey starts
      v.target = (v.browser.steps[0] as { url: string }).url;
      const missing = missingSecretProblem(v.browser, Object.keys(v.browserSecrets));
      if (missing) return c.json({ error: missing, code: "browser_secret_missing" }, 400);
      const badStep = await journeyTargetProblem(v.browser);
      if (badStep) return c.json({ error: badStep, code: "target_not_allowed" }, 400);
      v.browserSecrets = await applySecretUpdate(c.env.BETTER_AUTH_SECRET, c.get("orgId"), id, v.browserSecrets as Record<string, string>, {});
    }
    const blocked = await refuseTarget(c, v.type, v.target);
    if (blocked) return blocked;
    const badRegion = await regionProblem(c, v.type, v.regions);
    if (badRegion) return badRegion;
    const badParent = await dependencyProblem(c, c.get("projectId"), null, v.dependsOnMonitorId);
    if (badParent) return badParent;
    const badPolicy = await policyProblem(c, c.get("projectId"), v.escalationPolicyId);
    if (badPolicy) return badPolicy;
    const refused = await overPlan(c, { add: 1, intervalSec: v.type === "heartbeat" ? undefined : v.intervalSec });
    if (refused) return refused;
    const channelIds = await withAutoChannels(repo, c.get("orgId"), c.get("projectId"), v.channelIds);
    const created = await repo.createMonitor(c.get("orgId"), c.get("projectId"), { ...newMonitor({ ...v, channelIds }), id });
    await audit(c, "monitor.create", { type: "monitor", id: created.id, projectId: created.projectId }, auditChanges(v));
    return c.json((await shown(c, [created]))[0], 201);
  })
  // JSON backup of this project's monitors; feed it back to POST /import (here or in another workspace)
  // the browser runtime of this server (enabled, runner or in-process, last failure in fixed words); no secrets
  .get("/browser-runtime", (c) => {
    c.header("cache-control", "no-store");
    return c.json(browserRuntimeHealth());
  })
  .get("/export", async (c) => {
    const rows = await c.get("repo").exportMonitors(c.get("orgId"), c.get("projectId"));
    const monitors = (await shown(c, rows)).map((m) => Object.fromEntries(FIELD_KEYS.filter((k) => !NOT_EXPORTED.includes(k)).map((k) => [k, (m as unknown as Record<string, unknown>)[k]]).concat([["source", m.importSource ?? "montral"], ["sourceId", m.importSourceId ?? m.id]])));
    c.header("content-disposition", 'attachment; filename="montral-monitors.json"');
    return c.json({ version: 1, exportedAt: new Date().toISOString(), monitors });
  })
  .post("/import/preview", (c) => importMonitors(c, true))
  .post("/import", (c) => importMonitors(c, false))
  .get("/:id/time-coverage", uuidParams, async (c) => {
    const days = c.req.query("days") ?? "7";
    if (days !== "7" && days !== "30") return c.json({ error: "days must be 7 or 30" }, 400);
    const report = await c.get("repo").timeCoverage(c.get("orgId"), c.req.param("id"), c.get("projectScope"), days === "7" ? 7 : 30);
    if (!report) return c.json({ error: "Not found" }, 404);
    c.header("cache-control", "no-store");
    return c.json(report);
  })
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    return c.json({ ...(await shown(c, [m]))[0], ...(await repo.monitorDetail(m.id)) });
  })
  .patch("/:id", uuidParams, zValidator("json", patchBody), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    if (Object.keys(v).length === 0) return c.json({ error: "No changes" }, 400);
    // browser journeys and their write-only secrets; the target follows the first goto step
    if (v.browser !== undefined || v.browserSecrets !== undefined || v.target !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      if (current.type !== "browser") {
        const problem = browserFieldProblem(current.type, { browser: v.browser, browserSecrets: v.browserSecrets ?? {} });
        if (problem) return c.json({ error: problem }, 400);
      } else {
        if (v.target !== undefined && v.browser === undefined && v.target !== current.target) return c.json({ error: "The target of a browser monitor is the URL of its first goto step: change the journey instead" }, 400);
        if (v.browser === null) return c.json({ error: "A browser monitor needs a journey (browser.steps)" }, 400);
        const config = (v.browser ?? current.browser) as BrowserConfig;
        const stored = current.browserSecrets ?? {};
        const keepsStored = Object.keys(stored).length > 0 && (v.browserSecrets === undefined || Object.entries(v.browserSecrets).some(([k, x]) => x === MASK && stored[k] !== undefined));
        const changesJourney = v.browser !== undefined && !sameJson(v.browser, current.browser);
        // a script step acts with the target's origin (same-origin requests, past its CSP): owners and admins only
        if (changesJourney && hasScript(v.browser) && !(await isManager(c))) return scriptForbidden(c);
        // a stored secret goes wherever the journey types it: only managers may point the journey elsewhere around it
        if (keepsStored && changesJourney && !(await isManager(c))) {
          return c.json({ error: "Only workspace owners and admins can change a browser journey while keeping its stored secrets", code: "protected_browser_secrets" }, 403);
        }
        const nextSecrets = v.browserSecrets !== undefined ? await applySecretUpdate(c.env.BETTER_AUTH_SECRET, current.organizationId, current.id, v.browserSecrets, stored) : stored;
        const missing = missingSecretProblem(config, Object.keys(nextSecrets));
        if (missing) return c.json({ error: missing, code: "browser_secret_missing" }, 400);
        if (v.browser) {
          const badStep = await journeyTargetProblem(v.browser);
          if (badStep) return c.json({ error: badStep, code: "target_not_allowed" }, 400);
          v.target = (v.browser.steps[0] as { url: string }).url;
        }
        if (v.browserSecrets !== undefined) (v as { browserSecrets?: Record<string, string | null> }).browserSecrets = nextSecrets;
      }
    }
    if (v.dnsRecordType !== undefined || v.dnsExpectedValue !== undefined || v.dnsMatchMode !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      if (current.type !== "dns") Object.assign(v, DNS_DEFAULTS);
    }
    // judged on the stored assertion with the named fields changed, like keyword: a lone jsonMatch must still make sense
    if (v.jsonPath !== undefined || v.jsonExpected !== undefined || v.jsonMatch !== undefined || v.method !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const invalid = jsonAssertionProblem({ ...current, ...v, type: current.type });
      if (invalid) return c.json({ error: invalid }, 400);
    }
    // Retaining stored headers or a body also retains their access rights: only managers may change the request around them.
    if (v.headers !== undefined || v.target !== undefined || v.method !== undefined || v.wsMessage !== undefined || v.requestBody !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      if (v.headers) v.headers = restoreHeaders(v.headers, current.headers);
      if (v.requestBody === MASK) v.requestBody = current.requestBody ?? null;
      const invalid = requestBodyProblem({ ...current, ...v });
      if (invalid) return c.json({ error: invalid }, 400);
      const nextHeaders = v.headers ?? current.headers;
      const retainsStored = Object.entries(current.headers).some(([key, value]) => nextHeaders[key] === value)
        || Boolean(current.requestBody && (v.requestBody === undefined || v.requestBody === current.requestBody));
      const changesRequest = (v.target !== undefined && v.target !== current.target)
        || (v.method !== undefined && v.method !== current.method)
        || (v.wsMessage !== undefined && v.wsMessage !== current.wsMessage)
        || (v.requestBody !== undefined && v.requestBody !== (current.requestBody ?? null))
        || !sameJson(nextHeaders, current.headers);
      if (retainsStored && changesRequest && !(await isManager(c))) {
        return c.json({ error: "Only workspace owners and admins can change request settings while keeping stored headers or request body", code: "protected_request_headers" }, 403);
      }
    }
    if (v.target !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const blocked = await refuseTarget(c, current.type, v.target);
      if (blocked) return blocked;
    }
    if (v.regions !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const badRegion = await regionProblem(c, current.type, v.regions);
      if (badRegion) return badRegion;
    }
    if (v.dependsOnMonitorId !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const badParent = await dependencyProblem(c, current.projectId, current.id, v.dependsOnMonitorId);
      if (badParent) return badParent;
    }
    if (v.escalationPolicyId) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const badPolicy = await policyProblem(c, current.projectId, v.escalationPolicyId);
      if (badPolicy) return badPolicy;
    }
    if (v.intervalSec !== undefined || v.paused === false) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (current) {
        if (EXPIRY_TYPES.includes(current.type) && v.intervalSec !== undefined) v.intervalSec = expiryInterval(v.intervalSec);
        if (current.type === "browser" && v.intervalSec !== undefined) v.intervalSec = Math.max(v.intervalSec, BROWSER_MIN_INTERVAL_SEC);
        // only a faster interval is checked against the plan's floor; leaving an older, faster one in place is fine
        const faster = v.intervalSec !== undefined && v.intervalSec < current.intervalSec && current.type !== "heartbeat";
        const resuming = v.paused === false && current.status === "paused";
        const refused = await overPlan(c, { add: resuming ? 1 : 0, intervalSec: faster ? v.intervalSec : undefined });
        if (refused) return refused;
      }
    }
    const { browserSecrets: secretsPatch, ...plain } = v;
    const row = await repo.updateMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"), {
      ...plain,
      // replaced above by the encrypted map (masks kept, nulls dropped)
      ...(secretsPatch !== undefined ? { browserSecrets: secretsPatch as Record<string, string> } : {}),
      ...(v.paused !== undefined ? { status: v.paused ? "paused" : "pending", nextCheckAt: new Date() } : {}),
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    // new or removed secrets: screenshots of runs that typed the old ones go, whoever could see them before
    if (row.type === "browser" && secretsPatch !== undefined && repo.purgeSecretScreenshots) await repo.purgeSecretScreenshots(row.id);
    await audit(c, "monitor.update", { type: "monitor", id: row.id, projectId: row.projectId }, auditChanges(v));
    // a heartbeat's deadline depends on interval + grace, so re-derive it when either changes
    if (row.type === "heartbeat" && (v.intervalSec !== undefined || v.graceSec !== undefined) && v.paused === undefined) {
      const again = await repo.updateMonitor(c.get("orgId"), row.id, c.get("projectScope"), { nextCheckAt: nextAfter(row) });
      return c.json(again ? (await shown(c, [again]))[0] : again);
    }
    return c.json((await shown(c, [row]))[0]);
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const existing = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    await repo.deleteMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (existing) await audit(c, "monitor.delete", { type: "monitor", id: existing.id, projectId: existing.projectId }, auditChanges({}, { name: existing.name, type: existing.type }));
    return c.body(null, 204);
  })
  // Browser monitors: the latest runs (step timings, failing step, fixed errors) and a run's screenshot, within the workspace
  .get("/:id/browser-runs", uuidParams, async (c) => {
    const repo = c.get("repo");
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    c.header("cache-control", "no-store");
    if (m.type !== "browser" || !repo.listBrowserRuns) return c.json({ runs: [] });
    const runs = await repo.listBrowserRuns(m.id, 50);
    // decided per run, by what that run typed: removing secrets later does not open its screenshot to members
    const manager = await isManager(c);
    return c.json({ runs: manager ? runs : runs.map((r) => (r.usedSecrets ? { ...r, hasScreenshot: false } : r)) });
  })
  .get("/:id/browser-runs/:runId/screenshot", uuidParams, async (c) => {
    const repo = c.get("repo");
    const runId = c.req.param("runId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return c.json({ error: "Not found" }, 404);
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m || m.type !== "browser" || !repo.browserRunScreenshot) return c.json({ error: "Not found" }, 404);
    const shot = await repo.browserRunScreenshot(m.id, runId);
    if (!shot) return c.json({ error: "Not found" }, 404);
    // a page may show what a secret-filled step typed (masking covers the fields only): such a run's screenshot is for
    // owners and admins only, judged by the run itself, whatever the monitor holds now
    if (shot.usedSecrets && !(await isManager(c))) return c.json({ error: "Screenshots of runs that used secrets are visible to owners and admins only", code: "screenshot_managers_only" }, 403);
    return new Response(Uint8Array.from(shot.png), { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline; filename=\"browser-check.png\"" } });
  })
  // Runs the monitor's check now. With `region` it is one request from that region instead: the answer is returned and
  // nothing is recorded, so a spot check from elsewhere cannot flip the monitor's state.
  .post("/:id/check", uuidParams, async (c) => {
    const repo = c.get("repo");
    const asked = z.object({ region: z.string().regex(REGION_ID).optional() }).safeParse((await limitedJsonBody(c.req.raw, 1024)) ?? {});
    if (!asked.success) return c.json({ error: "region must be a region id", code: "unknown_region" }, 400);
    const region = asked.data.region;
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.type === "heartbeat") return c.json({ error: "Heartbeat monitors have no check to run", code: "regions_not_supported" }, 400);
    if (region !== undefined) {
      // a browser spot check would return the run itself (steps, screenshot) outside the workspace's run history and its
      // per-run screenshot authorization: browser monitors are checked through the recorded path only
      if (m.type === "browser") return c.json({ error: "Browser monitors have no spot check; run the check without a region and read its runs", code: "regions_not_supported" }, 400);
      if (!(PROBE_TYPES as readonly string[]).includes(m.type) && region !== AUTO) {
        return c.json({ error: `Regions other than auto are available for ${PROBE_TYPES.join(" and ")} monitors only`, code: "regions_not_supported" }, 400);
      }
      if (!isRegionConfigured(region)) return c.json({ error: `Unknown region: ${region}`, code: "unknown_region", regions: [region] }, 400);
    }
    // bounded per process (sockets, ping processes) and per workspace (shared by every server): see manual-check-gate.ts.
    // The process slot comes first, so a request refused as busy does not use up the workspace's allowance.
    const release = manualChecks.tryEnter();
    if (!release) {
      c.header("retry-after", "5");
      return c.json({ error: "This server is busy running other checks, try again shortly", code: "manual_check_busy" }, 429);
    }
    try {
      if (!(await repo.withinLimit(`mcheck:${m.organizationId}`, MANUAL_CHECKS_PER_WINDOW, MANUAL_CHECK_WINDOW_SEC))) {
        c.header("retry-after", "60");
        return c.json({ error: "Too many manual checks, try again in a few minutes", code: "manual_check_rate_limited" }, 429);
      }
      const cost = region !== undefined ? 1 : creditCost(m);
      // a manual check is a request like any other: it takes a credit
      const spentAt = new Date();
      if (!(await spendAllOrNothing(m.organizationId, cost, c.get("entitlements"), spentAt))) {
        return c.json({ error: "No credits left this period", code: "credits_exhausted" }, 402);
      }
      if (region === undefined) {
        const result = await checkOne(repo, m, c.get("entitlements"));
        // a browser check that did not happen (deferred for capacity, runtime failure) gives its credits back
        if (result === "deferred" || result === "error") await refundCredits(m.organizationId, cost, c.get("entitlements"), spentAt);
        return c.json({ ok: true });
      }
      const run = await runInRegion(region, m, repo);
      if ("unreachable" in run) return c.json({ error: run.unreachable, code: "probe_unreachable", region }, 502);
      return c.json({ ok: true, region, result: spotCheckResult(run.outcome) });
    } finally {
      release();
    }
  });
