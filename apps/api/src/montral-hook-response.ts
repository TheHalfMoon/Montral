/**
 * Configurable responses for Montral webhook inboxes (mock-endpoint parity).
 *
 * A manager may choose what the public receiver answers to a captured request:
 * a status code, a small text body with a content type from an allow-list,
 * a few custom headers from an allow-list and an optional bounded delay,
 * optionally per method. The receiver runs on the instance's own origin, so
 * the configuration may not weaken it: no cookies, no CORS, no security
 * policies, no cache or framing headers, nothing a proxy or the HTTP layer
 * interprets, and no document a browser would render inline (XML and CSV are
 * served as attachments). The privacy headers every hook response carries are
 * set after the user's headers and cannot be replaced.
 */

export const RESPONSE_METHODS = ["POST", "PUT", "PATCH"] as const;
export type ResponseMethod = (typeof RESPONSE_METHODS)[number];

/**
 * Text types only; HTML, SVG, XHTML and every other type are refused. XML is
 * allowed for mocking XML APIs, but a browser renders an XML document and
 * honours XHTML and SVG namespaces inside it (links, meta refresh, drawing:
 * a spoofed page on the instance's origin even with scripts sandboxed). XML
 * and CSV bodies are therefore always sent as `Content-Disposition:
 * attachment` so a browser downloads them instead of displaying them; API
 * clients ignore the disposition. Only text/plain and application/json are
 * served inline, and with nosniff neither is ever interpreted as markup.
 */
export const RESPONSE_CONTENT_TYPES = ["text/plain", "application/json", "application/xml", "text/xml", "text/csv"] as const;
export type ResponseContentType = (typeof RESPONSE_CONTENT_TYPES)[number];
/** Content types a browser may display inline: never rendered as a document. */
export const INLINE_CONTENT_TYPES: ReadonlySet<string> = new Set(["text/plain", "application/json"]);
const ATTACHMENT_NAMES: Record<string, string> = { "application/xml": "response.xml", "text/xml": "response.xml", "text/csv": "response.csv" };

export const RESPONSE_LIMITS = {
  minStatus: 200,
  maxStatus: 599,
  maxHeaders: 20,
  maxHeaderName: 64,
  maxHeaderValue: 1024,
  /** All custom header names and values of one variant, in bytes. */
  maxHeaderBytes: 8 * 1024,
  /** All response bodies of an inbox together (default plus per-method overrides), UTF-8 bytes. */
  maxBodyBytes: 64 * 1024,
  maxLocation: 2048,
  maxDelayMs: 10_000,
  /** Raw PUT body; generous enough for a 64 KiB body that JSON escaping inflated. */
  maxRequestBytes: 512 * 1024,
} as const;

/** Statuses that never carry a body (RFC 9110 §15.3.5, §15.3.6, §15.4.5). */
const BODYLESS = new Set([204, 205, 304]);

/** RFC 9110 §5.6.2 token. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Visible ASCII and space only: no CR, LF, NUL, tab or other controls, no obs-text. */
const FIELD_VALUE = /^[\x20-\x7e]*$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Header names a configuration MAY set (compared lower-case): any `x-*` name
 * outside the reserved families below, plus a short list of standard
 * response headers that only describe the answer and steer neither the
 * browser nor anything between the instance and the sender. Everything else
 * is refused; new browser or proxy headers are refused by default.
 */
export const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "retry-after", "content-language", "warning", "deprecation", "sunset", "allow", "accept-patch", "accept-post",
  "request-id", "correlation-id", "idempotency-key", "traceparent", "tracestate",
  "ratelimit", "ratelimit-policy", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset",
]);
export const ALLOWED_RESPONSE_HEADER_PREFIXES = ["x-"] as const;

/**
 * Refused even when the allow-list would match (defence in depth, and the
 * reserved `x-*` names). They either frame the message (a proxy would
 * desynchronise), steer the browser on the instance's origin (cookies, CORS,
 * security policies, HSTS, Alt-Svc, Clear-Site-Data, client hints, origin
 * trials, service workers, refresh/link preloads), are reserved for the hook
 * privacy policy, or are interpreted by a reverse proxy or CDN in front of the
 * instance (X-Accel-Redirect, X-Sendfile, Envoy, Varnish, Fly, LiteSpeed).
 */
export const DENIED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  // browser features and privacy sandbox
  "accept-ch", "accept-ch-lifetime", "critical-ch", "origin-trial", "shared-storage-write", "activate-storage-access",
  "x-varnish", "x-cache", "x-cache-hits", "x-served-by", "x-request-start",
  // message framing and hop-by-hop
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade",
  "content-length", "content-encoding", "content-range", "accept-ranges", "host", "date", "server", "via", "alt-svc", "alt-used",
  // set through dedicated fields
  "content-type", "location",
  // credentials and authentication prompts
  "set-cookie", "set-cookie2", "authorization", "proxy-authorization", "www-authenticate", "proxy-authenticate", "authentication-info",
  // browser security policy on the instance's origin
  "strict-transport-security", "content-security-policy", "content-security-policy-report-only",
  "x-content-security-policy", "x-webkit-csp", "public-key-pins", "public-key-pins-report-only", "expect-ct",
  "x-frame-options", "x-xss-protection", "permissions-policy", "feature-policy", "document-policy", "require-document-policy",
  "origin-agent-cluster", "clear-site-data", "service-worker", "service-worker-allowed", "supports-loading-mode",
  "speculation-rules", "no-vary-search", "report-to", "reporting-endpoints", "nel", "x-dns-prefetch-control",
  "x-permitted-cross-domain-policies", "x-download-options", "timing-allow-origin", "refresh", "link", "content-disposition",
  "observe-browsing-topics", "set-login", "attribution-reporting-register-source", "attribution-reporting-register-trigger",
  // the hook privacy policy and caching
  "cache-control", "pragma", "expires", "age", "vary", "etag", "last-modified", "surrogate-control", "cdn-cache-control",
  "cloudflare-cdn-cache-control", "referrer-policy", "x-content-type-options", "x-robots-tag",
  // reverse-proxy and server directives
  "x-sendfile", "x-lighttpd-send-file", "x-litespeed-location", "x-litespeed-cache-control", "x-litespeed-tag",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "x-powered-by",
]);
/** Whole families: CORS, cross-origin isolation, fetch metadata, proxy, CDN and Montral's own headers. */
export const DENIED_RESPONSE_HEADER_PREFIXES = [
  "access-control-", "cross-origin-", "sec-", "proxy-", "x-accel-", "x-forwarded-", "cf-", "x-montral-", "x-litespeed-", "x-amz-", "x-goog-", "x-ms-",
  "ad-auction-", "attribution-reporting-", "x-envoy-", "fly-", "x-varnish", "x-sendfile", "x-lighttpd-", "x-nginx-", "x-apache-",
  "x-vercel-", "x-nf-", "x-netlify-", "x-cloud-trace-", "x-real-", "x-original-", "x-rewrite-", "x-middleware-", "x-frame-", "x-xss-",
] as const;

/** True unless the name is on the allow-list and not reserved. */
export function responseHeaderDenied(name: string): boolean {
  const n = name.toLowerCase();
  const allowed = ALLOWED_RESPONSE_HEADERS.has(n) || ALLOWED_RESPONSE_HEADER_PREFIXES.some((p) => n.startsWith(p));
  return !allowed || DENIED_RESPONSE_HEADERS.has(n) || DENIED_RESPONSE_HEADER_PREFIXES.some((p) => n.startsWith(p));
}

export type ResponseHeader = { name: string; value: string };
export type ResponseVariant = {
  status: number;
  contentType: ResponseContentType;
  body: string;
  headers: ResponseHeader[];
  /** Only for 3xx statuses: an absolute http(s) URL. */
  location?: string;
};
export type HookResponseConfig = ResponseVariant & {
  delayMs: number;
  methods?: Partial<Record<ResponseMethod, ResponseVariant>>;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;

const VARIANT_KEYS = new Set(["status", "contentType", "body", "headers", "location"]);
const CONFIG_KEYS = new Set([...VARIANT_KEYS, "delayMs", "methods"]);

function parseVariant(input: unknown, where: string): Result<ResponseVariant> {
  if (!isRecord(input)) return fail(`${where} must be an object`);
  for (const key of Object.keys(input)) {
    if (!VARIANT_KEYS.has(key) && !(where === "response" && CONFIG_KEYS.has(key))) return fail(`${where}: unknown field ${JSON.stringify(key.slice(0, 40))}`);
  }
  const status = input.status ?? 200;
  if (typeof status !== "number" || !Number.isInteger(status) || status < RESPONSE_LIMITS.minStatus || status > RESPONSE_LIMITS.maxStatus) {
    return fail(`${where}.status must be a whole number from 200 to 599`);
  }
  const contentType = input.contentType ?? "text/plain";
  if (typeof contentType !== "string" || !(RESPONSE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return fail(`${where}.contentType must be one of ${RESPONSE_CONTENT_TYPES.join(", ")}`);
  }
  const body = input.body ?? "";
  if (typeof body !== "string") return fail(`${where}.body must be text`);
  if (body.includes("\u0000") || LONE_SURROGATE.test(body)) return fail(`${where}.body must be valid UTF-8 text without NUL characters`);
  if (utf8(body) > RESPONSE_LIMITS.maxBodyBytes) return fail(`${where}.body is larger than 64 KiB`);
  if (BODYLESS.has(status) && body !== "") return fail(`${where}: status ${status} cannot have a body`);

  const rawHeaders = input.headers ?? [];
  if (!Array.isArray(rawHeaders)) return fail(`${where}.headers must be a list of { name, value }`);
  if (rawHeaders.length > RESPONSE_LIMITS.maxHeaders) return fail(`${where}: at most ${RESPONSE_LIMITS.maxHeaders} headers`);
  const headers: ResponseHeader[] = [];
  const seen = new Set<string>();
  let headerBytes = 0;
  for (const [i, h] of rawHeaders.entries()) {
    const at = `${where}.headers[${i}]`;
    if (!isRecord(h) || Object.keys(h).some((k) => k !== "name" && k !== "value")) return fail(`${at} must be { name, value }`);
    const { name, value } = h;
    if (typeof name !== "string" || typeof value !== "string") return fail(`${at}: name and value must be text`);
    if (!name || name.length > RESPONSE_LIMITS.maxHeaderName || !TOKEN.test(name)) return fail(`${at}: invalid header name`);
    if (value.length > RESPONSE_LIMITS.maxHeaderValue || !FIELD_VALUE.test(value) || value !== value.trim()) {
      return fail(`${at}: header values must be printable ASCII without line breaks or surrounding spaces, at most ${RESPONSE_LIMITS.maxHeaderValue} characters`);
    }
    if (responseHeaderDenied(name)) return fail(`${at}: the ${name.toLowerCase()} header cannot be set (allowed: x-* names outside reserved families, and retry-after, content-language, warning, deprecation, sunset, allow, accept-patch, accept-post, request-id, correlation-id, idempotency-key, traceparent, tracestate, ratelimit*)`);
    const lower = name.toLowerCase();
    if (seen.has(lower)) return fail(`${at}: duplicate header ${lower}`);
    seen.add(lower);
    headerBytes += name.length + value.length;
    headers.push({ name, value });
  }
  if (headerBytes > RESPONSE_LIMITS.maxHeaderBytes) return fail(`${where}: headers are larger than 8 KiB`);

  let location: string | undefined;
  if (input.location !== undefined && input.location !== null && input.location !== "") {
    if (status < 300 || status > 399) return fail(`${where}.location is only allowed with a 3xx status`);
    if (typeof input.location !== "string" || input.location.length > RESPONSE_LIMITS.maxLocation || !FIELD_VALUE.test(input.location) || /\s/.test(input.location)) {
      return fail(`${where}.location must be an absolute http(s) URL`);
    }
    const parsed = URL.parse(input.location);
    if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      return fail(`${where}.location must be an absolute http(s) URL without credentials`);
    }
    location = parsed.href;
  }
  return { ok: true, value: { status, contentType: contentType as ResponseContentType, body, headers, ...(location ? { location } : {}) } };
}

/** Validates and normalises a configuration from the API. Unknown fields are refused, defaults filled in. */
export function parseHookResponseConfig(input: unknown): Result<HookResponseConfig> {
  if (!isRecord(input)) return fail("The response configuration must be an object");
  const base = parseVariant(input, "response");
  if (!base.ok) return base;
  const delayMs = input.delayMs ?? 0;
  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > RESPONSE_LIMITS.maxDelayMs) {
    return fail("response.delayMs must be a whole number of milliseconds from 0 to 10000");
  }
  const config: HookResponseConfig = { ...base.value, delayMs };
  if (input.methods !== undefined && input.methods !== null) {
    if (!isRecord(input.methods)) return fail("response.methods must be an object keyed by POST, PUT or PATCH");
    const methods: Partial<Record<ResponseMethod, ResponseVariant>> = {};
    for (const [method, value] of Object.entries(input.methods)) {
      if (!(RESPONSE_METHODS as readonly string[]).includes(method)) return fail(`response.methods: ${JSON.stringify(method.slice(0, 20))} is not POST, PUT or PATCH`);
      if (value === null || value === undefined) continue;
      const variant = parseVariant(value, `response.methods.${method}`);
      if (!variant.ok) return variant;
      methods[method as ResponseMethod] = variant.value;
    }
    if (Object.keys(methods).length) config.methods = methods;
  }
  const total = [config, ...Object.values(config.methods ?? {})].reduce((n, v) => n + utf8(v.body), 0);
  if (total > RESPONSE_LIMITS.maxBodyBytes) return fail("All response bodies together must be at most 64 KiB");
  return { ok: true, value: config };
}

/** The variant that answers `method`: its override, else the default. */
export function responseVariant(config: HookResponseConfig, method: string): ResponseVariant {
  return config.methods?.[method as ResponseMethod] ?? config;
}

/** Headers no configuration can change, sent on every hook response (success and refusal). */
export const HOOK_PRIVACY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
});
/** A configured body is data, never a document: no script, plugin, form or frame even if a browser opened it. */
export const CONFIGURED_RESPONSE_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

/**
 * The HTTP response for a configured variant. User headers go first, the
 * fixed headers are set last so they always win; the deny-list means they
 * never collide in practice, this ordering is the second line of defence.
 */
export function buildConfiguredResponse(variant: ResponseVariant): { status: number; headers: Record<string, string>; body: string | null } {
  const headers: Record<string, string> = {};
  for (const h of variant.headers) {
    // Re-checked at send time: a stored row written by an older or tampered release must still be safe.
    if (!TOKEN.test(h.name) || !FIELD_VALUE.test(h.value) || responseHeaderDenied(h.name)) continue;
    headers[h.name.toLowerCase()] = h.value;
  }
  const bodyless = BODYLESS.has(variant.status);
  if (variant.location && variant.status >= 300 && variant.status <= 399 && FIELD_VALUE.test(variant.location) && /^https?:\/\//i.test(variant.location)) {
    headers.location = variant.location;
  }
  const type = (RESPONSE_CONTENT_TYPES as readonly string[]).includes(variant.contentType) ? variant.contentType : "text/plain";
  if (!bodyless) {
    headers["content-type"] = `${type}; charset=utf-8`;
    // XML (and CSV) would be displayed or rendered by a browser: always a download, never a document.
    if (!INLINE_CONTENT_TYPES.has(type)) headers["content-disposition"] = `attachment; filename="${ATTACHMENT_NAMES[type] ?? "response.txt"}"`;
  }
  headers["content-security-policy"] = CONFIGURED_RESPONSE_CSP;
  for (const [name, value] of Object.entries(HOOK_PRIVACY_HEADERS)) headers[name] = value;
  return { status: variant.status, headers, body: bodyless ? null : variant.body };
}

/**
 * Bound on delayed responses in one server process (one isolate on Workers).
 * A slot is taken only after the request body was read and the event
 * captured, and held while the response waits. When the inbox, its
 * organization or the process has no free slot, the request is NOT refused:
 * the event is already stored and the configured response is sent at once,
 * without the delay. The delay feature can therefore never deny capture, and
 * one organization (at most `perOrg` sleeping requests) cannot starve
 * another's delayed inboxes. Inboxes without a delay never take a slot.
 */
export class DelaySlots {
  private readonly byInbox = new Map<string, number>();
  private readonly byOrg = new Map<string, number>();
  private total = 0;
  constructor(readonly perInbox = 5, readonly perOrg = 20, readonly perProcess = 200) {}
  acquire(inbox: string, org: string): (() => void) | null {
    const i = this.byInbox.get(inbox) ?? 0;
    const o = this.byOrg.get(org) ?? 0;
    if (i >= this.perInbox || o >= this.perOrg || this.total >= this.perProcess) return null;
    this.byInbox.set(inbox, i + 1);
    this.byOrg.set(org, o + 1);
    this.total++;
    let released = false;
    const dec = (m: Map<string, number>, k: string) => { const left = (m.get(k) ?? 1) - 1; if (left <= 0) m.delete(k); else m.set(k, left); };
    return () => {
      if (released) return;
      released = true;
      this.total--;
      dec(this.byInbox, inbox);
      dec(this.byOrg, org);
    };
  }
  active(scope?: { inbox?: string; org?: string }): number {
    if (scope?.inbox !== undefined) return this.byInbox.get(scope.inbox) ?? 0;
    if (scope?.org !== undefined) return this.byOrg.get(scope.org) ?? 0;
    return this.total;
  }
}

/** Waits `ms` (clamped to the 10 s maximum), or less if `signal` aborts. Never rejects. */
export function boundedDelay(ms: number, signal?: AbortSignal): Promise<"elapsed" | "aborted"> {
  const wait = Math.max(0, Math.min(RESPONSE_LIMITS.maxDelayMs, Math.floor(ms) || 0));
  if (signal?.aborted) return Promise.resolve("aborted");
  if (!wait) return Promise.resolve("elapsed");
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve("aborted"); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve("elapsed"); }, wait);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
