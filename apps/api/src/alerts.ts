import { MAX_REMINDERS, personalChannel, type AlertChannel, type AlertDelivery, type DeliveryRetry, type EscalationDue, type NewDelivery, type Repo, type SubscriberTarget, type WorkspaceMember } from "@montral/repo";
import { sendPush } from "./apns";
import { actionEmail, appUrl, sendEmail } from "./email";
import { unmetered, type Entitlements } from "./entitlements";
import { isLang, orgLang, tr, userLang, type Lang } from "./mail-i18n";
import { guardedFetch, readCapped } from "./netguard";
import { onCallAt } from "./oncall-engine";
import { ttlCache } from "./ttlcache";

type Event = {
  /** a reminder or escalation repeats the down alert for an incident nobody has acknowledged */
  kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated";
  /** which repeat (reminder) or level (escalation) this is */
  count?: number;
  incident: { id: string; title: string; startedAt?: Date; resolvedAt?: Date | null };
  /** Why the check failed, shown in the down email. */
  reason?: string;
  /** Channel test: rendered as a "connected" message instead of an incident. */
  test?: true;
  /** latency incident rather than an outage */
  slow?: true;
  /** the monitor failed again soon after recovering, so an earlier incident was reopened */
  reopened?: true;
  monitor: { id?: string; projectId?: string | null; name: string; target: string; type?: string; domainExpiry?: { state: string; error: string | null } | null };
  /** The monitor's project; filled in when the alert goes out. */
  project?: { id: string; name: string };
  /** The workspace has more than one project, so the project's name is shown in the alert. */
  multiProject?: true;
};

const PROJECT_TTL_MS = 30_000;
const projectCache = ttlCache<{ names: Map<string, string> }>(PROJECT_TTL_MS);
/** For tests: forget the cached project names. */
export const clearProjectNames = () => projectCache.clear();

/**
 * Names the monitor's project on the event. The workspace's projects are read once and kept for a short while, so a burst of
 * alerts costs one query. A lookup that fails leaves the event as it is: an alert never waits on, or fails because of, a name.
 */
export async function withProject<E extends Event>(repo: Repo, orgId: string, ev: E): Promise<E> {
  const id = ev.monitor.projectId;
  if (!id) return ev;
  try {
    let hit = projectCache.get(orgId);
    if (!hit) {
      hit = { names: new Map((await repo.listProjects(orgId, null)).map((p) => [p.id, p.name])) };
      projectCache.set(orgId, hit);
    }
    const name = hit.names.get(id);
    if (!name) return ev;
    return { ...ev, project: { id, name }, ...(hit.names.size > 1 ? { multiProject: true as const } : {}) };
  } catch (e) {
    console.error("project name lookup failed");
    return ev;
  }
}

/** `[name] ` when the alert should say which project it is from, else nothing. */
const tag = (ev: Pick<Event, "project" | "multiProject">) => (ev.project && ev.multiProject ? `[${ev.project.name}] ` : "");

const utc = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const duration = (ms: number, lang: Lang = "en") => {
  const m = Math.max(1, Math.round(ms / 60000));
  const [h, min] = lang === "zh-CN" ? ["小时", "分钟"] : ["h", "min"];
  const sp = lang === "zh-CN" ? "" : " ";
  return m < 60 ? `${m}${sp}${min}` : `${Math.floor(m / 60)}${sp}${h}${m % 60 ? ` ${m % 60}${sp}${min}` : ""}`;
};

/** Only vetted diagnostic categories may reach persisted delivery rows. Provider exceptions
 * can echo webhook secrets, unsubscribe tokens or recipients verbatim. */
export const safeDeliveryReason = (e: unknown): string => {
  if (e instanceof RoutingUnavailable) return ROUTING_UNAVAILABLE;
  const message = e instanceof Error ? e.message : "";
  if (message === "Email provider is not configured") return message;
  const http = /\bHTTP ([1-5][0-9]{2})\b/.exec(message);
  return http ? `notification provider HTTP ${http[1]}` : "notification delivery failed";
};

/** A slow or hung provider must not hold the check run (or the whole queue message) hostage. */
const SEND_TIMEOUT_MS = 10_000;

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });

/** The destination's host only: webhook paths and bot tokens are credentials and must not end up in logs or delivery rows. */
const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return "the destination"; }
};

/** Sends through the SSRF guard; errors name the host, never the full URL. */
async function send(url: string, body: unknown) {
  try {
    return (await guardedFetch(url, json(body))).res;
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "BlockedTarget" ? (e as Error).message : name === "TimeoutError" ? `${hostOf(url)} timed out` : `Could not reach ${hostOf(url)}`);
  }
}

async function post(url: string, body: unknown) {
  const res = await send(url, body);
  // The provider may finish its HTTP status but never settle body-stream cancellation.
  // Cleanup must not delay an acknowledged alert or leave a failed attempt stuck.
  void res.body?.cancel().catch(() => {}); // no untrusted response body is retained
  if (!res.ok) throw new Error(`${hostOf(url)} responded HTTP ${res.status}`);
}

/** A provider may complete its response headers while never yielding an ACK
 * body. A separate finite body deadline is required even if the transport's
 * initial response used an abort signal; otherwise a noncompliant stream
 * can hold an alert delivery open forever. */

/** Telegram's Bot API reports application-level acceptance in `ok`. An HTTP 200
 * alone (including a proxy's HTML response) is never delivery confirmation. */
async function postTelegram(token: string, chatId: string, text: string) {
  const res = await send(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text });
  const data: unknown = await readCapped(res, 64 * 1024, AbortSignal.timeout(SEND_TIMEOUT_MS)).then((body) => JSON.parse(body) as unknown).catch(() => null);
  const ack = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  if (res.ok && ack?.ok === true) return;
  // Telegram's description could contain customer text or bot credentials.
  // Keep the HTTP status and an integer API error code, never untrusted body text.
  const apiCode = ack?.error_code;
  const detail = typeof apiCode === "number" && Number.isSafeInteger(apiCode) && apiCode >= 100 && apiCode <= 599
    ? ` (API code ${apiCode})` : " (missing or invalid acknowledgement)";
  throw new Error(`Telegram responded HTTP ${res.status}${detail}`);
}

/** Teams rejects a message body over 4000 characters. */
const TEAMS_LIMIT = 4000;
/**
 * Backslash-escape the Markdown control characters Adaptive Card TextBlocks interpret, then cap the length (escapes included).
 * Both JS and the limit count UTF-16 code units; iterating by code point keeps a surrogate pair (emoji) from being cut in half.
 */
export function teamsText(text: string): string {
  // each piece is one whole code point with its escape, so a cut can neither split a surrogate pair nor leave a lone backslash
  const pieces = Array.from(text, (ch) => (/[\\*_\[\]()`]/.test(ch) ? `\\${ch}` : ch));
  if (pieces.reduce((n, piece) => n + piece.length, 0) <= TEAMS_LIMIT) return pieces.join("");
  let out = "";
  for (const piece of pieces) {
    if (out.length + piece.length > TEAMS_LIMIT - 1) break;
    out += piece;
  }
  return `${out}…`;
}

/**
 * Lark / Feishu custom bot. The hook answers 200 even when it refuses a message, so the body's `code` decides; an optional
 * signing secret is sent as `sign = base64(HMAC-SHA256(key = "<timestamp>\n<secret>", message = ""))`.
 */
async function postLark(url: string, text: string, secret?: string) {
  const body: Record<string, unknown> = { msg_type: "text", content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${timestamp}\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array()));
    body.timestamp = timestamp;
    body.sign = btoa(String.fromCharCode(...mac));
  }
  const res = await send(url, body);
  const data: unknown = await readCapped(res, 64 * 1024, AbortSignal.timeout(SEND_TIMEOUT_MS)).then((t) => JSON.parse(t) as unknown).catch(() => null);
  // Lark/Feishu may respond HTTP 200 even when a message was rejected. A missing,
  // malformed or conflicting application acknowledgement must never count as "sent".
  const ack = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const code = ack?.code ?? ack?.StatusCode;
  const valid = res.ok && (ack?.code === 0 || ack?.StatusCode === 0) &&
    (ack?.code === undefined || ack.code === 0) &&
    (ack?.StatusCode === undefined || ack.StatusCode === 0);
  if (!valid) {
    // Provider message text could echo webhook URLs, signing secrets or monitor data.
    const detail = typeof code === "number" && Number.isSafeInteger(code) && code !== 0 ? ` (provider code ${code})` : " (missing or invalid acknowledgement)";
    throw new Error(`Lark responded HTTP ${res.status}${detail}`);
  }
}

/**
 * POST JSON to a destination whose URL or headers carry a credential, without following redirects: a 3xx is a failure, so
 * neither the token header nor the alert body can be bounced to a host nobody configured. Errors name the host only.
 */
async function postDirect(url: string, body: unknown, headers: Record<string, string> = {}) {
  const init = json(body);
  let res: Response;
  try {
    res = (await guardedFetch(url, { ...init, headers: { ...init.headers, ...headers } }, { follow: false })).res;
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "BlockedTarget" ? (e as Error).message : name === "TimeoutError" ? `${hostOf(url)} timed out` : `Could not reach ${hostOf(url)}`);
  }
  return res;
}

/** postDirect for providers whose 2xx is the acknowledgement; the body is never read, so it cannot echo into errors. */
async function postAcked(url: string, body: unknown, headers?: Record<string, string>) {
  const res = await postDirect(url, body, headers);
  void res.body?.cancel().catch(() => {}); // best-effort, as in post(): a hostile stream must not stall delivery
  if (!res.ok) throw new Error(`${hostOf(url)} responded HTTP ${res.status}`);
}

/** At most `max` code points, a trailing `…` included when cut; a surrogate pair (emoji) is never split. */
export function capChars(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * Google Chat text for an incoming webhook (Chat markup syntax). `<…>` is link and mention syntax there (`<users/all>`
 * pings the whole space), so angle brackets from monitor names or titles become look-alike ‹ › and can neither mention
 * nor inject a link. Chat documents no escape for * _ ~ `, which only format. Capped like Teams at 4000 characters.
 */
export const googleChatText = (text: string) => capChars(text.replace(/</g, "‹").replace(/>/g, "›"), 4000);

/**
 * Mattermost posts are Markdown: control characters are backslash-escaped (as for Teams) so a monitor name cannot format
 * the post or inject a link, and the length stays well under Mattermost's 16383-character post limit, past which the
 * server would split the alert into several posts.
 */
/**
 * Mattermost text: Teams-style Markdown escaping, plus a zero-width space after every "@", so a monitor or incident name
 * such as "API @all" cannot notify a whole channel (@channel, @all, @here) or ping a user on every alert.
 */
export const mattermostText = (text: string) => teamsText(text.replace(/@/g, "@​"));

/** The incident in the app, for providers that can open a link from the notification; a channel test (or a server without
 * an absolute app URL configured) has none, since a relative link would open nowhere. */
const incidentLink = (ev: Event) => (ev.test || !/^https?:\/\//i.test(appUrl()) ? undefined : `${appUrl().replace(/\/+$/, "")}/app/incidents/${ev.incident.id}`);

/**
 * Gotify: POST <server>/message with the application token in X-Gotify-Key (never in the query string, where proxies
 * log it). Android shows 8–10 with sound and vibration and 4–7 with sound only, so a down alert (and its repeats and
 * escalations) is 8 and a recovery or test is 4.
 */
export function gotifyRequest(base: string, token: string, ev: Event, text: string) {
  const down = ev.kind !== "incident.resolved" && !ev.test;
  const link = incidentLink(ev);
  return {
    url: `${base.replace(/\/+$/, "")}/message`,
    headers: { "x-gotify-key": token },
    body: { title: "Montral", message: capChars(text, 4000), priority: down ? 8 : 4, ...(link ? { extras: { "client::notification": { click: { url: link } } } } : {}) },
  };
}

/**
 * Pushover message: the body is capped at its 1024-character limit; priority 1 (high: bypasses quiet hours) for a down
 * alert or escalation, 0 for a recovery or test. Emergency priority (2) is not used: it needs retry/expire receipts.
 */
export function pushoverBody(cfg: { token?: string; userKey?: string; device?: string }, ev: Event, text: string) {
  const link = incidentLink(ev);
  return {
    token: cfg.token, user: cfg.userKey, ...(cfg.device ? { device: cfg.device } : {}),
    title: "Montral", message: capChars(text, 1024),
    priority: ev.kind !== "incident.resolved" && !ev.test ? 1 : 0,
    ...(link ? { url: link, url_title: "View incident" } : {}),
  };
}

/** Pushover acknowledges with `status: 1`; anything else (an HTML proxy page, a 200 without it) is not delivery. */
async function postPushover(body: ReturnType<typeof pushoverBody>) {
  const res = await postDirect("https://api.pushover.net/1/messages.json", body);
  const data: unknown = await readCapped(res, 64 * 1024, AbortSignal.timeout(SEND_TIMEOUT_MS)).then((t) => JSON.parse(t) as unknown).catch(() => null);
  const ack = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  if (res.ok && ack?.status === 1) return;
  // the `errors` array can repeat the token or user key it rejects: only the HTTP status is kept
  throw new Error(`Pushover responded HTTP ${res.status}${res.ok ? " (missing or invalid acknowledgement)" : ""}`);
}

const domainHeading = (ev: Event, opened = ev.kind !== "incident.resolved") => !opened ? "{name}: domain expiry verified" : (!ev.monitor.domainExpiry || ev.monitor.domainExpiry.state === "unknown") ? "{name}: domain expiry unknown" : ev.monitor.domainExpiry?.state === "expired" ? "{name}: registration date passed" : "{name}: domain renewal needed";
const alertText = (ev: Event) => ev.monitor.type === "domain"
  ? `${tag(ev)}${domainHeading(ev).replace("{name}", ev.monitor.name)} — ${ev.kind === "incident.resolved" ? ev.monitor.target : ev.reason ?? ev.monitor.domainExpiry?.error ?? ev.incident.title}`
  :
  ev.kind === "incident.opened"
    ? `${ev.slow ? "🟡" : "🔴"} ${tag(ev)}${ev.monitor.name} ${ev.slow ? "is responding slowly" : "is down"}${ev.reopened ? " again" : ""} — ${ev.incident.title}`
    : ev.kind === "incident.reminder"
      ? `⏰ ${tag(ev)}${ev.monitor.name} ${ev.slow ? "is still responding slowly" : "is still down"} and nobody has acknowledged it — reminder ${ev.count ?? 1}`
      : ev.kind === "incident.escalated"
        ? `🚨 ${tag(ev)}${ev.monitor.name} ${ev.slow ? "is still responding slowly" : "is still down"} and nobody has acknowledged it — escalated to you`
        : `✅ ${tag(ev)}${ev.monitor.name} has recovered`;

/** The alert is not sent, on purpose, and that is final (an allowance used up, a channel switched off); never retried. The message is the reason shown to people. */
export class Skipped extends Error {}
const SKIPPED = "skipped: email allowance used up for this period";
const RETRIED_KINDS = new Set(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"]);

/** Devices an event is being pushed to, with whether that push worked: a phone is pushed once per event, unless the first push failed. */
export type PushedDevices = Map<string, Promise<boolean>>;

/** Take emails for `subs` from the allowance: who may be mailed and how many were left out.
 * A temporarily unavailable ledger preserves critical alert delivery, but a malformed *successful*
 * grant must not silently over-authorize or produce negative/NaN skipped counts. */
async function withinEmails<T>(entitlements: Entitlements, orgId: string, subs: T[]) {
  if (!subs.length) return { send: subs, skipped: 0 };
  // Incident alerts are the product's core promise: a failing ledger still sends them (bounded by incident dedupe), in
  // every edition. Reports and digests, which may be omitted, fail closed in a metered deployment.
  const granted = await entitlements.spendEmails(orgId, subs.length).catch(() => (console.error("email allowance unavailable"), subs.length));
  if (!Number.isSafeInteger(granted) || granted < 0 || granted > subs.length) {
    console.error("email allowance invalid");
    return { send: [] as T[], skipped: subs.length };
  }
  return { send: subs.slice(0, granted), skipped: subs.length - granted };
}

/** Authorization is separate from quota: policy failure must never fall back to sending. */
async function subscriberAllowance(entitlements: Entitlements, orgId: string, subs: SubscriberTarget[]) {
  const allowed: SubscriberTarget[] = [];
  for (let offset = 0; offset < subs.length; offset += 8) {
    const batch = subs.slice(offset, offset + 8);
    const decisions = await Promise.all(batch.map(async (sub) => !entitlements.canNotifySubscriber || await entitlements.canNotifySubscriber(orgId, sub) === true));
    allowed.push(...batch.filter((_sub, index) => decisions[index]));
  }
  const quota = await withinEmails(entitlements, orgId, allowed);
  const denied = subs.length - allowed.length;
  return { ...quota, denied, skipped: quota.skipped + denied };
}

/** Attempts per alert, the first one included. The first retry is queued a minute after the failure, the next five minutes later. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SEC = 300;
const FIRST_RETRY_DELAY_SEC = 60;
/** A row that stays in `sending` this long belongs to a worker that died. */
export const STUCK_SEC = 300;

const eventOf = (kind: string, incident: DeliveryRetry["incident"], monitor: DeliveryRetry["monitor"], count?: number, reopened = false): Event => ({
  kind: kind === "incident.resolved" || kind === "incident.reminder" || kind === "incident.escalated" ? kind : "incident.opened",
  count,
  incident: { id: incident.id, title: incident.title, startedAt: incident.startedAt, resolvedAt: incident.resolvedAt },
  monitor: { id: monitor.id, projectId: monitor.projectId, name: monitor.name, target: monitor.target, type: monitor.type, domainExpiry: monitor.domainExpiry },
  ...(incident.auto && incident.severity === "minor" ? { slow: true as const } : {}),
  ...(reopened ? { reopened: true as const } : {}),
});

const languageFor = async (repo: Repo, channel: AlertChannel, fallback?: Lang) => {
  const to = (channel.config as { to?: string }).to;
  return channel.type === "email" && to ? userLang(repo, to, fallback ?? (await orgLang(repo, channel.organizationId))) : (fallback ?? "en");
};

/**
 * Marker for "the routing policy could not decide yet". It is both the error shown in the delivery row and the control
 * flag: a pending or retried row whose `error` equals this still needs a routing decision before anything is sent, so
 * retries and worker recovery re-ask the policy at the original time. A provider attempt replaces the marker, which
 * is how a row that is already authorized is told apart. The coupling is deliberate: a separate flag column would have
 * to be kept in step by every writer of `error` (queueing, finishing, the stuck-row sweep) for no gain.
 */
const ROUTING_UNAVAILABLE = "alert routing policy unavailable";
/**
 * A policy outage does not use up the normal attempt budget (MAX_ATTEMPTS, about six minutes): the alert keeps waiting for
 * a decision, every ROUTING_RETRY_SEC, and is only given up once it is older than ROUTING_WINDOW_SEC.
 */
const ROUTING_RETRY_SEC = 120;
const ROUTING_WINDOW_SEC = 6 * 3600;
class RoutingUnavailable extends Error { constructor() { super(ROUTING_UNAVAILABLE); } }
async function authorizeChannel(channel: AlertChannel, ev: Event, entitlements: Entitlements, at: Date) {
  let allowed: boolean;
  try {
    if (!entitlements.allowAlertChannel) throw new RoutingUnavailable();
    allowed = await entitlements.allowAlertChannel(channel.organizationId, {
      projectId: ev.monitor.projectId ?? null, monitorId: ev.monitor.id ?? null,
      incidentId: ev.incident.id, kind: ev.kind, at, channelId: channel.id,
    });
  } catch (cause) {
    // the generic marker is all that reaches the delivery row; the cause (which may carry provider detail) stays in the server log
    if (!(cause instanceof RoutingUnavailable)) console.error("alert routing policy failed");
    throw new RoutingUnavailable();
  }
  if (allowed !== true) throw new Skipped("skipped: not selected by alert routing policy");
}

/**
 * Send one delivery that this worker has already claimed (status `sending`) and record the outcome. Never throws.
 * `meter` charges an email against the workspace allowance; retries are not charged again.
 */
async function execute(repo: Repo, d: Pick<AlertDelivery, "id" | "kind" | "attempts" | "emailQuotaAttempted"> & Partial<Pick<AlertDelivery, "createdAt">>, channel: AlertChannel, ev: Event, lang: Lang, meter?: Entitlements, pushed?: PushedDevices, routingAt?: Date) {
  const attempts = d.attempts + 1;
  try {
    if (routingAt) await authorizeChannel(channel, ev, meter ?? unmetered, routingAt);
    if (meter && channel.type === "email" && !d.emailQuotaAttempted) {
      if (routingAt) {
        // Persist before spending: a worker can disappear after charging but before calling the provider.
        // Recovery still reauthorizes routing, but must not charge the same delivery again.
        // A crash immediately after this checkpoint may leave one email uncharged (quota is fail-open).
        let owned: boolean;
        try { owned = await repo.markDeliveryEmailQuotaAttempt(d.id, d.attempts); }
        catch (cause) { console.error("alert quota checkpoint failed"); throw new RoutingUnavailable(); }
        if (!owned) return false;
      }
      if ((await withinEmails(meter, channel.organizationId, [channel])).skipped) throw new Skipped(SKIPPED);
    }
    // a repeat or an escalation is pointless once someone took the incident: checked again right before sending
    if ((d.kind === "incident.escalated" || d.kind === "incident.reminder") && (await followUpStopped(repo, ev.incident.id))) {
      throw new Skipped("skipped: the incident was acknowledged or resolved before this alert could be sent");
    }
    await deliver(channel, ev, alertText(ev), lang, repo, pushed);
    await repo.finishDelivery(d.id, { status: "sent", error: null, message: null });
    return true;
  } catch (e) {
    if (e instanceof Skipped) {
      await repo.finishDelivery(d.id, { status: "skipped", error: e.message, message: e.message }).catch((x) => console.error("could not record a skipped alert"));
      return false;
    }
    console.error("alert delivery failed");
    const why = safeDeliveryReason(e);
    if (e instanceof RoutingUnavailable && RETRIED_KINDS.has(d.kind)) {
      const ageSec = d.createdAt ? (Date.now() - new Date(d.createdAt).getTime()) / 1000 : 0;
      const waiting = ageSec < ROUTING_WINDOW_SEC;
      const message = waiting ? `failed: ${why} (not counted as an attempt, trying again in ${ROUTING_RETRY_SEC / 60} min)` : `failed: ${why} (gave up after ${ROUTING_WINDOW_SEC / 3600} hours)`;
      await repo.finishDelivery(d.id, { status: "failed", error: why, message, retryInSec: waiting ? ROUTING_RETRY_SEC : null, keepAttempts: waiting }).catch((x) => console.error("could not record a failed alert"));
      return false;
    }
    const retryInSec = !RETRIED_KINDS.has(d.kind) || attempts >= MAX_ATTEMPTS ? null : attempts === 1 ? FIRST_RETRY_DELAY_SEC : RETRY_DELAY_SEC;
    const message = retryInSec == null ? `failed: ${why}${RETRIED_KINDS.has(d.kind) ? ` (gave up after ${attempts} attempts)` : ""}` : `failed: ${why} (attempt ${attempts} of ${MAX_ATTEMPTS}, trying again in ${retryInSec >= 120 ? `${retryInSec / 60} min` : `${retryInSec} s`})`;
    await repo.finishDelivery(d.id, { status: "failed", error: why, message, retryInSec }).catch((x) => console.error("could not record a failed alert"));
    return false;
  }
}

/** A delivery row that counts as an alert people could have seen: not one that was skipped or failed. */
export const wasDelivered = (r: { status?: string | null; ok?: boolean }) => (r.status ? r.status !== "skipped" && r.status !== "failed" : r.ok !== false);

/** Try failed incident alerts again. Each channel's own delivery row is updated; nothing here throws. */
export async function retryDeliveries(repo: Repo, limit = 10, entitlements: Entitlements = unmetered) {
  const due: DeliveryRetry[] = await repo.claimRetries(limit);
  // a phone is pushed once per event, also when several of its retries are due in the same round
  const pushedBy = new Map<string, PushedDevices>();
  for (const { delivery, incident, monitor, channel } of due) {
    try {
      // a repeat or escalation is pointless once someone has taken the incident
      if ((delivery.kind === "incident.reminder" || delivery.kind === "incident.escalated") && (incident.acknowledgedAt || incident.resolvedAt)) {
        const why = incident.resolvedAt ? "skipped: the incident was resolved before this alert could be sent" : "skipped: the incident was acknowledged before this alert could be sent";
        await repo.finishDelivery(delivery.id, { status: "skipped", error: why, message: why });
        continue;
      }
      // the incident changed while this alert waited for its retry: a "down" for one that has recovered, or a "recovered" for one that was reopened
      if ((delivery.kind === "incident.opened" && incident.resolvedAt) || (delivery.kind === "incident.resolved" && !incident.resolvedAt)) {
        const why = delivery.kind === "incident.opened" ? "skipped: the incident was resolved before this alert could be sent" : "skipped: the incident was reopened before this alert could be sent";
        await repo.finishDelivery(delivery.id, { status: "skipped", error: why, message: why });
        continue;
      }
      // A reopened incident alerts again as "down again". Which of its down alerts this is follows from the order they were
      // queued in: a later one makes this a stale original, an earlier one makes this the "again".
      let reopened = false;
      if (delivery.kind === "incident.opened" && incident.evaluationNote?.startsWith("reopened")) {
        const opened = (await repo.incidentDeliveries(incident.organizationId, incident.id)).filter((x) => x.kind === "incident.opened" && x.id !== delivery.id);
        if (opened.some((x) => x.channelId === delivery.channelId && x.createdAt > delivery.createdAt && wasDelivered(x))) {
          const why = "skipped: the incident was reopened and alerted again before this alert could be sent";
          await repo.finishDelivery(delivery.id, { status: "skipped", error: why, message: why });
          continue;
        }
        reopened = opened.some((x) => x.createdAt < delivery.createdAt);
      }
      const ev = await withProject(repo, incident.organizationId, eventOf(delivery.kind, incident, monitor, delivery.kind === "incident.escalated" ? incident.escalationLevel : incident.reminderCount, reopened));
      const eventKey = `${incident.id}:${delivery.kind}:${ev.count ?? 0}`;
      if (!pushedBy.has(eventKey)) pushedBy.set(eventKey, new Map());
      const pendingRouting = delivery.error === ROUTING_UNAVAILABLE;
      await execute(repo, delivery, channel, ev, await languageFor(repo, channel), pendingRouting ? entitlements : undefined, pushedBy.get(eventKey), pendingRouting ? delivery.createdAt : undefined);
    } catch {
      // Rows were already claimed as `sending`. A transient read/finish error must
      // not starve later deliveries; the sweeper recovers the interrupted row after
      // its lease expires. Do not send it again now: provider acceptance may be ambiguous.
      // Exceptions can echo bot credentials, webhook URLs or subscriber addresses.
      console.error("alert retry item interrupted; awaiting delivery sweep");
    }
  }
  return due.length;
}

/**
 * Queue one delivery per channel, claim each (one conditional UPDATE, so overlapping runs cannot send the same row twice)
 * and send it. Switched-off channels get a row that says so. A log that cannot be written must not stop the alert, so the
 * channels without a row are sent directly.
 */
async function fanOut(repo: Repo, orgId: string, event: Event, channels: AlertChannel[], entitlements: Entitlements, extra: Partial<NewDelivery> = {}) {
  const ev = await withProject(repo, orgId, event);
  const fallback = channels.some((c) => c.type === "email") ? await orgLang(repo, orgId) : "en";
  const base = { organizationId: orgId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name, ...extra };
  // a person notified directly has no channel row: the delivery names them instead (see personalChannel)
  const target = (c: AlertChannel) => (isPersonal(c) ? { channelId: null, targetUserId: personalUserId(c) } : { channelId: c.id });
  const live = channels.filter((c) => c.enabled);
  const off = channels.filter((c) => !c.enabled);
  // An audit-write failure for disabled channels must not mute enabled channels.
  if (off.length) await repo.logDeliveries(off.map((c) => ({ ...base, ...target(c), channelName: c.name, channelType: c.type, ok: false, status: "skipped" as const, error: "skipped: channel disabled", statusMessage: "skipped: channel disabled" }))).catch(() => console.error("disabled alert channel audit unavailable"));
  // a phone is pushed once per event, however many push channels reach it
  const pushed: PushedDevices = new Map();
  // Persist the pending authorization before claiming: worker recovery must not bypass the policy.
  // A completed provider attempt replaces this marker; interrupted attempts retain it for safe reevaluation.
  const rows = await repo.queueDeliveries(live.map((c) => ({ ...base, ...target(c), channelName: c.name, channelType: c.type, ok: false, ...(entitlements.allowAlertChannel ? { error: ROUTING_UNAVAILABLE } : {}) })));
  // Wait for every channel even if a database claim or locale lookup fails.
  // The interrupted delivery remains pending/sending for the existing sweep; an
  // immediate retry here could duplicate an already-accepted provider message.
  const outcomes = await Promise.allSettled(
    live.map(async (c) => {
      const lang = await languageFor(repo, c, fallback);
      const row = rows.find((r) => (isPersonal(c) ? r.targetUserId === personalUserId(c) && r.channelType === c.type : r.channelId === c.id));
      if (!row) {
        // no row to claim: send anyway, only the history is missing
        try {
          if (entitlements.allowAlertChannel) await authorizeChannel(c, ev, entitlements, new Date());
        } catch (e) {
          if (e instanceof Skipped) {
            await repo.logDeliveries([{ ...base, ...target(c), channelName: c.name, channelType: c.type, ok: false, status: "skipped", error: e.message, statusMessage: e.message }]).catch(() => {});
            return;
          }
          // No row means no durable retry, so a policy failure here loses this alert: say so loudly and try to leave a trace.
          console.error("ALERT NOT SENT: routing policy unavailable and retry could not be queued");
          await repo.logDeliveries([{ ...base, ...target(c), channelName: c.name, channelType: c.type, ok: false, status: "failed", error: ROUTING_UNAVAILABLE, statusMessage: `failed: ${ROUTING_UNAVAILABLE} (could not be queued for retry)` }]).catch(() => {});
          return;
        }
        await deliver(c, ev, alertText(ev), lang, repo, pushed).catch(() => console.error("alert delivery failed"));
        return;
      }
      const claimed = await repo.claimDelivery(row.id);
      if (claimed) await execute(repo, claimed, c, ev, lang, entitlements, pushed, entitlements.allowAlertChannel ? claimed.createdAt ?? new Date() : undefined);
    }),
  );
  for (const result of outcomes) {
    if (result.status === "rejected") console.error("alert channel interrupted; awaiting delivery recovery");
  }
}

/** Fan an event out to every enabled channel in the org. Failures are logged, never thrown. */
export async function dispatchAlert(repo: Repo, orgId: string, ev: Event, channelIds: string[] = [], entitlements: Entitlements = unmetered) {
  // Channel lookup/queue outages must not suppress independent status-page subscribers.
  // Do not attempt unsafely to resend a channel when its queue commit was ambiguous.
  try {
    const channels = await repo.channelsToAlert(orgId, { channelIds, projectId: ev.monitor.projectId, withDisabled: true });
    await fanOut(repo, orgId, ev, channels, entitlements);
  } catch {
    console.error("ALERT CHANNEL FANOUT FAILED: unable to confirm channel queue; subscriber notifications continuing");
  }
  const base = { organizationId: orgId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name };
  const subs = await notifySubscribers(repo, orgId, ev, entitlements).catch(async () => {
    const error = "subscriber notification unavailable";
    console.error(error);
    await repo.logDeliveries([{ ...base, channelId: null, channelName: "Status page subscribers", channelType: "email", ok: false, status: "failed", error, statusMessage: `failed: ${error}` }]).catch(() => console.error("subscriber delivery log failed"));
    return null;
  });
  if (subs && subs.total > 0) {
    const error = subs.failed ? `${subs.failed}/${subs.total} failed: ${subs.error}` : subs.skipped ? `${subs.denied ? "skipped: subscriber access policy or email allowance" : SKIPPED} (${subs.skipped}/${subs.total} not sent)` : null;
    // A persisted-summary failure cannot undo accepted subscriber messages.
    await repo.logDeliveries([{ ...base, channelId: null, channelName: "Status page subscribers", channelType: "email", ok: !error, error, status: !error ? "sent" : subs.failed ? "failed" : "skipped", statusMessage: error && (subs.failed ? `failed: ${error}` : error) }]).catch(() => console.error("subscriber delivery summary unavailable"));
  }
}

const suppressed = (organizationId: string, ev: Event, why: string): NewDelivery => ({
  organizationId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name,
  channelId: null, channelName: "Alerts", channelType: "none", ok: false, status: "skipped", error: why, statusMessage: why,
});

/**
 * Repeat the down alert for incidents nobody has acknowledged. The repo hands each due repeat to exactly one caller and
 * counts it, so a repeat is sent once however many workers run; intervals that were missed collapse into this one.
 */
export async function sendReminders(repo: Repo, entitlements: Entitlements = unmetered, limit = 10) {
  // Monitors under maintenance are not claimed: a suppressed repeat must not use up the incident's repeats, and it goes out
  // after the window if the incident is still unacknowledged.
  const due = await repo.claimReminders(limit, (monitor) => repo.underMaintenance(monitor));
  for (const { incident, monitor, project, number } of due) {
    const ev = eventOf("incident.reminder", incident, monitor, number);
    const all = await repo.channelsToAlert(incident.organizationId, { channelIds: monitor.channelIds, projectId: monitor.projectId, withDisabled: true });
    // push is what repeats are for; email only when the project opted in
    const channels = all.filter((c) => c.type === "push" || (project.reminderEmail && c.type === "email"));
    if (!channels.length) {
      await repo.logDeliveries([suppressed(incident.organizationId, ev, "skipped: no push channel to repeat the alert on")]);
      continue;
    }
    await fanOut(repo, incident.organizationId, ev, channels, entitlements);
  }
  return due.length;
}

/** True when the incident was acknowledged or resolved since it was read (a repo without the lookup never stops). */
async function followUpStopped(repo: Repo, incidentId: string): Promise<boolean> {
  if (!repo.incidentFollowUpState) return false;
  const state = await repo.incidentFollowUpState(incidentId).catch(() => null);
  return !!state && (!!state.acknowledgedAt || !!state.resolvedAt);
}

/** A stand-in channel for a person (see personalChannel); real channels have uuid ids, so the prefix cannot be forged. */
const isPersonal = (c: Pick<AlertChannel, "id">) => c.id.startsWith("personal:");
const personalUserId = (c: AlertChannel) => String((c.config as { userId?: unknown }).userId ?? "");

/** Who one escalation step reaches in person, and why; `notes` explains whoever could not be reached. */
export type StepPeople = { people: { member: WorkspaceMember; why: string[] }[]; notes: string[] };

/**
 * The people an escalation step notifies at `at`: the members it names, plus whoever is on call on its schedules (computed
 * by the on-call engine, overrides included, people who left the workspace skipped). Nothing is sent here.
 */
export async function stepPeople(repo: Repo, orgId: string, step: EscalationDue["step"], at: Date): Promise<StepPeople> {
  const userIds = step.userIds ?? [];
  const scheduleIds = step.scheduleIds ?? [];
  if (!userIds.length && !scheduleIds.length) return { people: [], notes: [] };
  const members = await repo.listMembers(orgId);
  const byId = new Map(members.map((m) => [m.userId, m]));
  const why = new Map<string, string[]>();
  const add = (userId: string, reason: string) => why.set(userId, [...(why.get(userId) ?? []), reason]);
  const notes: string[] = [];
  for (const id of userIds) {
    if (byId.has(id)) add(id, "named in the step");
    else notes.push("a person named in the step is no longer a member of the workspace");
  }
  if (scheduleIds.length) {
    const schedules = await repo.oncallSchedulesByIds(orgId, scheduleIds);
    if (schedules.length < new Set(scheduleIds).size) notes.push("a schedule named in the step no longer exists");
    // only the instant of paging is evaluated: the overrides covering it, and one millisecond of each rotation
    const overrides = await repo.listOncallOverrides(orgId, schedules.map((s) => s.id), at, new Date(at.getTime() + 1));
    for (const s of schedules) {
      let onCall: string | null = null;
      try {
        onCall = onCallAt({ timeZone: s.timeZone, layers: s.layers, overrides: overrides.filter((o) => o.scheduleId === s.id), memberIds: byId.keys() }, at);
      } catch {
        console.error("on-call schedule could not be evaluated");
      }
      if (onCall && byId.has(onCall)) add(onCall, `on call for ${s.name}`);
      else notes.push(`${s.name} had nobody on call`);
    }
  }
  return { people: [...why].map(([id, reasons]) => ({ member: byId.get(id)!, why: reasons })), notes };
}

/**
 * Tell the next escalation step about an incident that is still unacknowledged. The repo hands each step to exactly one
 * caller, however many servers run this. Channels, the people the step names and whoever is on call on its schedules are
 * notified through the usual delivery rows (so failures are retried like any alert); the step is written to the incident's
 * timeline (team only) and the audit log.
 */
export async function sendEscalations(repo: Repo, entitlements: Entitlements = unmetered, limit = 10) {
  const due = await repo.claimEscalations(limit);
  for (const { incident, monitor, step, level, policy } of due) {
    const orgId = incident.organizationId;
    const ev = eventOf("incident.escalated", incident, monitor, level);
    if (await repo.underMaintenance(monitor)) {
      await repo.logDeliveries([suppressed(orgId, ev, "suppressed: maintenance")]);
      continue;
    }
    let channels = step.channelIds.length ? await repo.channelsByIds(orgId, step.channelIds) : [];
    // A policy's first step goes out right after the incident opened: a channel that already got (or is getting) the
    // "down" alert for this incident is not paged a second time for the same thing.
    if (policy && policy.stepNumber === 1 && policy.round === 1 && channels.length) {
      const opened = new Set((await repo.incidentDeliveries(orgId, incident.id).catch(() => []))
        .filter((d) => d.kind === "incident.opened" && d.channelId && d.status !== "failed" && d.status !== "skipped")
        .map((d) => d.channelId));
      const twice = channels.filter((c) => opened.has(c.id));
      if (twice.length) {
        await repo.logDeliveries(twice.map((c) => ({ ...suppressed(orgId, ev, "skipped: this channel already got the down alert for this incident"), channelId: c.id, channelName: c.name, channelType: c.type }))).catch(() => {});
        channels = channels.filter((c) => !opened.has(c.id));
      }
    }
    let reached: StepPeople = { people: [], notes: [] };
    try {
      reached = await stepPeople(repo, orgId, step, new Date());
    } catch {
      console.error("escalation people could not be resolved");
      reached = { people: [], notes: ["the on-call schedules could not be read"] };
    }
    // every person gets an email to their account address, and a push to the phones they registered
    const personal: AlertChannel[] = [];
    for (const { member } of reached.people) {
      personal.push(personalChannel(orgId, member, "email"));
      const phones = await repo.listPushDevices(member.userId).catch(() => []);
      if (phones.length) personal.push(personalChannel(orgId, member, "push"));
    }
    // Someone may have acknowledged (or resolved) the incident while this step was being prepared: then nothing is paged.
    if (await followUpStopped(repo, incident.id)) {
      await repo.logDeliveries([suppressed(orgId, ev, "skipped: the incident was acknowledged or resolved before this escalation could be sent")]).catch(() => {});
      continue;
    }
    const where = policy ? ` (policy ${policy.name}, step ${policy.stepNumber}${policy.round > 1 ? `, repeat ${policy.round - 1}` : ""})` : "";
    const who = reached.people.map((p) => `${p.member.name || p.member.email} (${p.why.join(", ")})`);
    const body = [
      `Escalation level ${level}${where}: ${who.length || channels.length ? "notified" : "nobody could be notified"}${who.length ? ` ${who.join("; ")}` : ""}${channels.length ? `${who.length ? "; channels" : " channels"} ${channels.map((c) => c.name).join(", ")}` : ""}.`,
      ...reached.notes.map((n) => `${n[0].toUpperCase()}${n.slice(1)}.`),
    ].join(" ");
    await repo.recordEscalationNotice?.({
      organizationId: orgId, projectId: incident.projectId ?? monitor.projectId ?? null, incidentId: incident.id, level, body,
      userIds: reached.people.map((p) => p.member.userId), channelCount: channels.length, policyId: policy?.id ?? null, scheduleIds: step.scheduleIds ?? [],
    }).catch(() => console.error("escalation notice could not be recorded"));
    if (!channels.length && !personal.length) {
      await repo.logDeliveries([suppressed(orgId, ev, `skipped: escalation level ${level} has no channel or person left`)]);
      continue;
    }
    await fanOut(repo, orgId, ev, [...channels, ...personal], entitlements);
  }
  return due.length;
}

/** Housekeeping for deliveries: free rows a dead worker left in `sending`, then the retries that are due. */
export async function sweepDeliveries(repo: Repo) {
  return repo.sweepStuckDeliveries({ stuckSec: STUCK_SEC, maxAttempts: MAX_ATTEMPTS });
}

/** Send one alert to one channel; throws when the provider rejects it. */
export async function deliver(c: { id?: string; type: string; name?: string; config: unknown; organizationId?: string }, ev: Event, text: string, lang: Lang = "en", repo?: Repo, pushed?: PushedDevices) {
  const L = (k: string, v?: Record<string, string>) => tr(lang, k, v);
  // a repeat or an escalation reads like the down alert
  const opened = ev.kind !== "incident.resolved";
  const cfg = c.config as Record<string, string | undefined>;
  const need = (v: unknown, what: string) => { if (!v) throw new Skipped(`skipped: the channel has no ${what}`); };
  // a person notified directly by an escalation step (never a configured channel: those have uuid ids)
  const personal = !!c.id && isPersonal({ id: c.id }) && (c.config as { personal?: unknown }).personal === true;
  switch (c.type) {
    case "slack":
      need(cfg.url, "webhook URL");
      await post(cfg.url!, { text });
      break;
    case "discord": {
      need(cfg.url, "webhook URL");
      const endpoint = new URL(cfg.url!);
      // Wait for Discord to confirm creation, instead of accepting a fire-and-forget response.
      endpoint.searchParams.set("wait", "true");
      // Discord counts a message's length in UTF-16 code units (JS string length), which is also what slice() cuts at;
      // dropping a trailing lone high surrogate keeps the cut from splitting an emoji into invalid text.
      const content = text.length <= 2000 ? text : `${text.slice(0, 1999).replace(/[\uD800-\uDBFF]$/, "")}…`;
      await post(endpoint.href, { content, allowed_mentions: { parse: [] } });
      break;
    }
    case "teams": {
      need(cfg.url, "webhook URL");
      // Workflow webhooks accept the Adaptive Card message envelope. TextBlock text is rendered as Markdown, so
      // monitor names and URLs are escaped and cannot format the message or inject links.
      try {
        await post(cfg.url!, { type: "message", attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
          content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2",
            body: [{ type: "TextBlock", text: teamsText(text), wrap: true }], msteams: { width: "Full" } },
        }] });
      } catch (e) {
        // The Workflow trigger must allow "Anyone"; a tenant/user-authenticated trigger answers 401 or 403 to us.
        if (/HTTP (401|403)\b/.test((e as Error).message)) throw new Error(`${(e as Error).message} (the Teams Workflow must be triggerable by “Anyone”; authenticated triggers are not supported)`);
        throw e;
      }
      break;
    }
    case "ntfy": {
      need(cfg.url && cfg.topic, "server URL or topic");
      // Keep the UTF-8 message under ntfy's default 4096-byte limit, without creating an attachment.
      let content = "";
      let bytes = 0;
      for (const character of text) {
        const size = new TextEncoder().encode(character).length;
        if (bytes + size > 4000) { content += "…"; break; }
        content += character; bytes += size;
      }
      let res: Response;
      try {
        const init = json({ topic: cfg.topic, message: content, title: "Montral", priority: Number(cfg.priority || "3") });
        res = (await guardedFetch(cfg.url!, { ...init, headers: { ...init.headers, ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) } }, { follow: false })).res;
      } catch (e) {
        throw new Error((e as Error).name === "TimeoutError" ? `${hostOf(cfg.url!)} timed out` : `Could not reach ${hostOf(cfg.url!)}`);
      }
      // Best-effort cleanup: a hostile or broken stream must not stall ntfy delivery.
      void res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`${hostOf(cfg.url!)} responded HTTP ${res.status}`);
      break;
    }
    case "googlechat":
      need(cfg.url, "webhook URL");
      await postAcked(cfg.url!, { text: googleChatText(text) });
      break;
    case "mattermost":
      need(cfg.url, "webhook URL");
      // `username` only applies where the server lets integrations override it; elsewhere Mattermost ignores it
      await postAcked(cfg.url!, { text: mattermostText(text), username: "Montral" });
      break;
    case "gotify": {
      need(cfg.url && cfg.token, "server URL or application token");
      const r = gotifyRequest(cfg.url!, cfg.token!, ev, text);
      await postAcked(r.url, r.body, r.headers);
      break;
    }
    case "pushover":
      need(cfg.token && cfg.userKey, "application token or user key");
      await postPushover(pushoverBody(cfg, ev, text));
      break;
    case "lark":
      need(cfg.url, "webhook URL");
      await postLark(cfg.url!, text, cfg.secret || undefined);
      break;
    case "webhook":
      need(cfg.url, "webhook URL");
      await post(cfg.url!, { kind: ev.kind, ...(ev.count ? { count: ev.count } : {}), incident: ev.incident, monitor: { name: ev.monitor.name, target: ev.monitor.target }, ...(ev.project ? { project: ev.project } : {}), ...(ev.slow ? { slow: true } : {}), ...(ev.reopened ? { reopened: true } : {}) });
      break;
    case "telegram":
      need(cfg.botToken && cfg.chatId, "bot token or chat id");
      await postTelegram(cfg.botToken!, cfg.chatId!, text);
      break;
    case "pagerduty":
      need(cfg.routingKey, "routing key");
      await post("https://events.pagerduty.com/v2/enqueue", {
          routing_key: cfg.routingKey,
          event_action: opened ? "trigger" : "resolve",
          dedup_key: ev.incident.id,
          payload: { summary: text, source: ev.monitor.target || ev.monitor.name, severity: "critical" },
        });
      break;
    case "push": {
      // devices belong to people: every member of the workspace who registered one is reached, each in their own language
      if (!repo || !c.organizationId) throw new Error("Push channel has no workspace to look devices up in");
      const devices = personal ? await repo.listPushDevices(String(cfg.userId ?? "")) : await repo.pushDevicesForOrganization(c.organizationId);
      if (!devices.length) throw new Skipped(personal ? "skipped: this person has no phone registered for push alerts" : "skipped: no phone has registered for push alerts");
      // devices another push channel is already handling are claimed by it; they are taken over only if that push fails
      const mine = pushed ? devices.filter((d) => !pushed.has(d.id)) : devices;
      const theirs = pushed ? devices.filter((d) => pushed.has(d.id)).map((d) => ({ d, done: pushed.get(d.id)! })) : [];
      let settle: (ok: boolean) => void = () => {};
      const mineDone = new Promise<boolean>((r) => { settle = r; });
      mine.forEach((d) => pushed?.set(d.id, mineDone));
      try {
        if (mine.length) await sendPush(repo, mine, ev, c.organizationId);
        settle(true);
      } catch (e) {
        mine.forEach((d) => pushed?.delete(d.id));
        settle(false);
        throw e;
      }
      const retake = [];
      for (const { d, done } of theirs) if (!(await done)) retake.push(d);
      if (!mine.length && !retake.length) throw new Skipped("skipped: every phone was already notified through another push channel");
      if (retake.length) await sendPush(repo, retake, ev, c.organizationId);
      break;
    }
    case "email":
      need(cfg.to, "email address");
      if (cfg.to) {
        if (ev.test) {
          const t = actionEmail({
            title: L("Your channel is connected"),
            body: L("This is a test alert from Montral. When a monitor goes down or recovers, you'll get a message like this one at this address."),
            badge: { label: L("Test"), tone: "neutral" },
            cta: L("Open alerting"),
            url: `${appUrl()}/app/alerting`,
            lang,
          });
          await sendEmail({ to: cfg.to, subject: L("Test alert from Montral"), fromName: "Montral Alerts", ...t }, true);
          break;
        }
        const started = ev.incident.startedAt;
        const rows: [string, string][] = [[L("Monitor"), ev.monitor.name]];
        if (ev.project && ev.multiProject) rows.push([L("Project"), ev.project.name]);
        if (ev.monitor.target) rows.push([L("Target"), ev.monitor.target]);
        if (started) rows.push([L("Started"), utc(started)]);
        if (opened && ev.reason) rows.push([L("Error"), ev.reason]);
        if (!opened && started && ev.incident.resolvedAt) {
          rows.push([L(ev.monitor.type === "domain" ? "Time needing attention" : "Downtime"), duration(ev.incident.resolvedAt.getTime() - started.getTime(), lang)]);
          rows.push([L("Resolved"), utc(ev.incident.resolvedAt)]);
        }
        const still = ev.kind === "incident.reminder" || ev.kind === "incident.escalated";
        const heading = ev.monitor.type === "domain" ? domainHeading(ev, opened) : still ? (ev.slow ? "{name} is still responding slowly" : "{name} is still down") : opened ? (ev.slow ? "{name} is responding slowly" : "{name} is down") : "{name} has recovered";
        const intro = ev.kind === "incident.reminder"
          ? L("Nobody has acknowledged this incident yet. This is reminder {n} of {max}.", { n: String(ev.count ?? 1), max: String(MAX_REMINDERS) })
          : ev.kind === "incident.escalated"
            ? L(personal ? "Nobody acknowledged this incident in time, so it was escalated to you." : "Nobody acknowledged this incident in time, so it was escalated to this channel.")
            : L(opened ? (ev.slow ? "The monitor responded slower than its threshold on several checks in a row, so an incident was opened." : "The monitor failed its consecutive checks, so an incident was opened.") : "Checks are passing again and the incident is resolved.");
        const mail = actionEmail({
          title: L(heading, { name: ev.monitor.name }),
          body: intro,
          badge: ev.monitor.type === "domain" ? { label: L(opened ? "Domain attention" : "Verified"), tone: opened ? "warn" : "up" } : opened ? (ev.slow ? { label: L("Slow"), tone: "warn" } : { label: L("Down"), tone: "down" }) : { label: L("Recovered"), tone: "up" },
          rows,
          cta: L("View incident"),
          url: `${appUrl()}/app/incidents/${ev.incident.id}`,
          footer: personal ? L("You get this because an escalation step of your workspace notifies you directly, for example while you are on call.") : L("You get this because {name} is an alert channel in your workspace.", { name: c.name ?? L("this email") }),
          footerUrl: { text: L("Manage alerting"), url: `${appUrl()}/app/alerting` },
          lang,
        });
        await sendEmail({ to: cfg.to, subject: `${tag(ev)}${opened ? (ev.slow ? "🟡" : "🔴") : "✅"} ${L(heading, { name: ev.monitor.name })} · Montral`, fromName: "Montral Alerts", ...mail }, true);
      }
      break;
  }
}

/** A branding entitlement is cosmetic, not a reason to silence incident/maintenance mail.
 * Fail closed on white-label permission when the plan backend is unavailable. */
const mayHideBranding = async (entitlements: Entitlements, orgId: string) => {
  try { return (await entitlements.plan(orgId))?.hideBranding !== false; }
  catch {
    // Plan errors can contain customer billing or provider credentials.
    console.error("subscriber branding entitlement unavailable; using Montral branding");
    return false;
  }
};

async function mailSubscribers(
  subs: SubscriberTarget[],
  allowHide: boolean,
  o: { subject: (pageTitle: string, lang: Lang) => string; title: (lang: Lang) => string; body: (lang: Lang) => string; badge: (lang: Lang) => { label: string; tone: "down" | "up" | "warn" | "neutral" } },
) {
  const results = await Promise.allSettled(
    // An unexpected malformed recipient/renderer error must not stop other recipients.
    // Convert preparation errors to rejected per-recipient promises before allSettled.
    subs.map(async (s) => {
      const lang: Lang = isLang(s.locale) ? s.locale : "en";
      const white = allowHide && s.hideBranding;
      const mail = actionEmail({
        title: o.title(lang),
        body: `${s.title}\n\n${o.body(lang)}`,
        badge: o.badge(lang),
        cta: tr(lang, "View status page"),
        url: `${appUrl()}/status/${s.slug}`,
        footer: tr(lang, "You receive this because you subscribed to updates from {title}.", { title: s.title }),
        footerUrl: { text: tr(lang, "Unsubscribe"), url: `${appUrl()}/api/public/status/_/unsubscribe?token=${s.token}` },
        lang,
        brand: white ? s.title : undefined,
      });
      // one-click unsubscribe (RFC 8058): mail clients show their own button and POST to this address
      const unsubscribe = `${appUrl()}/api/public/status/_/unsubscribe?token=${s.token}`;
      return sendEmail({ to: s.email, subject: o.subject(s.title, lang), fromName: white ? s.title : `${s.title} via Montral`, headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, ...mail }, true);
    }),
  );
  if (results.some((r) => r.status === "rejected")) console.error("subscriber email delivery failed");
  const bad = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  return { total: subs.length, failed: results.filter((r) => r.status === "rejected").length, error: bad ? safeDeliveryReason(bad.reason) : "" };
}

async function notifySubscribers(repo: Repo, orgId: string, ev: Event, entitlements: Entitlements) {
  if (!ev.monitor.id) return null;
  const all = await repo.subscribersFor(orgId, ev.monitor.id);
  let allowance: Awaited<ReturnType<typeof subscriberAllowance>>;
  try { allowance = await subscriberAllowance(entitlements, orgId, all); }
  catch {
    console.error("subscriber policy unavailable");
    return { total: all.length, failed: all.length, error: "subscriber policy unavailable", skipped: 0, denied: 0 };
  }
  const { send: subs, skipped, denied } = allowance;
  const opened = ev.kind === "incident.opened";
  const head = (lang: Lang) => `${opened ? (ev.slow ? "🟡" : "🔴") : "✅"} ${tr(lang, ev.monitor.type === "domain" ? domainHeading(ev, opened) : opened ? (ev.slow ? "{name} is responding slowly" : "{name} is down") : "{name} has recovered", { name: ev.monitor.name })}`;
  const sent = await mailSubscribers(subs, await mayHideBranding(entitlements, orgId), {
    subject: (p, lang) => `[${p}] ${head(lang)}`,
    title: head,
    body: () => ev.monitor.type === "domain" ? ev.reason ?? ev.monitor.domainExpiry?.error ?? ev.monitor.name : ev.monitor.name,
    badge: (lang) => ev.monitor.type === "domain" ? { label: tr(lang, opened ? "Domain attention" : "Verified"), tone: opened ? "warn" : "up" } : (opened ? (ev.slow ? { label: tr(lang, "Slow"), tone: "warn" } : { label: tr(lang, "Down"), tone: "down" }) : { label: tr(lang, "Recovered"), tone: "up" }),
  });
  return { ...sent, total: all.length, skipped, denied };
}

/** A manual incident update (investigating → identified → … → resolved) goes to the same subscribers. */
export async function notifyIncidentUpdate(
  repo: Repo,
  inc: { organizationId: string; monitorId: string | null; projectId?: string | null; title: string },
  update: { status: string; body: string },
  entitlements: Entitlements = unmetered,
) {
  let subs: SubscriberTarget[];
  try {
    ({ send: subs } = await subscriberAllowance(entitlements, inc.organizationId, await repo.subscribersFor(inc.organizationId, inc.monitorId, inc.projectId)));
  } catch {
    // The update is already saved. Fail closed without turning a notification outage into a retry of the update.
    console.error("incident update subscriber policy unavailable");
    return;
  }
  const label = (lang: Lang) => tr(lang, update.status === "resolved" ? "Resolved" : update.status[0].toUpperCase() + update.status.slice(1));
  await mailSubscribers(subs, await mayHideBranding(entitlements, inc.organizationId), {
    subject: (p, lang) => `[${p}] ${label(lang)}: ${inc.title}`,
    title: (lang) => `${label(lang)}: ${inc.title}`,
    body: () => update.body,
    badge: (lang) => ({ label: label(lang), tone: update.status === "resolved" ? "up" : update.status === "investigating" ? "down" : "warn" }),
  }).catch((e) => console.error("incident update notify failed"));
}

/** How many times a reminder whose every mail failed is handed back before it is given up on. */
const REMINDER_ATTEMPTS = 3;

/**
 * Reminds the confirmed subscribers of a page shortly before one of its maintenance windows starts. Each window is claimed
 * once per page before anything is sent, so overlapping ticks never send twice. The claim stays when the plan's email
 * allowance leaves nobody to mail, and when at least one mail went out. It is given back only when every mail failed, and
 * only for the first few attempts, so a broken mail setup does not retry for ever.
 */
export async function sendMaintenanceReminders(repo: Repo, entitlements: Entitlements = unmetered) {
  for (const r of await repo.claimMaintenanceReminders(20)) {
    let subs: SubscriberTarget[];
    try {
      ({ send: subs } = await subscriberAllowance(entitlements, r.page.organizationId, r.subscribers));
    } catch {
      // A temporary policy outage is not a denial. Send nothing, return this claim within the same bounded
      // retry budget as mail failures, and continue so one page cannot strand the rest of the claimed batch.
      console.error("maintenance subscriber policy unavailable");
      const retry = await repo.withinLimit(`maint-reminder:${r.window.id}:${r.page.id}`, REMINDER_ATTEMPTS, 24 * 3600).catch(() => false);
      if (retry) await repo.releaseMaintenanceReminder(r.window.id, r.page.id).catch((e) => console.error("maintenance reminder release failed"));
      continue;
    }
    // the plan allows no more mail: nothing to send and nothing to retry, so the claim stays
    if (!subs.length) continue;
    const sent = await mailSubscribers(subs, await mayHideBranding(entitlements, r.page.organizationId), {
      subject: (p, lang) => `[${p}] ${tr(lang, "Scheduled maintenance: {name}", { name: r.window.name })}`,
      title: (lang) => tr(lang, "Scheduled maintenance: {name}", { name: r.window.name }),
      body: (lang) => `${tr(lang, "Scheduled maintenance for {title} starts soon. Checks keep running, but alerts are paused while it lasts.", { title: r.page.title })}\n\n${tr(lang, "Starts")}: ${utc(r.window.startsAt)}\n${tr(lang, "Ends")}: ${utc(r.window.endsAt)}`,
      badge: (lang) => ({ label: tr(lang, "Scheduled"), tone: "neutral" }),
    }).catch((e) => { console.error("maintenance reminder failed"); return null; });
    if (sent && sent.failed < sent.total) continue;
    // every mail failed: hand the claim back for another try, up to REMINDER_ATTEMPTS times
    const retry = await repo.withinLimit(`maint-reminder:${r.window.id}:${r.page.id}`, REMINDER_ATTEMPTS, 24 * 3600).catch(() => false);
    if (retry) await repo.releaseMaintenanceReminder(r.window.id, r.page.id).catch((e) => console.error("maintenance reminder release failed"));
  }
}
