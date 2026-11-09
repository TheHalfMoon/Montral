import { describe, expect, it } from "vitest";
import {
  boundedDelay, buildConfiguredResponse, CONFIGURED_RESPONSE_CSP, DelaySlots, HOOK_PRIVACY_HEADERS,
  parseHookResponseConfig, responseHeaderDenied, responseVariant, RESPONSE_LIMITS, type HookResponseConfig,
} from "./montral-hook-response";

const ok = (input: unknown): HookResponseConfig => {
  const r = parseHookResponseConfig(input);
  if (!r.ok) throw new Error("expected valid: " + r.error);
  return r.value;
};
const refused = (input: unknown): string => {
  const r = parseHookResponseConfig(input);
  if (r.ok) throw new Error("expected refusal for " + JSON.stringify(input).slice(0, 200));
  return r.error;
};

describe("webhook response configuration validation", () => {
  it("fills defaults and keeps a valid configuration as given", () => {
    expect(ok({})).toEqual({ status: 200, contentType: "text/plain", body: "", headers: [], delayMs: 0 });
    expect(ok({ status: 201, contentType: "application/json", body: '{"ok":true}', headers: [{ name: "X-Mock-Id", value: "abc 123" }], delayMs: 2500 }))
      .toEqual({ status: 201, contentType: "application/json", body: '{"ok":true}', headers: [{ name: "X-Mock-Id", value: "abc 123" }], delayMs: 2500 });
  });

  it("accepts statuses 200-599 only, never 1xx, 101 or non-integers", () => {
    for (const status of [200, 204, 299, 302, 404, 418, 500, 599]) expect(ok({ status }).status).toBe(status);
    for (const status of [100, 101, 103, 199, 600, 999, 0, -1, 200.5, "200", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refused({ status }), String(status)).toMatch(/status/);
    }
  });

  it("allows a location only with 3xx and only to absolute http(s) URLs without credentials", () => {
    expect(ok({ status: 302, location: "https://example.com/next?a=1" }).location).toBe("https://example.com/next?a=1");
    expect(ok({ status: 307, location: "http://example.com" }).location).toBe("http://example.com/");
    expect(ok({ status: 302 }).location).toBeUndefined();
    expect(refused({ status: 200, location: "https://example.com/" })).toMatch(/3xx/);
    for (const location of [
      "javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "ftp://example.com/",
      "/relative", "//evil.example/", "https://user:pass@example.com/", "https://example.com/\r\nSet-Cookie: a=1",
      "https://example.com/\nx", "https://exa mple.com/", "https://example.com/" + "a".repeat(2048), 42,
    ]) expect(refused({ status: 302, location }), String(location)).toMatch(/location/);
  });

  it("refuses header injection: CR, LF, NUL, other controls, non-ASCII and padded values", () => {
    for (const value of ["a\r\nSet-Cookie: x=1", "a\nb", "a\rb", "a\u0000b", "a\tb", "a\u007fb", "café", " ", " lead", "trail "]) {
      expect(refused({ headers: [{ name: "X-Test", value }] }), JSON.stringify(value)).toMatch(/header values/);
    }
    for (const name of ["", "X Test", "X:Test", "X-Test\r\n", "X\u0000", "(x)", "x/y", "café", "a".repeat(65), "x@y"]) {
      expect(refused({ headers: [{ name, value: "v" }] }), JSON.stringify(name)).toMatch(/header name/);
    }
    expect(refused({ headers: [{ name: "X-Test" }] })).toMatch(/name and value/);
    expect(refused({ headers: [{ name: "X-Test", value: "v", extra: 1 }] })).toMatch(/\{ name, value \}/);
    expect(refused({ headers: { "X-Test": "v" } })).toMatch(/list/);
  });

  it("refuses deny-listed headers in any case, including whole families", () => {
    for (const name of [
      "Set-Cookie", "set-cookie", "SET-COOKIE", "Content-Length", "Transfer-Encoding", "Connection", "Keep-Alive", "Upgrade", "TE", "Trailer",
      "Strict-Transport-Security", "Content-Security-Policy", "Content-Security-Policy-Report-Only", "X-Frame-Options",
      "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "access-control-expose-headers",
      "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "Clear-Site-Data", "Alt-Svc", "Service-Worker-Allowed",
      "Refresh", "Link", "WWW-Authenticate", "Proxy-Authenticate", "Cache-Control", "Pragma", "Expires", "Vary", "ETag",
      "Referrer-Policy", "X-Content-Type-Options", "X-Robots-Tag", "Content-Type", "Location", "Content-Encoding",
      "X-Accel-Redirect", "X-Accel-Buffering", "X-Sendfile", "Sec-WebSocket-Accept", "Proxy-Status", "CF-Cache-Status",
      "X-Montral-Replay", "Permissions-Policy", "Origin-Agent-Cluster", "Content-Disposition", "X-Forwarded-For", "Report-To", "NEL",
    ]) {
      expect(responseHeaderDenied(name), name).toBe(true);
      expect(refused({ headers: [{ name, value: "x" }] }), name).toMatch(/cannot be set/);
    }
    for (const name of ["X-Mock-Id", "Retry-After", "X-Request-Id", "Content-Language", "X-RateLimit-Remaining", "Idempotency-Key", "X-GitHub-Event"]) {
      expect(responseHeaderDenied(name), name).toBe(false);
    }
  });

  it("caps header count, duplicate names and total header size", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    expect(ok({ headers: many(20) }).headers).toHaveLength(20);
    expect(refused({ headers: many(21) })).toMatch(/at most 20/);
    expect(refused({ headers: [{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }] })).toMatch(/duplicate/);
    expect(refused({ headers: [{ name: "X-A", value: "v".repeat(1025) }] })).toMatch(/header values/);
    const big = Array.from({ length: 9 }, (_, i) => ({ name: `X-Big${i}`, value: "v".repeat(1000) }));
    expect(refused({ headers: big })).toMatch(/8 KiB/);
  });

  it("allows only text content types and refuses HTML, SVG and script-capable types", () => {
    for (const contentType of ["text/plain", "application/json", "application/xml", "text/xml", "text/csv"]) expect(ok({ contentType }).contentType).toBe(contentType);
    for (const contentType of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/javascript", "application/javascript", "application/pdf",
      "text/plain; charset=utf-8", "TEXT/PLAIN", "multipart/x-mixed-replace", "", 7]) {
      expect(refused({ contentType }), String(contentType)).toMatch(/contentType/);
    }
  });

  it("bounds the body at 64 KiB of UTF-8 across all variants, and refuses NUL and lone surrogates", () => {
    expect(ok({ body: "a".repeat(RESPONSE_LIMITS.maxBodyBytes) }).body).toHaveLength(65536);
    expect(refused({ body: "a".repeat(RESPONSE_LIMITS.maxBodyBytes + 1) })).toMatch(/64 KiB/);
    // Bytes, not characters: 21,846 three-byte characters are 65,538 bytes.
    expect(refused({ body: "€".repeat(21_846) })).toMatch(/64 KiB/);
    expect(refused({ body: "a\u0000b" })).toMatch(/NUL/);
    expect(refused({ body: "\ud800" })).toMatch(/UTF-8/);
    expect(ok({ body: "emoji 🛠" }).body).toBe("emoji 🛠");
    expect(refused({ body: 42 })).toMatch(/text/);
    const half = "a".repeat(40 * 1024);
    expect(refused({ body: half, methods: { PUT: { body: half } } })).toMatch(/together/);
    for (const status of [204, 205, 304]) {
      expect(ok({ status }).body).toBe("");
      expect(refused({ status, body: "x" }), String(status)).toMatch(/cannot have a body/);
    }
  });

  it("bounds the delay to whole milliseconds from 0 to 10 seconds", () => {
    expect(ok({ delayMs: 0 }).delayMs).toBe(0);
    expect(ok({ delayMs: 10_000 }).delayMs).toBe(10_000);
    for (const delayMs of [-1, 10_001, 1.5, "100", 1e9, Number.NaN]) expect(refused({ delayMs }), String(delayMs)).toMatch(/delayMs/);
    expect(refused({ methods: { PUT: { delayMs: 10 } } })).toMatch(/unknown field/);
  });

  it("supports per-method overrides for POST, PUT and PATCH only", () => {
    const config = ok({ status: 200, body: "default", methods: { PUT: { status: 409, body: "conflict" }, PATCH: null } });
    expect(config.methods).toEqual({ PUT: { status: 409, contentType: "text/plain", body: "conflict", headers: [] } });
    expect(responseVariant(config, "PUT").status).toBe(409);
    expect(responseVariant(config, "POST").body).toBe("default");
    expect(responseVariant(config, "PATCH").body).toBe("default");
    for (const method of ["GET", "DELETE", "post", "__proto__"]) expect(refused({ methods: { [method]: { status: 200 } } }), method).toMatch(/methods/);
    expect(refused({ methods: { PUT: { headers: [{ name: "Set-Cookie", value: "a=1" }] } } })).toMatch(/methods\.PUT.*cannot be set/);
    expect(refused({ methods: [] })).toMatch(/methods/);
  });

  it("refuses unknown fields and non-object input", () => {
    for (const input of [null, "x", 1, [], true]) expect(refused(input)).toMatch(/object/);
    expect(refused({ cors: "*" })).toMatch(/unknown field/);
    expect(refused({ __proto__: { status: 100 }, extra: 1 })).toMatch(/unknown field/);
  });
});

describe("configured response construction", () => {
  it("sends the configured status, body and headers, and the fixed privacy headers last", () => {
    const out = buildConfiguredResponse(ok({ status: 201, contentType: "application/json", body: '{"a":1}', headers: [{ name: "X-Mock", value: "1" }] }));
    expect(out.status).toBe(201);
    expect(out.body).toBe('{"a":1}');
    expect(out.headers).toEqual({
      "x-mock": "1", "content-type": "application/json; charset=utf-8", "content-security-policy": CONFIGURED_RESPONSE_CSP, ...HOOK_PRIVACY_HEADERS,
    });
  });

  it("re-checks stored headers at send time so a tampered row cannot inject or override", () => {
    const out = buildConfiguredResponse({
      status: 200, contentType: "text/html" as never, body: "<script>alert(1)</script>",
      headers: [
        { name: "Cache-Control", value: "public, max-age=99999" }, { name: "Set-Cookie", value: "a=1" },
        { name: "X-Bad", value: "a\r\nSet-Cookie: b=2" }, { name: "Bad Name", value: "x" }, { name: "X-Ok", value: "fine" },
      ],
    });
    expect(out.headers["cache-control"]).toBe("private, no-store");
    expect(out.headers["set-cookie"]).toBeUndefined();
    expect(out.headers["x-bad"]).toBeUndefined();
    expect(out.headers["x-ok"]).toBe("fine");
    // An unknown content type falls back to text/plain; with nosniff a browser never renders it as HTML.
    expect(out.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
    expect(new Headers(out.headers).get("content-security-policy")).toContain("sandbox");
  });

  it("omits body and content type for 204, 205 and 304, and sends location only for 3xx", () => {
    for (const status of [204, 205, 304]) {
      const out = buildConfiguredResponse({ status, contentType: "text/plain", body: "", headers: [] });
      expect(out.body).toBeNull();
      expect(out.headers["content-type"]).toBeUndefined();
    }
    expect(buildConfiguredResponse(ok({ status: 302, location: "https://example.com/" })).headers.location).toBe("https://example.com/");
    expect(buildConfiguredResponse({ status: 200, contentType: "text/plain", body: "", headers: [], location: "https://example.com/" }).headers.location).toBeUndefined();
    expect(buildConfiguredResponse({ status: 302, contentType: "text/plain", body: "", headers: [], location: "javascript:alert(1)" }).headers.location).toBeUndefined();
  });
});

describe("delayed response bounds", () => {
  it("limits concurrent delayed responses per inbox and per process, and releases once", () => {
    const slots = new DelaySlots(2, 3);
    const a1 = slots.acquire("a"); const a2 = slots.acquire("a");
    expect(a1 && a2).toBeTruthy();
    expect(slots.acquire("a")).toBeNull();
    const b1 = slots.acquire("b");
    expect(b1).toBeTruthy();
    expect(slots.acquire("c")).toBeNull(); // process-wide cap
    a1!(); a1!(); // double release is harmless
    expect(slots.active("a")).toBe(1);
    expect(slots.active()).toBe(2);
    expect(slots.acquire("c")).toBeTruthy();
    a2!(); b1!();
    expect(slots.active("a")).toBe(0);
  });

  it("waits at most 10 seconds and stops early when the sender goes away", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = boundedDelay(5_000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    expect(await waiting).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await boundedDelay(20)).toBe("elapsed");
    expect(await boundedDelay(0)).toBe("elapsed");
    const aborted = new AbortController(); aborted.abort();
    expect(await boundedDelay(10_000, aborted.signal)).toBe("aborted");
  });

  it("clamps an out-of-range delay to the 10-second maximum", async () => {
    let scheduled = 0;
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => { scheduled = ms; return real(fn, 0); }) as typeof setTimeout;
    try { await boundedDelay(10_000_000); } finally { globalThis.setTimeout = real; }
    expect(scheduled).toBe(10_000);
  });
});
