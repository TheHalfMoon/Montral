import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPush } from "./apns";
import { sendEmail } from "./email";
import { unmetered } from "./entitlements";
import { clearProjectNames, deliver, dispatchAlert, retryDeliveries, sendEscalations, sendReminders, withProject } from "./alerts";

// these tests stub the global fetch and use made-up host names; the pinned connection would bypass the stub and go to the real network
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./email", async (orig) => ({ ...(await orig<typeof import("./email")>()), sendEmail: vi.fn(async () => {}) }));
vi.mock("./apns", () => ({ sendPush: vi.fn(async () => {}) }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));

const ev = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { name: "API", target: "https://x" } };

afterEach(() => vi.unstubAllGlobals());

describe("telegram channel", () => {
  const channel = { type: "telegram", config: { botToken: "synthetic-bot-token", chatId: "42" } };

  it("accepts a valid Telegram Bot API acknowledgement", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(deliver(channel, ev, "Synthetic alert")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ chat_id: "42", text: "Synthetic alert" });
  });

  it.each([
    ["empty body", "", 200],
    ["invalid JSON", "<html>upstream error</html>", 200],
    ["null", "null", 200],
    ["array", "[]", 200],
    ["missing ok", "{}", 200],
    ["string ok", '{"ok":"true"}', 200],
    ["false ok", '{"ok":false}', 200],
    ["HTTP failure despite ok true", '{"ok":true}', 502],
  ])("rejects a false-positive Telegram acknowledgement: %s", async (_label, body, status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(String(body), { status: Number(status) }));
    vi.stubGlobal("fetch", fetch);
    await expect(deliver(channel, ev, "Synthetic alert")).rejects.toThrow(/Telegram responded HTTP/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reveal Telegram's untrusted error description or bot token", async () => {
    const secret = "synthetic-private-provider-credential";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: 403, description: `Forbidden for https://example.test/?token=${secret}`,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(deliver(channel, ev, "Synthetic alert")).rejects.toThrow("Telegram responded HTTP 200 (API code 403)");
    try {
      await deliver(channel, ev, "Synthetic alert");
      throw new Error("Expected a failed Telegram acknowledgement");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).not.toContain("synthetic-bot-token");
    }
  });
});

describe("lark channel", () => {
  it("posts a text message, signed when a secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/abc", secret: "s3cret" } }, ev, "🔴 API is down");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("🔴 API is down");
    expect(typeof body.timestamp).toBe("string");
    expect(body.sign).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("sends no signature without a secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliver({ type: "lark", config: { url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" } }, ev, "hi");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sign).toBeUndefined();
  });

  it("fails when the hook refuses the message with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 19021, msg: "sign match fail" }), { status: 200 })));
    await expect(deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/abc" } }, ev, "hi")).rejects.toThrow(/19021/);
  });

  it.each([
    { label: "empty body", body: "", status: 200 },
    { label: "HTML body", body: "<html>ok</html>", status: 200 },
    { label: "missing acknowledgement", body: "{}", status: 200 },
    { label: "null acknowledgement", body: "null", status: 200 },
    { label: "numeric-looking string code", body: '{"code":"0"}', status: 200 },
    { label: "nonzero business code", body: '{"code":9021}', status: 200 },
    { label: "conflicting acknowledgement", body: '{"code":0,"StatusCode":9021}', status: 200 },
    { label: "HTTP failure despite zero code", body: '{"code":0}', status: 503 },
  ])("does not record a false-positive Lark acknowledgement: $label", async ({ body, status }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/synthetic" } }, ev, "test"))
      .rejects.toThrow(/Lark responded HTTP/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits provider-supplied text when Lark rejects a message", async () => {
    const secret = "synthetic-webhook-private-token";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 18001, msg: `refused https://example.test/hook?token=${secret}` }), { status: 200 })));
    await expect(deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/synthetic" } }, ev, "test"))
      .rejects.toThrow("Lark responded HTTP 200 (provider code 18001)");
    try {
      await deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/synthetic" } }, ev, "test");
      throw new Error("expected Lark denial");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});


describe("critical subscriber email quota validation", () => {
  const event = { kind: "incident.opened" as const, incident: { id: "quota-incident", title: "Down" }, monitor: { id: "quota-monitor", name: "Synthetic API", target: "https://example.test" } };
  const subs = ["one", "two"].map((n) => ({
    email: n + "@example.test", slug: "synthetic-status", title: "Synthetic Status", token: "synthetic-" + n + "-token", locale: "en", hideBranding: false,
  }));
  const repo = () => {
    const logged: Record<string, unknown>[] = [];
    return {
      logged,
      instance: {
        channelsToAlert: async () => [], queueDeliveries: async () => [],
        subscribersFor: async () => subs,
        logDeliveries: async (rows: Record<string, unknown>[]) => void logged.push(...rows),
      },
    };
  };

  it.each([NaN, Infinity, -1, 1.5, 3, "2", undefined])("fails closed on malformed quota grant %s without attempting an email", async grant => {
    const { logged, instance } = repo();
    const mail = vi.mocked(sendEmail); mail.mockClear();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dispatchAlert(instance as never, "synthetic-org", event, [], { ...unmetered, spendEmails: async () => grant as never });
      expect(mail).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("email allowance invalid");
      expect(logged).toContainEqual(expect.objectContaining({ status: "skipped", error: expect.stringContaining("2/2 not sent") }));
      expect(JSON.stringify(logged)).not.toMatch(/NaN|Infinity|undefined/);
    } finally { log.mockRestore(); }
  });

  it("honors a valid partial quota grant", async () => {
    const { logged, instance } = repo();
    const mail = vi.mocked(sendEmail); mail.mockReset().mockResolvedValue(undefined);
    await dispatchAlert(instance as never, "synthetic-org", event, [], { ...unmetered, spendEmails: async () => 1 });
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0].to).toBe(subs[0].email);
    expect(logged).toContainEqual(expect.objectContaining({ status: "skipped", error: expect.stringContaining("1/2 not sent") }));
  });

  it("preserves emergency delivery if the usage ledger throws, without logging the exception", async () => {
    const { logged, instance } = repo();
    const mail = vi.mocked(sendEmail); mail.mockReset().mockResolvedValue(undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dispatchAlert(instance as never, "synthetic-org", event, [], {
        ...unmetered, spendEmails: async () => { throw new Error("secret database password must not be logged"); },
      });
      expect(mail).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith("email allowance unavailable");
      expect(JSON.stringify([logged, log.mock.calls])).not.toContain("secret database password");
    } finally { log.mockRestore(); }
  });
});

describe("subscriber delivery diagnostics", () => {
  it("never prints or persists provider errors or subscriber recipients", async () => {
    const secret = "synthetic-subscriber-bearer-token-not-for-logs";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error(`SMTP rejected unsubscribe?token=${secret}`));
    const recorded: Record<string, unknown>[] = [];
    const repo = {
      channelsToAlert: async () => [], queueDeliveries: async () => [],
      subscribersFor: async () => [{ email: "subscriber-private@example.test", token: secret, title: "Synthetic status", slug: "synthetic", locale: "en", hideBranding: false }],
      logDeliveries: async (rows: Record<string, unknown>[]) => void recorded.push(...rows),
    };
    const event = { kind: "incident.opened" as const, incident: { id: "synthetic-incident", title: "Down" }, monitor: { id: "synthetic-monitor", name: "Synthetic monitor", target: "https://example.test" } };
    await dispatchAlert(repo as never, "synthetic-org", event, []);
    expect(recorded).toContainEqual(expect.objectContaining({ status: "failed", error: "1/1 failed: notification delivery failed" }));
    expect(JSON.stringify([recorded, log.mock.calls])).not.toContain(secret);
    expect(JSON.stringify([recorded, log.mock.calls])).not.toContain("subscriber-private@example.test");
    log.mockRestore();
  });
});

describe("retryDeliveries", () => {
  const item = (attempts: number, over: { kind?: string; incident?: Record<string, unknown>; enabled?: boolean } = {}) => ({
    delivery: { id: "d1", kind: over.kind ?? "incident.opened", attempts, organizationId: "o" },
    incident: { id: "i1", title: "API is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 2, escalationLevel: 1, ...over.incident },
    monitor: { id: "m1", projectId: null, name: "API", target: "https://x" },
    channel: { id: "c1", organizationId: "o", type: "webhook", name: "hook", config: { url: "https://hooks.example/x" }, enabled: true },
  });
  const run = async (attempts: number, status: number, over = {}) => {
    const done: Record<string, unknown>[] = [];
    const repo = { claimRetries: async () => [item(attempts, over)], finishDelivery: async (_id: string, r: Record<string, unknown>) => void done.push(r) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status }));
    await retryDeliveries(repo as never);
    fetchSpy.mockRestore();
    return done[0];
  };
  it("processes later retries when a previous stale alert cannot be marked skipped", async () => {
    const secret = "synthetic-db-token-DO-NOT-LOG";
    const first = item(1, { incident: { resolvedAt: new Date() } });
    const second = item(1);
    second.delivery.id = "d2";
    const done: { id: string; status: string }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = {
      claimRetries: async () => [first, second],
      finishDelivery: async (id: string, result: { status: string }) => {
        if (id === first.delivery.id) throw new Error(secret);
        done.push({ id, status: result.status });
      },
    };
    try {
      expect(await retryDeliveries(repo as never)).toBe(2);
      expect(done).toEqual([{ id: "d2", status: "sent" }]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("alert retry item interrupted; awaiting delivery sweep");
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { fetchSpy.mockRestore(); log.mockRestore(); }
  });

  it("does not starve later alerts when a reopened incident history lookup fails", async () => {
    const secret = "synthetic-webhook-access-token-DO-NOT-LOG";
    const first = item(1, { incident: { evaluationNote: "reopened: outage again" } });
    const second = item(1);
    second.delivery.id = "d2";
    second.incident.id = "i2";
    const sent: string[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const repo = {
      claimRetries: async () => [first, second],
      incidentDeliveries: async () => { throw new Error(secret); },
      finishDelivery: async (id: string, result: { status: string }) => void sent.push(`${id}:${result.status}`),
    };
    try {
      expect(await retryDeliveries(repo as never)).toBe(2);
      expect(sent).toEqual(["d2:sent"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("alert retry item interrupted; awaiting delivery sweep");
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { fetchSpy.mockRestore(); log.mockRestore(); }
  });

  it("marks a recovered delivery as sent", async () => expect(await run(1, 200)).toEqual({ status: "sent", error: null, message: null }));
  it("schedules another attempt, then gives up after the third", async () => {
    expect(await run(1, 500)).toMatchObject({ status: "failed", retryInSec: 300 });
    expect(await run(2, 500)).toMatchObject({ status: "failed", retryInSec: null });
  });
  it("explains a failure with the HTTP status", async () => {
    expect(await run(0, 500)).toMatchObject({ retryInSec: 60, message: expect.stringMatching(/^failed: .*HTTP 500.*trying again in 60 s/) });
    expect((await run(2, 503) as { message: string }).message).toMatch(/^failed: .*HTTP 503.*gave up after 3 attempts/);
  });
  it("does not send a retried down alert for an incident that has recovered, or a recovery for one that was reopened", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await run(1, 200, { kind: "incident.opened", incident: { resolvedAt: new Date() } })).toMatchObject({ status: "skipped", message: expect.stringMatching(/^skipped: .*resolved/) });
    expect(await run(1, 200, { kind: "incident.resolved", incident: { resolvedAt: null } })).toMatchObject({ status: "skipped", message: expect.stringMatching(/^skipped: .*reopened/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    // the matching states still go out
    expect(await run(1, 200, { kind: "incident.resolved", incident: { resolvedAt: new Date() } })).toMatchObject({ status: "sent" });
    fetchSpy.mockRestore();
  });
  it("does not repeat a reminder for an incident that was acknowledged meanwhile", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await run(0, 200, { kind: "incident.reminder", incident: { acknowledgedAt: new Date() } });
    expect(r).toMatchObject({ status: "skipped", message: expect.stringMatching(/^skipped: .*acknowledged/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("retry of a reopened incident", () => {
  const base = new Date("2026-10-17T10:00:00Z");
  const at = (min: number) => new Date(base.getTime() + min * 60_000);
  const run = async (self: Date, others: { createdAt: Date; status?: string; channelId?: string }[]) => {
    const done: Record<string, unknown>[] = [];
    const bodies: unknown[] = [];
    const repo = {
      claimRetries: async () => [{
        delivery: { id: "d2", kind: "incident.opened", attempts: 1, organizationId: "o", channelId: "c1", createdAt: self },
        incident: { id: "i1", organizationId: "o", title: "API is down", startedAt: base, resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", evaluationNote: "reopened: failed again", reminderCount: 0, escalationLevel: 0 },
        monitor: { id: "m1", projectId: null, name: "API", target: "https://x" },
        channel: { id: "c1", organizationId: "o", type: "slack", name: "s", config: { url: "https://hooks.example/x" }, enabled: true },
      }],
      incidentDeliveries: async () => others.map((o, i) => ({ id: `d${i}`, kind: "incident.opened", channelId: "c1", status: "sent", ...o })),
      finishDelivery: async (_id: string, r: Record<string, unknown>) => void done.push(r),
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response("", { status: 200 })));
    await retryDeliveries(repo as never);
    return { done: done[0], bodies };
  };
  afterEach(() => vi.restoreAllMocks());

  it("keeps saying \"again\" when the retried alert is the one sent for the reopen", async () => {
    const r = await run(at(20), [{ createdAt: at(0) }]);
    expect(r.done).toMatchObject({ status: "sent" });
    expect((r.bodies[0] as { text: string }).text).toContain("is down again");
  });

  it("drops a late retry of the original alert once a reopen alert has gone out", async () => {
    const r = await run(at(0), [{ createdAt: at(20) }]);
    expect(r.done).toMatchObject({ status: "skipped", message: expect.stringMatching(/reopened/) });
    expect(r.bodies).toEqual([]);
  });

  it("still sends the original when the later alert was skipped or failed, or went to another channel", async () => {
    for (const later of [{ status: "skipped" }, { status: "failed" }, { channelId: "c2" }]) {
      const r = await run(at(0), [{ createdAt: at(20), ...later }]);
      expect(r.done, JSON.stringify(later)).toMatchObject({ status: "sent" });
      vi.restoreAllMocks();
    }
  });
});

describe("push dedupe across channels", () => {
  const push = { type: "push", organizationId: "o", config: {} };
  const devices = [{ id: "dev1" }, { id: "dev2" }];
  const repo = { pushDevicesForOrganization: async () => devices } as never;

  it("lets a second push channel reach the phones when the first one failed", async () => {
    const mocked = vi.mocked(sendPush);
    mocked.mockReset();
    mocked.mockRejectedValueOnce(new Error("APNs down")).mockResolvedValue(undefined);
    const pushed = new Map<string, Promise<boolean>>();
    const a = deliver(push, ev, "t", "en", repo, pushed).catch((e) => e);
    const b = deliver(push, ev, "t", "en", repo, pushed);
    expect(await a).toBeInstanceOf(Error);
    await b;
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[1][1]).toEqual(devices);
  });

  it("still pushes a phone once when the first channel succeeded", async () => {
    const mocked = vi.mocked(sendPush);
    mocked.mockReset();
    mocked.mockResolvedValue(undefined);
    const pushed = new Map<string, Promise<boolean>>();
    await deliver(push, ev, "t", "en", repo, pushed);
    await expect(deliver(push, ev, "t", "en", repo, pushed)).rejects.toThrow(/already notified/);
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe("reminders and escalation", () => {
  const monitor = { id: "m1", organizationId: "o", projectId: "p", name: "API", target: "https://x", channelIds: [] as string[] };
  const incident = { id: "i1", organizationId: "o", title: "API is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 3, escalationLevel: 1 };
  const ch = (id: string, type: string, enabled = true) => ({ id, organizationId: "o", projectId: "p", type, name: id, enabled, config: type === "email" ? { to: "a@example.com" } : {} });

  function fake(over: Record<string, unknown>) {
    const finished: { id: string; status: string; message: string | null }[] = [];
    const logged: Record<string, unknown>[] = [];
    const queued: Record<string, unknown>[] = [];
    const repo = {
      underMaintenance: async () => false,
      queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r, i) => { queued.push(r); return { ...r, id: `${r.channelId}`, attempts: 0 }; }),
      claimDelivery: async (id: string) => ({ id, attempts: 0, kind: "x" }),
      finishDelivery: async (id: string, r: { status: string; message: string | null }) => void finished.push({ id, ...r }),
      logDeliveries: async (rows: Record<string, unknown>[]) => void logged.push(...rows),
      pushDevicesForOrganization: async () => [],
      ownerLocale: async () => "en",
      localeByEmail: async () => null,
      ...over,
    };
    return { repo: repo as never, finished, logged, queued };
  }

  it("repeats on push only unless the project opted in to email, and says why a push had nobody to reach", async () => {
    const due = [{ incident, monitor, project: { reminderIntervalMin: 5, reminderEmail: false, escalation: [] }, number: 4 }];
    const f = fake({ claimReminders: async () => due, channelsToAlert: async () => [ch("push1", "push"), ch("mail1", "email"), ch("hook1", "slack")] });
    await sendReminders(f.repo);
    expect(f.queued.map((r) => [r.channelId, r.kind])).toEqual([["push1", "incident.reminder"]]);
    expect(f.finished).toEqual([expect.objectContaining({ id: "push1", status: "skipped", message: expect.stringMatching(/^skipped: no phone/) })]);
  });

  it("includes email channels when the project opted in", async () => {
    const due = [{ incident, monitor, project: { reminderIntervalMin: 5, reminderEmail: true, escalation: [] }, number: 1 }];
    const f = fake({ claimReminders: async () => due, channelsToAlert: async () => [ch("push1", "push"), ch("mail1", "email")] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    await sendReminders(f.repo).catch(() => {});
    expect(f.queued.map((r) => r.channelId)).toEqual(["push1", "mail1"]);
    vi.restoreAllMocks();
  });

  it("records a suppressed repeat during maintenance instead of sending it", async () => {
    const due = [{ incident, monitor, project: { reminderIntervalMin: 5, reminderEmail: false, escalation: [] }, number: 1 }];
    // the repo is asked about maintenance while claiming, so a suppressed repeat is never counted
    const asked: string[] = [];
    const f = fake({
      claimReminders: async (_limit: number, skip?: (m: typeof monitor) => Promise<boolean>) => ((await skip?.(monitor)) ? [] : due),
      underMaintenance: async (m: { id: string }) => (asked.push(m.id), true),
      channelsToAlert: async () => [ch("push1", "push")],
    });
    expect(await sendReminders(f.repo)).toBe(0);
    expect(asked).toEqual(["m1"]);
    expect(f.queued).toEqual([]);
  });

  it("pushes a phone once per event, however many push channels reach it", async () => {
    const due = [{ incident, monitor, step: { channelIds: ["p1", "p2"], escalateAfterMin: 15 }, level: 1 }];
    const f = fake({
      claimEscalations: async () => due,
      channelsByIds: async () => [ch("p1", "push"), ch("p2", "push")],
      pushDevicesForOrganization: async () => [{ id: "d1", token: "t1", userId: "u", platform: "ios", environment: "production", locale: null }, { id: "d2", token: "t2", userId: "u", platform: "ios", environment: "production", locale: null }],
    });
    vi.mocked(sendPush).mockClear();
    await sendEscalations(f.repo);
    expect(vi.mocked(sendPush).mock.calls.map((c) => c[1].map((d) => d.id))).toEqual([["d1", "d2"]]);
    expect(f.finished.map((x) => x.status).sort()).toEqual(["sent", "skipped"]);
    expect(f.finished.find((x) => x.status === "skipped")!.message).toMatch(/already notified/);
  });

  it("notifies the channels of the due escalation level and records a switched-off one as skipped", async () => {
    const due = [{ incident, monitor, step: { channelIds: ["c1", "c2"], escalateAfterMin: 15 }, level: 2 }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const f = fake({ claimEscalations: async () => due, channelsByIds: async () => [{ ...ch("c1", "webhook"), config: { url: "https://hooks.example/x" } }, ch("c2", "webhook", false)] });
    await sendEscalations(f.repo);
    expect(f.queued.map((r) => [r.channelId, r.kind])).toEqual([["c1", "incident.escalated"]]);
    expect(f.finished).toEqual([expect.objectContaining({ id: "c1", status: "sent" })]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toMatchObject({ kind: "incident.escalated", count: 2 });
    expect(f.logged[0]).toMatchObject({ channelId: "c2", status: "skipped", statusMessage: "skipped: channel disabled" });
    fetchSpy.mockRestore();
  });
});

describe("project name in alerts", () => {
  const projects = (list: { id: string; name: string }[]) => ({ listProjects: vi.fn(async () => list) });
  const two = [{ id: "p1", name: "favicon.im" }, { id: "p2", name: "other" }];
  const mon = { id: "m1", projectId: "p1", name: "WWW homepage", target: "https://x" };
  const opened = { kind: "incident.opened" as const, incident: { id: "i1", title: "WWW homepage is down" }, monitor: mon };
  afterEach(() => { clearProjectNames(); vi.restoreAllMocks(); });

  /** Send `event` through dispatchAlert to one channel of `type` and return what the channel got. */
  async function sent(event: typeof opened & Record<string, unknown>, list: { id: string; name: string }[], type = "slack", extra: Record<string, unknown> = {}) {
    const cfg: Record<string, unknown> = { slack: { url: "https://hooks.example/s" }, lark: { url: "https://open.larksuite.com/h" }, telegram: { botToken: "t", chatId: "1" }, pagerduty: { routingKey: "k" }, webhook: { url: "https://hooks.example/w" } };
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response(JSON.stringify(type === "telegram" ? { ok: true, result: { message_id: 101 } } : { code: 0 }), { status: 200 })));
    const channel = { id: "c1", organizationId: "o", projectId: null, type, name: "c", enabled: true, config: cfg[type] };
    const repo = {
      ...projects(list),
      channelsToAlert: async () => [channel],
      logDeliveries: async () => {},
      queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, id: "d1", attempts: 0 })),
      claimDelivery: async (id: string) => ({ id, attempts: 0, kind: event.kind }),
      finishDelivery: async () => {},
      subscribersFor: async () => [],
      ...extra,
    };
    await dispatchAlert(repo as never, "o", event as never);
    return { bodies, repo };
  }

  it("names the project after the status emoji when the workspace has several projects", async () => {
    expect((await sent(opened, two)).bodies[0]).toEqual({ text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" });
    expect((await sent({ ...opened, slow: true } as never, two)).bodies[0]).toEqual({ text: "🟡 [favicon.im] WWW homepage is responding slowly — WWW homepage is down" });
    expect((await sent({ ...opened, reopened: true } as never, two)).bodies[0]).toEqual({ text: "🔴 [favicon.im] WWW homepage is down again — WWW homepage is down" });
  });

  it("keeps today's text in a workspace with a single project", async () => {
    expect((await sent(opened, [two[0]])).bodies[0]).toEqual({ text: "🔴 WWW homepage is down — WWW homepage is down" });
  });

  it("covers reminder, escalation and recovery", async () => {
    expect((await sent({ ...opened, kind: "incident.reminder", count: 2 } as never, two)).bodies[0]).toEqual({ text: "⏰ [favicon.im] WWW homepage is still down and nobody has acknowledged it — reminder 2" });
    expect((await sent({ ...opened, kind: "incident.escalated" } as never, two)).bodies[0]).toEqual({ text: "🚨 [favicon.im] WWW homepage is still down and nobody has acknowledged it — escalated to you" });
    expect((await sent({ ...opened, kind: "incident.resolved" } as never, two)).bodies[0]).toEqual({ text: "✅ [favicon.im] WWW homepage has recovered" });
  });

  it("uses the same text on lark, telegram and the pagerduty summary", async () => {
    expect((await sent(opened, two, "lark")).bodies[0]).toMatchObject({ msg_type: "text", content: { text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" } });
    expect((await sent(opened, two, "telegram")).bodies[0]).toEqual({ chat_id: "1", text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" });
    expect((await sent(opened, two, "pagerduty")).bodies[0]).toMatchObject({ payload: { summary: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" } });
  });

  it("always puts the project in the webhook payload, whatever the project count", async () => {
    expect((await sent(opened, two, "webhook")).bodies[0]).toMatchObject({ project: { id: "p1", name: "favicon.im" } });
    expect((await sent(opened, [two[0]], "webhook")).bodies[0]).toMatchObject({ project: { id: "p1", name: "favicon.im" } });
  });

  it("sends the alert without a project when the lookup fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bodies } = await sent(opened, [], "slack", { listProjects: async () => { throw new Error("db down"); } });
    expect(bodies[0]).toEqual({ text: "🔴 WWW homepage is down — WWW homepage is down" });
    const w = await sent(opened, [], "webhook", { listProjects: async () => { throw new Error("db down"); } });
    expect(w.bodies[0]).not.toHaveProperty("project");
    expect(err).toHaveBeenCalled();
  });

  it("reads the workspace's projects once for a burst of alerts", async () => {
    const repo = projects(two);
    await withProject(repo as never, "o", opened);
    await withProject(repo as never, "o", opened);
    expect(repo.listProjects).toHaveBeenCalledTimes(1);
  });

  it("does not look anything up for a monitor without a project", async () => {
    const repo = projects(two);
    const e = { ...opened, monitor: { ...mon, projectId: null } };
    expect(await withProject(repo as never, "o", e)).toBe(e);
    expect(repo.listProjects).not.toHaveBeenCalled();
  });

  it("names the project in a retried alert", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response("", { status: 200 })));
    const repo = {
      ...projects(two),
      claimRetries: async () => [{
        delivery: { id: "d1", kind: "incident.opened", attempts: 1, organizationId: "o", channelId: "c1", createdAt: new Date() },
        incident: { id: "i1", organizationId: "o", title: "WWW homepage is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 0, escalationLevel: 0 },
        monitor: mon,
        channel: { id: "c1", organizationId: "o", type: "slack", name: "s", config: { url: "https://hooks.example/x" }, enabled: true },
      }],
      finishDelivery: async () => {},
    };
    await retryDeliveries(repo as never);
    expect(bodies[0]).toEqual({ text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" });
  });

  it("names the project in a reminder and an escalation", async () => {
    const bodies: { text?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response("", { status: 200 })));
    const incident = { id: "i1", organizationId: "o", title: "WWW homepage is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 1, escalationLevel: 1 };
    const hook = { id: "c1", organizationId: "o", type: "slack", name: "s", enabled: true, config: { url: "https://hooks.example/x" } };
    const repo = {
      ...projects(two),
      underMaintenance: async () => false,
      claimReminders: async () => [{ incident, monitor: { ...mon, organizationId: "o", channelIds: [] }, project: { reminderEmail: false }, number: 1 }],
      claimEscalations: async () => [{ incident, monitor: { ...mon, organizationId: "o", channelIds: [] }, step: { channelIds: ["c1"] }, level: 1 }],
      channelsToAlert: async () => [{ ...hook, type: "push" }],
      channelsByIds: async () => [hook],
      queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, id: "d1", attempts: 0 })),
      claimDelivery: async (id: string) => ({ id, attempts: 0, kind: "x" }),
      finishDelivery: async () => {},
      logDeliveries: async () => {},
      pushDevicesForOrganization: async () => [{ id: "dev" }],
    };
    vi.mocked(sendPush).mockClear();
    await sendReminders(repo as never);
    expect(vi.mocked(sendPush).mock.calls[0][2]).toMatchObject({ kind: "incident.reminder", project: { id: "p1", name: "favicon.im" }, multiProject: true });
    await sendEscalations(repo as never);
    expect(bodies[0].text).toBe("🚨 [favicon.im] WWW homepage is still down and nobody has acknowledged it — escalated to you");
  });

  it("prefixes the email subject and lists the project, in the reader's language", async () => {
    const mail = vi.mocked(sendEmail);
    const send = async (event: Record<string, unknown>, lang: "en" | "zh-CN") => {
      mail.mockClear();
      await deliver({ type: "email", name: "mail", config: { to: "a@example.com" } }, { ...opened, incident: { id: "i1", title: "x", startedAt: new Date() }, ...event } as never, "t", lang);
      return mail.mock.calls[0][0] as unknown as { subject: string; html?: string; text?: string };
    };
    const multi = { project: { id: "p1", name: "favicon.im" }, multiProject: true };
    expect((await send(multi, "en")).subject).toBe("[favicon.im] 🔴 WWW homepage is down · Montral");
    expect((await send({ ...multi, kind: "incident.resolved" }, "en")).subject).toBe("[favicon.im] ✅ WWW homepage has recovered · Montral");
    const zh = await send(multi, "zh-CN");
    expect(zh.subject).toMatch(/^\[favicon\.im\] 🔴 /);
    expect(JSON.stringify(zh)).toContain("项目");
    expect(JSON.stringify(await send(multi, "en"))).toContain("favicon.im");
    // one project: unchanged
    const single = await send({ project: multi.project }, "en");
    expect(single.subject).toBe("🔴 WWW homepage is down · Montral");
    expect(JSON.stringify(single)).not.toContain("favicon.im");
  });
});

it("domain retry alerts retain unknown-versus-expired semantics", async () => {
  for (const state of ["unknown", "expired", "expiring"]) {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u, init) => { bodies.push(JSON.parse(String(init.body))); return new Response("", { status: 200 }); }));
    const repo = {
      claimRetries: async () => [{ delivery: { id: "domain-retry", kind: "incident.opened", attempts: 1 }, incident: { id: "i", title: "Registration", startedAt: new Date(), resolvedAt: null }, monitor: { id: "m", name: "Domain", target: "example.com", type: "domain", domainExpiry: { state, error: "Registry detail" } }, channel: { id: "c", type: "slack", enabled: true, config: { url: "https://hooks.example/domain" } } }],
      finishDelivery: async () => {},
    };
    await retryDeliveries(repo as never);
    expect(JSON.stringify(bodies)).toContain(state === "unknown" ? "expiry unknown" : state === "expired" ? "registration date passed" : "renewal needed");
    expect(JSON.stringify(bodies)).not.toContain("is down");
  }
});
