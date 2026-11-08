import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { capChars, deliver, googleChatText, gotifyRequest, mattermostText, pushoverBody, safeDeliveryReason } from "./alerts";
import { configureEmail } from "./email";
import { configureNetGuard } from "./netguard";
import { parseConfig } from "./routes/channels";
import { MASK, maskConfig, restoreConfig } from "./secrets";

// stubbed fetch and made-up public names, as in alerts.test.ts / ntfy.test.ts: the pinned connection would bypass the stub
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));

const CHAT_URL = "https://chat.googleapis.com/v1/spaces/AAAAsynthetic/messages?key=synthetic-key&token=synthetic-token";
const MM_URL = "https://mattermost.example.com/hooks/xyzsynthetichook";
const P_TOKEN = "a".repeat(29) + "1";
const P_USER = "u".repeat(29) + "2";
const ev = { kind: "incident.opened" as const, incident: { id: "inc-1", title: "Down" }, monitor: { name: "API", target: "https://example.com" } };
const resolved = { ...ev, kind: "incident.resolved" as const };
const testEv = { kind: "incident.resolved" as const, incident: { id: "x", title: "Test alert" }, monitor: { name: "Montral test", target: "" }, test: true as const };

beforeAll(() => configureEmail({ WEB_ORIGIN: "https://app.example.com" } as never));
afterAll(() => configureEmail({} as never));
afterEach(() => vi.unstubAllGlobals());

const stub = (res: () => Response) => { const fetch = vi.fn(async () => res()); vi.stubGlobal("fetch", fetch); return fetch; };
const sent = (fetch: ReturnType<typeof stub>, i = 0) => {
  const [url, init] = fetch.mock.calls[i] as unknown as [string, RequestInit];
  return { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)), redirect: init.redirect };
};

describe("Google Chat", () => {
  it("posts { text } to the webhook URL as given", async () => {
    const fetch = stub(() => new Response("{}"));
    await deliver({ type: "googlechat", config: { url: CHAT_URL } }, ev, "🔴 API is down — Down");
    const r = sent(fetch);
    expect(r.url).toBe(CHAT_URL);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.body).toEqual({ text: "🔴 API is down — Down" });
  });
  it("neutralizes <…> link and mention syntax and caps at 4000 characters", () => {
    expect(googleChatText("<users/all> <https://evil.example|click>")).toBe("‹users/all› ‹https://evil.example|click›");
    const long = googleChatText("😀".repeat(5000));
    expect(Array.from(long)).toHaveLength(4000);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("�");
  });
  it("does not follow a redirect with the alert body", async () => {
    const fetch = stub(() => new Response(null, { status: 307, headers: { location: "https://other.example/" } }));
    await expect(deliver({ type: "googlechat", config: { url: CHAT_URL } }, ev, "x")).rejects.toThrow("chat.googleapis.com responded HTTP 307");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([400, 429, 500, 503])("rejects HTTP %s naming only the host, never the token", async (status) => {
    stub(() => new Response("synthetic-token", { status }));
    const err = await deliver({ type: "googlechat", config: { url: CHAT_URL } }, ev, "x").catch((e: Error) => e);
    expect((err as Error).message).toBe(`chat.googleapis.com responded HTTP ${status}`);
    expect(safeDeliveryReason(err)).toBe(`notification provider HTTP ${status}`);
  });
  it("skips a channel without a URL", async () => {
    await expect(deliver({ type: "googlechat", config: {} }, ev, "x")).rejects.toThrow("skipped: the channel has no webhook URL");
  });
});

describe("Mattermost", () => {
  it("posts escaped Markdown text with the Montral username", async () => {
    const fetch = stub(() => new Response("ok"));
    await deliver({ type: "mattermost", config: { url: MM_URL } }, ev, "🔴 [api](https://x) *is* down");
    const r = sent(fetch);
    expect(r.url).toBe(MM_URL);
    expect(r.body).toEqual({ text: "🔴 \\[api\\]\\(https://x\\) \\*is\\* down", username: "Montral" });
    expect(r.redirect).toBe("manual");
  });
  it("caps long posts below Mattermost's post limit", () => {
    expect(mattermostText("x".repeat(20000)).length).toBeLessThanOrEqual(4000);
  });
  it("does not follow redirects and maps 5xx to a host-only error", async () => {
    const fetch = stub(() => new Response(null, { status: 302, headers: { location: "https://other.example/" } }));
    await expect(deliver({ type: "mattermost", config: { url: MM_URL } }, ev, "x")).rejects.toThrow("mattermost.example.com responded HTTP 302");
    expect(fetch).toHaveBeenCalledTimes(1);
    stub(() => new Response("xyzsynthetichook", { status: 502 }));
    await expect(deliver({ type: "mattermost", config: { url: MM_URL } }, ev, "x")).rejects.toThrow(/^mattermost\.example\.com responded HTTP 502$/);
  });
});

describe("Gotify", () => {
  const cfg = { url: "https://gotify.example.com/push/", token: "AsyntheticTok3n" };
  it.each([
    ["incident.opened", 8], ["incident.reminder", 8], ["incident.escalated", 8], ["incident.resolved", 4],
  ] as const)("posts %s to <server>/message with the token header and priority %s", async (kind, priority) => {
    const fetch = stub(() => new Response("{}"));
    await deliver({ type: "gotify", config: cfg }, { ...ev, kind }, "API changed");
    const r = sent(fetch);
    expect(r.url).toBe("https://gotify.example.com/push/message");
    expect(r.url).not.toContain(cfg.token);
    expect(r.headers.get("x-gotify-key")).toBe(cfg.token);
    expect(r.body).toEqual({ title: "Montral", message: "API changed", priority, extras: { "client::notification": { click: { url: "https://app.example.com/app/incidents/inc-1" } } } });
  });
  it("sends a channel test at low priority without a link", () => {
    expect(gotifyRequest("https://g.example.com", "t", testEv, "Test").body).toEqual({ title: "Montral", message: "Test", priority: 4 });
  });
  it("never sends the token header across a redirect", async () => {
    const fetch = stub(() => new Response(null, { status: 307, headers: { location: "https://other.example/message" } }));
    await expect(deliver({ type: "gotify", config: cfg }, ev, "x")).rejects.toThrow("gotify.example.com responded HTTP 307");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 429, 500])("rejects HTTP %s without reflecting the response", async (status) => {
    stub(() => new Response(cfg.token, { status }));
    await expect(deliver({ type: "gotify", config: cfg }, ev, "x")).rejects.toThrow(/^gotify\.example\.com responded HTTP \d+$/);
  });
  it("skips a channel without a token", async () => {
    await expect(deliver({ type: "gotify", config: { url: cfg.url } }, ev, "x")).rejects.toThrow("skipped: the channel has no server URL or application token");
  });
});

describe("Pushover", () => {
  const cfg = { token: P_TOKEN, userKey: P_USER, device: "phone" };
  it("posts token, user, device, title, message, priority 1 and the incident link for a down alert", async () => {
    const fetch = stub(() => new Response(JSON.stringify({ status: 1, request: "r1" })));
    await deliver({ type: "pushover", config: cfg }, ev, "🔴 API is down");
    const r = sent(fetch);
    expect(r.url).toBe("https://api.pushover.net/1/messages.json");
    expect(r.body).toEqual({ token: P_TOKEN, user: P_USER, device: "phone", title: "Montral", message: "🔴 API is down", priority: 1, url: "https://app.example.com/app/incidents/inc-1", url_title: "View incident" });
  });
  it("uses priority 0 for recoveries and tests, priority 1 for escalations, and omits an empty device", () => {
    expect(pushoverBody({ token: P_TOKEN, userKey: P_USER }, resolved, "ok")).toMatchObject({ priority: 0 });
    expect(pushoverBody({ token: P_TOKEN, userKey: P_USER }, { ...ev, kind: "incident.escalated" }, "x")).toMatchObject({ priority: 1 });
    const t = pushoverBody({ token: P_TOKEN, userKey: P_USER }, testEv, "x");
    expect(t).toEqual({ token: P_TOKEN, user: P_USER, title: "Montral", message: "x", priority: 0 });
  });
  it("caps the message at Pushover's 1024 characters without splitting an emoji", () => {
    const m = pushoverBody(cfg, ev, "😀".repeat(2000)).message;
    expect(Array.from(m)).toHaveLength(1024);
    expect(m).not.toContain("�");
    expect(capChars("short", 1024)).toBe("short");
  });
  it.each([
    ["HTTP 200 without status 1", 200, "<html>proxy</html>", "Pushover responded HTTP 200 (missing or invalid acknowledgement)"],
    ["HTTP 400 that echoes the key", 400, JSON.stringify({ status: 0, errors: [`user key ${P_USER} is invalid`] }), "Pushover responded HTTP 400"],
    ["HTTP 429", 429, "{}", "Pushover responded HTTP 429"],
    ["HTTP 500", 500, "", "Pushover responded HTTP 500"],
  ])("rejects %s with a fixed message", async (_name, status, body, message) => {
    stub(() => new Response(body, { status }));
    const err = await deliver({ type: "pushover", config: cfg }, ev, "x").catch((e: Error) => e);
    expect((err as Error).message).toBe(message);
    expect((err as Error).message).not.toContain(P_USER);
  });
  it("skips a channel without a user key", async () => {
    await expect(deliver({ type: "pushover", config: { token: P_TOKEN } }, ev, "x")).rejects.toThrow("skipped: the channel has no application token or user key");
  });
});

describe("settings shown to members", () => {
  it.each([
    ["googlechat", { url: CHAT_URL }, { url: `https://chat.googleapis.com/${MASK}` }],
    ["mattermost", { url: MM_URL }, { url: `https://mattermost.example.com/${MASK}` }],
    ["gotify", { url: "https://gotify.example.com/push", token: "AsyntheticTok3n" }, { url: `https://gotify.example.com/${MASK}`, token: MASK }],
    ["pushover", { token: P_TOKEN, userKey: P_USER, device: "phone" }, { token: MASK, userKey: MASK, device: "phone" }],
  ] as const)("masks %s credentials and restores placeholders", (_type, config, masked) => {
    expect(maskConfig(config)).toEqual(masked);
    expect(restoreConfig(masked, config)).toEqual(config);
  });
});

describe("channel settings validation", () => {
  const ok = (type: Parameters<typeof parseConfig>[0], config: unknown) => parseConfig(type, config).success;
  it("Google Chat: only https://chat.googleapis.com space webhooks with key and token", () => {
    expect(ok("googlechat", { url: CHAT_URL })).toBe(true);
    expect(ok("googlechat", { url: CHAT_URL.replace("https:", "http:") })).toBe(false);
    expect(ok("googlechat", { url: CHAT_URL.replace("chat.googleapis.com", "chat.evil.example") })).toBe(false);
    expect(ok("googlechat", { url: CHAT_URL.replace("chat.googleapis.com", "chat.googleapis.com.evil.example") })).toBe(false);
    expect(ok("googlechat", { url: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k" })).toBe(false);
    expect(ok("googlechat", { url: "https://chat.googleapis.com/v1/spaces/AAAA/members?key=k&token=t" })).toBe(false);
    expect(ok("googlechat", {})).toBe(false);
  });
  it("Mattermost: http or https /hooks/<id> URLs", () => {
    expect(ok("mattermost", { url: MM_URL })).toBe(true);
    expect(ok("mattermost", { url: "http://chat.example.com/mm/hooks/abc123" })).toBe(true);
    expect(ok("mattermost", { url: "https://chat.example.com/api/v4/posts" })).toBe(false);
    expect(ok("mattermost", { url: "https://user:pw@chat.example.com/hooks/abc" })).toBe(false);
    expect(ok("mattermost", { url: "ftp://chat.example.com/hooks/abc" })).toBe(false);
  });
  it("Gotify: https server URL without /message or query, and a token", () => {
    expect(parseConfig("gotify", { url: "https://gotify.example.com", token: " AsyntheticTok3n ", extra: 1 })).toMatchObject({ success: true, data: { url: "https://gotify.example.com", token: "AsyntheticTok3n" } });
    expect(ok("gotify", { url: "https://gotify.example.com/sub", token: "t" })).toBe(true);
    expect(ok("gotify", { url: "http://gotify.example.com", token: "t" })).toBe(false);
    expect(ok("gotify", { url: "https://gotify.example.com/message", token: "t" })).toBe(false);
    expect(ok("gotify", { url: "https://gotify.example.com/?token=t", token: "t" })).toBe(false);
    expect(ok("gotify", { url: "https://gotify.example.com" })).toBe(false);
    expect(ok("gotify", { url: "https://gotify.example.com", token: "has space" })).toBe(false);
  });
  it("Pushover: 30-character token and user key, optional comma-separated devices", () => {
    expect(parseConfig("pushover", { token: P_TOKEN, userKey: P_USER, device: "" })).toMatchObject({ success: true, data: { token: P_TOKEN, userKey: P_USER } });
    expect((parseConfig("pushover", { token: P_TOKEN, userKey: P_USER, device: "" }) as { data: { device?: string } }).data.device).toBeUndefined(); // dropped when stored as JSON, like an empty ntfy token
    expect(ok("pushover", { token: P_TOKEN, userKey: P_USER, device: "iphone,desk-top_2" })).toBe(true);
    expect(ok("pushover", { token: P_TOKEN })).toBe(false);
    expect(ok("pushover", { userKey: P_USER })).toBe(false);
    expect(ok("pushover", { token: "short", userKey: P_USER })).toBe(false);
    expect(ok("pushover", { token: P_TOKEN, userKey: P_USER, device: "a b" })).toBe(false);
    expect(ok("pushover", { token: P_TOKEN, userKey: P_USER, device: "x".repeat(26) })).toBe(false);
  });
});

describe("sending to a local server (ALLOW_PRIVATE_TARGETS)", () => {
  const seen: { method: string; url: string; key?: string; type?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method!, url: req.url!, key: req.headers["x-gotify-key"] as string | undefined, type: req.headers["content-type"], body });
    if (req.url === "/fail/hooks/abc") { res.writeHead(503); res.end("down"); }
    else res.end(req.url?.startsWith("/hooks") ? "ok" : "{}");
  });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });

  it("delivers Mattermost and Gotify over a real connection", async () => {
    await deliver({ type: "mattermost", config: { url: `${base}/hooks/abc` } }, ev, "API is down");
    expect(seen.at(-1)).toEqual({ method: "POST", url: "/hooks/abc", key: undefined, type: "application/json", body: JSON.stringify({ text: "API is down", username: "Montral" }) });
    await deliver({ type: "gotify", config: { url: base, token: "AsyntheticTok3n" } }, resolved, "API has recovered");
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/message", key: "AsyntheticTok3n" });
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ title: "Montral", message: "API has recovered", priority: 4 });
  });
  it("fails a 503 as a retryable provider error", async () => {
    const err = await deliver({ type: "mattermost", config: { url: `${base}/fail/hooks/abc` } }, ev, "x").catch((e: Error) => e);
    expect(safeDeliveryReason(err)).toBe("notification provider HTTP 503");
  });
  it("refuses loopback once private targets are off again", async () => {
    configureNetGuard({});
    try {
      await expect(deliver({ type: "mattermost", config: { url: `${base}/hooks/abc` } }, ev, "x")).rejects.toThrow(/private or internal address/);
    } finally {
      configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    }
  });
});
