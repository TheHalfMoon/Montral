import { describe, expect, it, vi } from "vitest";
import { sendPush } from "./apns";
import { sendEmail } from "./email";
import { deliver, sendEscalations, stepPeople } from "./alerts";
import { icsFeed, icsFold, icsText, shiftRange } from "./oncall";
import { TOOLS } from "./mcp";

vi.mock("./email", async (orig) => ({ ...(await orig<typeof import("./email")>()), sendEmail: vi.fn(async () => {}) }));
vi.mock("./apns", () => ({ sendPush: vi.fn(async () => {}) }));

const members = [
  { userId: "u-ada", name: "Ada", email: "ada@example.com", role: "member", locale: null },
  { userId: "u-bob", name: "Bob", email: "bob@example.com", role: "admin", locale: "zh-CN" },
];
// one layer, Ada alone, always on call
const schedule = {
  id: "s1", organizationId: "o", projectId: null, name: "Primary", timeZone: "UTC", version: 1, createdAt: new Date(0), updatedAt: new Date(0),
  layers: [{ id: "l1", position: 0, name: "Main", userIds: ["u-ada"], rotationType: "daily" as const, shiftLengthHours: null, handoffTime: "00:00", handoffWeekday: null, startDate: "2020-01-01", restrictions: [] }],
};
const monitor = { id: "m1", organizationId: "o", projectId: "p", name: "API", target: "https://x", channelIds: [] as string[] };
const incident = { id: "i1", organizationId: "o", projectId: "p", title: "API is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 0, escalationLevel: 1 };

function fakeRepo(over: Record<string, unknown> = {}) {
  const queued: Record<string, unknown>[] = [];
  const finished: { id: string; status: string; message: string | null }[] = [];
  const logged: Record<string, unknown>[] = [];
  const notices: Record<string, unknown>[] = [];
  const repo = {
    underMaintenance: async () => false,
    listMembers: async () => members,
    oncallSchedulesByIds: async (_o: string, ids: string[]) => (ids.includes("s1") ? [schedule] : []),
    listOncallOverrides: async () => [],
    listPushDevices: async (userId: string) => (userId === "u-ada" ? [{ id: "d-ada", token: "t", userId, platform: "ios", environment: "production", locale: null, critical: false }] : []),
    pushDevicesForOrganization: async () => [{ id: "d-org", token: "x", userId: "someone", platform: "ios", environment: "production", locale: null }],
    channelsByIds: async () => [],
    queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r, i) => { queued.push(r); return { ...r, id: `row${i}`, attempts: 0 }; }),
    claimDelivery: async (id: string) => ({ id, attempts: 0, kind: "incident.escalated" }),
    finishDelivery: async (id: string, r: { status: string; message: string | null }) => void finished.push({ id, ...r }),
    logDeliveries: async (rows: Record<string, unknown>[]) => void logged.push(...rows),
    recordEscalationNotice: async (n: Record<string, unknown>) => void notices.push(n),
    ownerLocale: async () => "en",
    localeByEmail: async (email: string) => members.find((m) => m.email === email)?.locale ?? null,
    ...over,
  };
  return { repo: repo as never, queued, finished, logged, notices };
}

describe("escalation to people and on-call schedules", () => {
  it("resolves who is on call and the named people, skipping ex-members", async () => {
    const f = fakeRepo();
    const r = await stepPeople(f.repo, "o", { channelIds: [], userIds: ["u-bob", "u-gone"], scheduleIds: ["s1", "s-missing"] }, new Date());
    expect(r.people.map((p) => [p.member.userId, p.why])).toEqual([["u-bob", ["named in the step"]], ["u-ada", ["on call for Primary"]]]);
    expect(r.notes).toEqual(["a person named in the step is no longer a member of the workspace", "a schedule named in the step no longer exists"]);
  });

  it("notifies the on-call person by email and push through queued deliveries, and records the step", async () => {
    vi.mocked(sendEmail).mockClear();
    vi.mocked(sendPush).mockClear();
    const f = fakeRepo({ claimEscalations: async () => [{ incident, monitor, step: { channelIds: [], userIds: ["u-bob"], scheduleIds: ["s1"] }, level: 1, policy: { id: "pol", name: "Sev1", stepNumber: 1, round: 1 } }] });
    expect(await sendEscalations(f.repo)).toBe(1);
    // personal rows carry the person, never a fake channel id
    expect(f.queued.map((q) => [q.channelId, q.targetUserId, q.channelType, q.kind])).toEqual([
      [null, "u-bob", "email", "incident.escalated"],
      [null, "u-ada", "email", "incident.escalated"],
      [null, "u-ada", "push", "incident.escalated"],
    ]);
    expect(f.finished.every((x) => x.status === "sent")).toBe(true);
    expect(vi.mocked(sendEmail).mock.calls.map((c) => c[0].to).sort()).toEqual(["ada@example.com", "bob@example.com"]);
    const adaMail = vi.mocked(sendEmail).mock.calls.find((c) => c[0].to === "ada@example.com")![0] as { text?: string; html?: string };
    expect(`${adaMail.text}${adaMail.html}`).toMatch(/escalated to you/);
    // Bob reads Chinese: his personal mail follows his account language
    const bobMail = vi.mocked(sendEmail).mock.calls.find((c) => c[0].to === "bob@example.com")![0] as { text?: string; html?: string };
    expect(`${bobMail.text}${bobMail.html}`).toContain("升级通知到了你");
    // the push goes to Ada's own phone only, never to every phone of the workspace
    expect(vi.mocked(sendPush).mock.calls.map((c) => c[1].map((d: { id: string }) => d.id))).toEqual([["d-ada"]]);
    expect(f.notices).toEqual([expect.objectContaining({ incidentId: "i1", level: 1, userIds: ["u-bob", "u-ada"], policyId: "pol", channelCount: 0 })]);
    expect(String(f.notices[0].body)).toMatch(/^Escalation level 1 \(policy Sev1, step 1\): notified Bob \(named in the step\); Ada \(on call for Primary\)\.$/);
  });

  it("an acknowledgement between the claim and the send stops the page (checked before queueing)", async () => {
    const f = fakeRepo({
      claimEscalations: async () => [{ incident, monitor, step: { channelIds: [], userIds: ["u-bob"] }, level: 1 }],
      incidentFollowUpState: async () => ({ acknowledgedAt: new Date(), resolvedAt: null }),
    });
    await sendEscalations(f.repo);
    expect(f.queued).toEqual([]);
    expect(f.notices).toEqual([]);
    expect(f.logged[0]).toMatchObject({ status: "skipped", statusMessage: expect.stringMatching(/acknowledged or resolved before this escalation/) });
  });

  it("an acknowledgement after queueing still stops the provider call (checked right before sending)", async () => {
    vi.mocked(sendEmail).mockClear();
    let reads = 0;
    const f = fakeRepo({
      claimEscalations: async () => [{ incident, monitor, step: { channelIds: [], userIds: ["u-bob"] }, level: 1 }],
      // unacknowledged when the step is prepared, acknowledged by the time the row is sent
      incidentFollowUpState: async () => (reads++ === 0 ? { acknowledgedAt: null, resolvedAt: null } : { acknowledgedAt: new Date(), resolvedAt: null }),
    });
    await sendEscalations(f.repo);
    expect(f.queued).toHaveLength(1);
    expect(f.finished.map((x) => [x.status, x.message])).toEqual([["skipped", "skipped: the incident was acknowledged or resolved before this alert could be sent"]]);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("the policy's first step skips a channel that already got this incident's down alert", async () => {
    const ops = { id: "c-ops", organizationId: "o", projectId: "p", type: "webhook", name: "Ops", enabled: true, config: { url: "https://hooks.example/ops" } };
    const sec = { ...ops, id: "c-sec", name: "Sec", config: { url: "https://hooks.example/sec" } };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const f = fakeRepo({
      claimEscalations: async () => [{ incident, monitor, step: { channelIds: ["c-ops", "c-sec"] }, level: 1, policy: { id: "pol", name: "P", stepNumber: 1, round: 1 } }],
      channelsByIds: async () => [ops, sec],
      incidentDeliveries: async () => [{ kind: "incident.opened", channelId: "c-ops", status: "sent" }, { kind: "incident.opened", channelId: "c-sec", status: "failed" }],
    });
    await sendEscalations(f.repo);
    expect(f.queued.map((q) => q.channelId)).toEqual(["c-sec"]);
    expect(f.logged).toEqual([expect.objectContaining({ channelId: "c-ops", status: "skipped", statusMessage: "skipped: this channel already got the down alert for this incident" })]);
    fetchSpy.mockRestore();
  });

  it("says so when a step has nobody left to notify", async () => {
    const f = fakeRepo({ claimEscalations: async () => [{ incident, monitor, step: { channelIds: [], scheduleIds: ["s-missing"] }, level: 2 }] });
    await sendEscalations(f.repo);
    expect(f.queued).toEqual([]);
    expect(f.logged[0]).toMatchObject({ status: "skipped", statusMessage: "skipped: escalation level 2 has no channel or person left" });
    expect(String(f.notices[0].body)).toContain("nobody could be notified");
  });

  it("keeps the old channel-only behaviour without touching people or schedules", async () => {
    const f = fakeRepo({
      claimEscalations: async () => [{ incident, monitor, step: { channelIds: ["c1"] }, level: 1 }],
      listMembers: async () => { throw new Error("must not be called"); },
      channelsByIds: async () => [{ id: "c1", organizationId: "o", projectId: "p", type: "email", name: "Ops", enabled: true, config: { to: "ops@example.com" } }],
    });
    await sendEscalations(f.repo);
    expect(f.queued.map((q) => [q.channelId, q.targetUserId])).toEqual([["c1", undefined]]);
  });

  it("only a stand-in channel can narrow a push to one person: a configured channel never can", async () => {
    vi.mocked(sendPush).mockClear();
    const f = fakeRepo();
    // a real channel id with a smuggled config still reaches the workspace's devices, as a push channel always did
    await deliver({ id: "11111111-1111-4111-8111-111111111111", type: "push", organizationId: "o", config: { personal: true, userId: "u-ada" } }, { kind: "incident.escalated", incident: { id: "i1", title: "t" }, monitor: { name: "API", target: "x" } }, "t", "en", f.repo);
    expect(vi.mocked(sendPush).mock.calls[0][1].map((d: { id: string }) => d.id)).toEqual(["d-org"]);
  });
});

describe("MCP on-call tools", () => {
  it("are read-only calls of the REST endpoints (the read scope and project limits are enforced there)", () => {
    const now = TOOLS.find((x) => x.name === "who_is_on_call")!;
    const shifts = TOOLS.find((x) => x.name === "list_oncall_shifts")!;
    expect([now.readOnly, shifts.readOnly]).toEqual([true, true]);
    expect(now.build({} as never)).toEqual({ method: "GET", path: "/api/oncall/now" });
    const id = "11111111-1111-4111-8111-111111111111";
    expect(shifts.build(shifts.schema.parse({ id }) as never)).toEqual({ method: "GET", path: `/api/oncall/schedules/${id}/shifts` });
    expect(shifts.build(shifts.schema.parse({ id, from: "2026-01-01T00:00:00Z", to: "2026-01-08T00:00:00Z" }) as never).path).toBe(`/api/oncall/schedules/${id}/shifts?from=2026-01-01T00%3A00%3A00Z&to=2026-01-08T00%3A00%3A00Z`);
    expect(() => shifts.schema.parse({ id: "not-a-uuid" })).toThrow();
  });
});

describe("shift range parsing", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("defaults to two weeks from now and enforces at most 90 days", () => {
    expect(shiftRange(undefined, undefined, now)).toEqual({ from: now, to: new Date("2026-01-15T00:00:00Z") });
    expect(shiftRange("2026-01-01T00:00:00Z", "2026-03-31T23:59:59Z", now)).toMatchObject({ from: expect.any(Date) });
    expect(shiftRange("2026-01-01T00:00:00Z", "2026-04-02T00:00:00Z", now)).toEqual({ error: "The range can be at most 90 days" });
    expect(shiftRange("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", now)).toEqual({ error: "to must be after from" });
    expect(shiftRange("yesterday", undefined, now)).toEqual({ error: "from and to must be ISO 8601 date-times" });
  });
});

describe("iCalendar feed", () => {
  it("escapes text, folds long lines and uses CRLF", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = icsFold(`SUMMARY:${"界".repeat(40)}`);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
    const feed = icsFeed([{ scheduleId: "s1", scheduleName: "Primary, EU", start: new Date("2026-01-05T09:00:00Z"), end: new Date("2026-01-06T09:00:00Z"), source: "override" }], new Date("2026-01-01T00:00:00Z"));
    expect(feed).toContain("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    expect(feed).toContain("DTSTART:20260105T090000Z\r\nDTEND:20260106T090000Z\r\n");
    expect(feed).toContain("SUMMARY:On call: Primary\\, EU (override)\r\n");
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
