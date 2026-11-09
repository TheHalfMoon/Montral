import { describe, expect, it } from "vitest";
import { instantOf, isValidTimeZone, layerProblem, onCallAt, parseDate, shiftsBetween, wallOf, whoIsOnCall, type LayerSpec, type OverrideSpec, type ScheduleSpec, type Shift } from "./oncall-engine";

const Z = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const layer = (over: Partial<LayerSpec> = {}): LayerSpec => ({ id: "L1", userIds: ["a", "b", "c"], rotationType: "daily", handoffTime: "09:00", startDate: "2026-01-05", ...over });
const sched = (timeZone: string, layers: LayerSpec[], overrides: OverrideSpec[] = [], memberIds?: string[]): ScheduleSpec => ({ timeZone, layers, overrides, memberIds });
/** [userId, startISO, endISO] per shift, for compact expectations */
const brief = (s: Shift[]) => s.map((x) => [x.userId, x.start.toISOString(), x.end.toISOString()]);
const who = (s: ScheduleSpec, iso: string) => whoIsOnCall(s, Z(iso))?.userId ?? null;
const over = (id: string, userId: string, startsAt: string, endsAt: string, createdAt: string): OverrideSpec => ({ id, userId, startsAt: Z(startsAt), endsAt: Z(endsAt), createdAt: Z(createdAt) });

describe("time zone conversion", () => {
  it("knows valid zones and refuses unknown ones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Australia/Lord_Howe")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it("maps a non-existent spring-forward time to the instant the clocks jump (New York, 2026-03-08)", () => {
    // 02:30 does not exist: clocks go from 01:59:59 EST to 03:00 EDT at 07:00Z
    expect(new Date(instantOf(Date.UTC(2026, 2, 8, 2, 30), "America/New_York")).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(new Date(instantOf(Date.UTC(2026, 2, 8, 1, 59), "America/New_York")).toISOString()).toBe("2026-03-08T06:59:00.000Z");
    expect(new Date(instantOf(Date.UTC(2026, 2, 8, 3, 0), "America/New_York")).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("maps a repeated fall-back time to its first occurrence (New York, 2026-11-01)", () => {
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST)
    expect(new Date(instantOf(Date.UTC(2026, 10, 1, 1, 30), "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles Lord Howe's 30-minute shifts", () => {
    // 2026-10-04 02:00 +10:30 jumps to 02:30 +11:00 (at 15:30Z the day before): 02:15 does not exist
    expect(new Date(instantOf(Date.UTC(2026, 9, 4, 2, 15), "Australia/Lord_Howe")).toISOString()).toBe("2026-10-03T15:30:00.000Z");
    // 2026-04-05 02:00 +11:00 falls back to 01:30 +10:30: 01:45 happens twice, first at 14:45Z
    expect(new Date(instantOf(Date.UTC(2026, 3, 5, 1, 45), "Australia/Lord_Howe")).toISOString()).toBe("2026-04-04T14:45:00.000Z");
  });

  it("round-trips wall time in zones without DST", () => {
    for (const tz of ["Asia/Tokyo", "UTC", "Asia/Kolkata"]) {
      const t = Date.UTC(2026, 6, 1, 12, 34, 56, 789);
      expect(instantOf(wallOf(t, tz), tz)).toBe(t);
    }
  });

  it("validates calendar dates, including leap days", () => {
    expect(parseDate("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
    expect(parseDate("2027-02-29")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("26-01-01")).toBeNull();
  });
});

describe("layer validation", () => {
  it("accepts a sensible layer and names what is wrong with a bad one", () => {
    expect(layerProblem(layer())).toBeNull();
    expect(layerProblem(layer({ userIds: [] }))).toMatch(/at least one/);
    expect(layerProblem(layer({ userIds: ["a", "a"] }))).toMatch(/twice/);
    expect(layerProblem(layer({ rotationType: "custom", shiftLengthHours: 0 }))).toMatch(/shift length/);
    expect(layerProblem(layer({ rotationType: "custom", shiftLengthHours: 12 }))).toBeNull();
    expect(layerProblem(layer({ handoffTime: "24:00" }))).toMatch(/HH:MM/);
    expect(layerProblem(layer({ handoffWeekday: 7 }))).toMatch(/weekday/);
    expect(layerProblem(layer({ startDate: "2027-02-29" }))).toMatch(/real/);
    expect(layerProblem(layer({ restrictions: [{ days: [], start: "09:00", end: "17:00" }] }))).toMatch(/weekdays/);
    expect(layerProblem(layer({ restrictions: [{ days: [1], start: "9:00", end: "17:00" }] }))).toMatch(/HH:MM/);
  });
});

describe("daily rotation", () => {
  const s = sched("UTC", [layer()]);
  it("hands off exactly at the handoff instant", () => {
    expect(who(s, "2026-01-05T08:59:59.999Z")).toBeNull(); // before the layer starts
    expect(who(s, "2026-01-05T09:00:00.000Z")).toBe("a");
    expect(who(s, "2026-01-06T08:59:59.999Z")).toBe("a");
    expect(who(s, "2026-01-06T09:00:00.000Z")).toBe("b");
    expect(who(s, "2026-01-07T09:00:00.000Z")).toBe("c");
    expect(who(s, "2026-01-08T09:00:00.000Z")).toBe("a");
  });
  it("lists shifts clipped to the range", () => {
    expect(brief(shiftsBetween(s, Z("2026-01-05T00:00:00Z"), Z("2026-01-07T12:00:00Z")))).toEqual([
      ["a", "2026-01-05T09:00:00.000Z", "2026-01-06T09:00:00.000Z"],
      ["b", "2026-01-06T09:00:00.000Z", "2026-01-07T09:00:00.000Z"],
      ["c", "2026-01-07T09:00:00.000Z", "2026-01-07T12:00:00.000Z"],
    ]);
  });
  it("reports the whole current shift, not just the instant", () => {
    const now = whoIsOnCall(s, Z("2026-01-06T15:00:00Z"))!;
    expect([now.userId, now.start.toISOString(), now.end.toISOString(), now.source, now.layerId]).toEqual(["b", "2026-01-06T09:00:00.000Z", "2026-01-07T09:00:00.000Z", "layer", "L1"]);
  });
  it("keeps separate shifts for a one-person rotation", () => {
    const one = sched("UTC", [layer({ userIds: ["a"] })]);
    expect(shiftsBetween(one, Z("2026-01-05T09:00:00Z"), Z("2026-01-07T09:00:00Z"))).toHaveLength(2);
  });
  it("is empty for an empty or reversed range and refuses absurd ones", () => {
    expect(shiftsBetween(s, Z("2026-02-01T00:00:00Z"), Z("2026-02-01T00:00:00Z"))).toEqual([]);
    expect(shiftsBetween(s, Z("2026-02-02T00:00:00Z"), Z("2026-02-01T00:00:00Z"))).toEqual([]);
    expect(() => shiftsBetween(s, Z("2026-01-01T00:00:00Z"), Z("2028-01-01T00:00:00Z"))).toThrow(RangeError);
    expect(() => shiftsBetween(sched("Nowhere/Land", [layer()]), Z("2026-01-01T00:00:00Z"), Z("2026-01-02T00:00:00Z"))).toThrow(RangeError);
  });
  it("crosses a leap day without skipping anyone", () => {
    const leap = sched("UTC", [layer({ startDate: "2028-02-27", handoffTime: "00:00" })]);
    expect(brief(shiftsBetween(leap, Z("2028-02-27T00:00:00Z"), Z("2028-03-02T00:00:00Z"))).map((x) => [x[0], x[1].slice(0, 10)])).toEqual([
      ["a", "2028-02-27"], ["b", "2028-02-28"], ["c", "2028-02-29"], ["a", "2028-03-01"],
    ]);
    // a rotation can start on the leap day itself
    expect(who(sched("UTC", [layer({ startDate: "2028-02-29" })]), "2028-02-29T09:00:00Z")).toBe("a");
  });
});

describe("daylight saving time", () => {
  it("America/New_York spring forward: a 02:30 handoff happens when the clocks jump to 03:00", () => {
    const s = sched("America/New_York", [layer({ handoffTime: "02:30", startDate: "2026-03-06", userIds: ["a", "b"] })]);
    expect(brief(shiftsBetween(s, Z("2026-03-07T00:00:00Z"), Z("2026-03-09T12:00:00Z")))).toEqual([
      ["a", "2026-03-07T00:00:00.000Z", "2026-03-07T07:30:00.000Z"],
      ["b", "2026-03-07T07:30:00.000Z", "2026-03-08T07:00:00.000Z"], // 23.5 hours: 02:30 EST to 03:00 EDT
      ["a", "2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"], // 23.5 hours: 03:00 EDT to 02:30 EDT
      ["b", "2026-03-09T06:30:00.000Z", "2026-03-09T12:00:00.000Z"],
    ]);
  });

  it("America/New_York fall back: a 01:30 handoff happens once, at the first 01:30", () => {
    const s = sched("America/New_York", [layer({ handoffTime: "01:30", startDate: "2026-10-30", userIds: ["a", "b"] })]);
    const shifts = shiftsBetween(s, Z("2026-10-31T05:30:00Z"), Z("2026-11-02T06:30:00Z"));
    expect(brief(shifts)).toEqual([
      ["b", "2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z"],
      ["a", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"], // 25 hours, no second handoff at 06:30Z
    ]);
    expect(who(s, "2026-11-01T06:30:00Z")).toBe("a");
  });

  it("America/New_York weekly Sunday 02:30 handoff in the spring-forward gap", () => {
    const s = sched("America/New_York", [layer({ rotationType: "weekly", handoffWeekday: 0, handoffTime: "02:30", startDate: "2026-03-01", userIds: ["a", "b"] })]);
    expect(who(s, "2026-03-08T06:59:59.999Z")).toBe("a");
    expect(who(s, "2026-03-08T07:00:00.000Z")).toBe("b");
    // the following week hands off at 02:30 EDT again
    expect(who(s, "2026-03-15T06:29:59.999Z")).toBe("b");
    expect(who(s, "2026-03-15T06:30:00.000Z")).toBe("a");
  });

  it("Europe/London weekly Monday 09:00 handoff across the start of summer time is 167 hours long", () => {
    const s = sched("Europe/London", [layer({ rotationType: "weekly", handoffWeekday: 1, handoffTime: "09:00", startDate: "2026-03-23", userIds: ["a", "b"] })]);
    const [first, second] = shiftsBetween(s, Z("2026-03-23T09:00:00Z"), Z("2026-04-06T08:00:00Z"));
    expect([first.userId, first.start.toISOString(), first.end.toISOString()]).toEqual(["a", "2026-03-23T09:00:00.000Z", "2026-03-30T08:00:00.000Z"]);
    expect(first.end.getTime() - first.start.getTime()).toBe(167 * HOUR);
    expect([second.userId, second.start.toISOString(), second.end.toISOString()]).toEqual(["b", "2026-03-30T08:00:00.000Z", "2026-04-06T08:00:00.000Z"]);
  });

  it("Europe/London weekly handoff across the end of summer time is 169 hours long", () => {
    const s = sched("Europe/London", [layer({ rotationType: "weekly", handoffWeekday: 1, handoffTime: "09:00", startDate: "2026-10-19", userIds: ["a", "b"] })]);
    const [first] = shiftsBetween(s, Z("2026-10-19T08:00:00Z"), Z("2026-10-27T00:00:00Z"));
    expect([first.start.toISOString(), first.end.toISOString()]).toEqual(["2026-10-19T08:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
  });

  it("Europe/London: a weekly rotation that starts mid-week hands off on the chosen weekday", () => {
    // starts Wednesday 2026-01-07 09:00; first handoff Monday 2026-01-12 09:00, then weekly
    const s = sched("Europe/London", [layer({ rotationType: "weekly", handoffWeekday: 1, startDate: "2026-01-07", userIds: ["a", "b"] })]);
    expect(who(s, "2026-01-07T09:00:00Z")).toBe("a");
    expect(who(s, "2026-01-12T08:59:59Z")).toBe("a");
    expect(who(s, "2026-01-12T09:00:00Z")).toBe("b");
    expect(who(s, "2026-01-19T09:00:00Z")).toBe("a");
  });

  it("Australia/Lord_Howe: 30-minute DST changes move handoffs by 30 minutes", () => {
    const s = sched("Australia/Lord_Howe", [layer({ handoffTime: "02:15", startDate: "2026-10-01", userIds: ["a", "b"] })]);
    // 2026-10-04 02:15 does not exist (02:00 +10:30 jumps to 02:30 +11:00 at 15:30Z on the 3rd)
    const shifts = shiftsBetween(s, Z("2026-10-02T15:45:00Z"), Z("2026-10-04T15:15:00Z"));
    expect(brief(shifts)).toEqual([
      ["a", "2026-10-02T15:45:00.000Z", "2026-10-03T15:30:00.000Z"], // 23h45: up to the jump
      ["b", "2026-10-03T15:30:00.000Z", "2026-10-04T15:15:00.000Z"], // 23h45: 02:30 +11 to 02:15 +11
    ]);
    // the autumn change repeats 01:30-02:00: a 01:45 handoff happens once, at the first 01:45 (+11:00)
    const autumn = sched("Australia/Lord_Howe", [layer({ handoffTime: "01:45", startDate: "2026-04-01", userIds: ["a", "b"] })]);
    const around = shiftsBetween(autumn, Z("2026-04-03T14:45:00Z"), Z("2026-04-05T15:15:00Z"));
    expect(brief(around).map((x) => x[1])).toEqual(["2026-04-03T14:45:00.000Z", "2026-04-04T14:45:00.000Z"]);
    expect(around[1].end.getTime() - around[1].start.getTime()).toBe(24.5 * HOUR);
  });

  it("a zone without DST hands off at the same UTC instant every day (Asia/Tokyo)", () => {
    const s = sched("Asia/Tokyo", [layer({ startDate: "2026-03-01", userIds: ["a", "b"] })]);
    const shifts = shiftsBetween(s, Z("2026-03-01T00:00:00Z"), Z("2026-04-01T00:00:00Z"));
    expect(shifts.every((x) => x.start.toISOString().endsWith("T00:00:00.000Z") || x === shifts[0])).toBe(true);
    expect(shifts.slice(0, -1).every((x) => x.end.getTime() - x.start.getTime() === DAY)).toBe(true);
  });

  it("a custom rotation shorter than 24 hours is measured in elapsed time: 12-hour shifts stay 12 hours across fall back", () => {
    const s = sched("America/New_York", [layer({ rotationType: "custom", shiftLengthHours: 12, handoffTime: "08:00", startDate: "2026-10-31", userIds: ["day", "night"] })]);
    expect(brief(shiftsBetween(s, Z("2026-10-31T12:00:00Z"), Z("2026-11-02T01:00:00Z")))).toEqual([
      ["day", "2026-10-31T12:00:00.000Z", "2026-11-01T00:00:00.000Z"],
      ["night", "2026-11-01T00:00:00.000Z", "2026-11-01T12:00:00.000Z"], // 20:00 EDT to 07:00 EST: still 12 hours
      ["day", "2026-11-01T12:00:00.000Z", "2026-11-02T00:00:00.000Z"],
      ["night", "2026-11-02T00:00:00.000Z", "2026-11-02T01:00:00.000Z"],
    ]);
  });

  it("America/New_York 2026-03-08: a 1-hour A/B/C rotation gives everyone a full hour through the spring-forward gap", () => {
    const s = sched("America/New_York", [layer({ rotationType: "custom", shiftLengthHours: 1, handoffTime: "00:00", startDate: "2026-03-08", userIds: ["a", "b", "c"] })]);
    // midnight EST = 05:00Z; local 02:00-02:59 does not exist (07:00Z is 03:00 EDT)
    const shifts = shiftsBetween(s, Z("2026-03-08T05:00:00Z"), Z("2026-03-08T11:00:00Z"));
    expect(brief(shifts)).toEqual([
      ["a", "2026-03-08T05:00:00.000Z", "2026-03-08T06:00:00.000Z"],
      ["b", "2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"],
      ["c", "2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z"],
      ["a", "2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z"],
      ["b", "2026-03-08T09:00:00.000Z", "2026-03-08T10:00:00.000Z"],
      ["c", "2026-03-08T10:00:00.000Z", "2026-03-08T11:00:00.000Z"],
    ]);
    expect(shifts.every((x) => x.end.getTime() - x.start.getTime() === HOUR)).toBe(true);
  });

  it("a custom rotation of 24 hours or more keeps the local wall clock", () => {
    const s = sched("America/New_York", [layer({ rotationType: "custom", shiftLengthHours: 36, handoffTime: "08:00", startDate: "2026-03-06", userIds: ["a", "b"] })]);
    // 2026-03-06 08:00 EST, 03-07 20:00 EST, 03-09 08:00 EDT: the second shift is 35 hours of elapsed time
    expect(brief(shiftsBetween(s, Z("2026-03-06T13:00:00Z"), Z("2026-03-09T12:00:00Z")))).toEqual([
      ["a", "2026-03-06T13:00:00.000Z", "2026-03-08T01:00:00.000Z"],
      ["b", "2026-03-08T01:00:00.000Z", "2026-03-09T12:00:00.000Z"],
    ]);
  });
});

describe("overrides", () => {
  const base = layer({ userIds: ["a"], startDate: "2026-01-01", handoffTime: "00:00" });
  it("take precedence over the rotation for exactly their span", () => {
    const s = sched("UTC", [base], [over("o1", "x", "2026-02-01T10:00:00Z", "2026-02-01T14:00:00Z", "2026-01-20T00:00:00Z")]);
    expect(brief(shiftsBetween(s, Z("2026-02-01T08:00:00Z"), Z("2026-02-01T16:00:00Z")))).toEqual([
      ["a", "2026-02-01T08:00:00.000Z", "2026-02-01T10:00:00.000Z"],
      ["x", "2026-02-01T10:00:00.000Z", "2026-02-01T14:00:00.000Z"],
      ["a", "2026-02-01T14:00:00.000Z", "2026-02-01T16:00:00.000Z"],
    ]);
    expect(whoIsOnCall(s, Z("2026-02-01T10:00:00Z"))).toMatchObject({ userId: "x", source: "override", overrideId: "o1", layerId: null });
    expect(who(s, "2026-02-01T14:00:00Z")).toBe("a");
  });
  it("nested: the later-created inner override wins inside the outer one", () => {
    const s = sched("UTC", [base], [
      over("outer", "x", "2026-02-01T10:00:00Z", "2026-02-01T14:00:00Z", "2026-01-20T00:00:00Z"),
      over("inner", "y", "2026-02-01T11:00:00Z", "2026-02-01T12:00:00Z", "2026-01-21T00:00:00Z"),
    ]);
    expect(brief(shiftsBetween(s, Z("2026-02-01T10:00:00Z"), Z("2026-02-01T14:00:00Z")))).toEqual([
      ["x", "2026-02-01T10:00:00.000Z", "2026-02-01T11:00:00.000Z"],
      ["y", "2026-02-01T11:00:00.000Z", "2026-02-01T12:00:00.000Z"],
      ["x", "2026-02-01T12:00:00.000Z", "2026-02-01T14:00:00.000Z"],
    ]);
  });
  it("nested: an older inner override is hidden by a newer outer one", () => {
    const s = sched("UTC", [base], [
      over("outer", "x", "2026-02-01T10:00:00Z", "2026-02-01T14:00:00Z", "2026-01-22T00:00:00Z"),
      over("inner", "y", "2026-02-01T11:00:00Z", "2026-02-01T12:00:00Z", "2026-01-21T00:00:00Z"),
    ]);
    expect(brief(shiftsBetween(s, Z("2026-02-01T10:00:00Z"), Z("2026-02-01T14:00:00Z")))).toEqual([["x", "2026-02-01T10:00:00.000Z", "2026-02-01T14:00:00.000Z"]]);
  });
  it("partial overlap: the latest created takes the overlap", () => {
    const first = over("p", "x", "2026-02-01T10:00:00Z", "2026-02-01T14:00:00Z", "2026-01-20T00:00:00Z");
    const later = over("q", "y", "2026-02-01T13:00:00Z", "2026-02-01T16:00:00Z", "2026-01-21T00:00:00Z");
    expect(brief(shiftsBetween(sched("UTC", [base], [first, later]), Z("2026-02-01T10:00:00Z"), Z("2026-02-01T16:00:00Z")))).toEqual([
      ["x", "2026-02-01T10:00:00.000Z", "2026-02-01T13:00:00.000Z"],
      ["y", "2026-02-01T13:00:00.000Z", "2026-02-01T16:00:00.000Z"],
    ]);
    const earlier = { ...later, createdAt: Z("2026-01-19T00:00:00Z") };
    expect(brief(shiftsBetween(sched("UTC", [base], [first, earlier]), Z("2026-02-01T10:00:00Z"), Z("2026-02-01T16:00:00Z")))).toEqual([
      ["x", "2026-02-01T10:00:00.000Z", "2026-02-01T14:00:00.000Z"],
      ["y", "2026-02-01T14:00:00.000Z", "2026-02-01T16:00:00.000Z"],
    ]);
  });
  it("fill gaps where no layer has anyone, and a tie on creation time is decided by id", () => {
    const s = sched("UTC", [], [
      over("b", "y", "2026-02-01T10:00:00Z", "2026-02-01T12:00:00Z", "2026-01-20T00:00:00Z"),
      over("a", "x", "2026-02-01T10:00:00Z", "2026-02-01T12:00:00Z", "2026-01-20T00:00:00Z"),
    ]);
    expect(who(s, "2026-02-01T11:00:00Z")).toBe("y");
    expect(who(s, "2026-02-01T12:00:00Z")).toBeNull();
  });
});

describe("restriction windows and layer precedence", () => {
  it("a business-hours layer covers the 24/7 layer on weekdays 09:00-17:00 only", () => {
    const always = layer({ id: "base", userIds: ["night"], startDate: "2026-01-01", handoffTime: "00:00" });
    const office = layer({ id: "office", userIds: ["day"], startDate: "2026-01-01", handoffTime: "09:00", restrictions: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] });
    const s = sched("Europe/London", [always, office]);
    expect(who(s, "2026-01-05T08:59:59Z")).toBe("night"); // Monday morning, before 09:00
    expect(who(s, "2026-01-05T09:00:00Z")).toBe("day");
    expect(who(s, "2026-01-05T16:59:59Z")).toBe("day");
    expect(who(s, "2026-01-05T17:00:00Z")).toBe("night");
    expect(who(s, "2026-01-10T12:00:00Z")).toBe("night"); // Saturday
    // in summer the window follows London's clock, not UTC
    expect(who(s, "2026-07-06T08:00:00Z")).toBe("day"); // 09:00 BST
    expect(who(s, "2026-07-06T16:00:00Z")).toBe("night"); // 17:00 BST
    const day = shiftsBetween(s, Z("2026-01-05T00:00:00Z"), Z("2026-01-06T00:00:00Z"));
    expect(brief(day).map((x) => x[0])).toEqual(["night", "day", "night"]);
  });
  it("a window that crosses midnight, and gaps when nothing else covers", () => {
    const nights = layer({ userIds: ["owl"], startDate: "2026-01-01", handoffTime: "00:00", restrictions: [{ days: [5], start: "22:00", end: "06:00" }] });
    const s = sched("UTC", [nights]);
    expect(who(s, "2026-01-09T21:59:00Z")).toBeNull(); // Friday
    expect(who(s, "2026-01-09T22:00:00Z")).toBe("owl");
    expect(who(s, "2026-01-10T05:59:00Z")).toBe("owl"); // Saturday morning, still Friday's window
    expect(who(s, "2026-01-10T06:00:00Z")).toBeNull();
    // the window splits across the daily handoff at midnight: two shifts of the same one-person rotation
    expect(brief(shiftsBetween(s, Z("2026-01-09T00:00:00Z"), Z("2026-01-11T00:00:00Z")))).toEqual([
      ["owl", "2026-01-09T22:00:00.000Z", "2026-01-10T00:00:00.000Z"],
      ["owl", "2026-01-10T00:00:00.000Z", "2026-01-10T06:00:00.000Z"],
    ]);
  });
  it("00:00-00:00 is a whole day", () => {
    const s = sched("UTC", [layer({ userIds: ["w"], restrictions: [{ days: [0, 6], start: "00:00", end: "00:00" }], startDate: "2026-01-01", handoffTime: "00:00" })]);
    expect(who(s, "2026-01-10T00:00:00Z")).toBe("w");
    expect(who(s, "2026-01-11T23:59:59Z")).toBe("w");
    expect(who(s, "2026-01-12T00:00:00Z")).toBeNull();
  });
  it("an invalid layer is ignored rather than breaking the schedule", () => {
    const s = sched("UTC", [layer({ id: "ok", userIds: ["a"] }), layer({ id: "bad", userIds: [] })]);
    expect(who(s, "2026-02-01T12:00:00Z")).toBe("a");
  });
});

describe("members removed from the workspace", () => {
  it("are skipped: their shift goes to the next member in the rotation", () => {
    const s = sched("UTC", [layer()], [], ["a", "c"]);
    expect(who(s, "2026-01-05T10:00:00Z")).toBe("a");
    expect(who(s, "2026-01-06T10:00:00Z")).toBe("c"); // b's day
    expect(who(s, "2026-01-07T10:00:00Z")).toBe("c");
    expect(who(s, "2026-01-08T10:00:00Z")).toBe("a");
  });
  it("leave a gap when nobody in the layer is a member any more", () => {
    expect(who(sched("UTC", [layer()], [], ["z"]), "2026-01-06T10:00:00Z")).toBeNull();
  });
  it("lose their overrides", () => {
    const s = sched("UTC", [layer()], [over("o", "gone", "2026-01-06T00:00:00Z", "2026-01-07T00:00:00Z", "2026-01-01T00:00:00Z")], ["a", "b", "c"]);
    expect(who(s, "2026-01-06T10:00:00Z")).toBe("b");
  });
});

describe("properties over random schedules and times", () => {
  // a small deterministic generator: the same cases on every run
  let seed = 0x5eed;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const zones = ["America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Tokyo", "UTC", "Asia/Kolkata", "America/Sao_Paulo"];
  const randomLayer = (id: string): LayerSpec => {
    const rotationType = pick(["daily", "weekly", "custom"] as const);
    const restricted = rnd() < 0.3;
    return {
      id,
      userIds: ["u1", "u2", "u3", "u4"].slice(0, 1 + Math.floor(rnd() * 4)),
      rotationType,
      shiftLengthHours: rotationType === "custom" ? 1 + Math.floor(rnd() * 72) : null,
      handoffTime: `${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`,
      handoffWeekday: rotationType === "weekly" ? Math.floor(rnd() * 7) : null,
      startDate: `2026-0${1 + Math.floor(rnd() * 3)}-1${Math.floor(rnd() * 9)}`,
      restrictions: restricted ? [{ days: [1, 2, 3, 4, 5].filter(() => rnd() < 0.7).concat([3]), start: "08:30", end: pick(["17:00", "02:00"]) }] : null,
    };
  };
  const cases = Array.from({ length: 40 }, (_, i) => {
    const layers = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, j) => randomLayer(`L${i}-${j}`));
    const start = Date.UTC(2026, 3, 1) + Math.floor(rnd() * 200) * DAY;
    const overrides = Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => {
      const s = start + Math.floor(rnd() * 20 * DAY);
      return { id: `o${k}`, userId: pick(["u1", "u2", "x"]), startsAt: new Date(s), endsAt: new Date(s + (1 + Math.floor(rnd() * 72)) * HOUR), createdAt: new Date(Date.UTC(2026, 0, 1) + k * 1000) };
    });
    return { schedule: sched(pick(zones), layers, overrides, rnd() < 0.3 ? ["u1", "u3", "x"] : undefined), from: start, to: start + 30 * DAY };
  });

  it("shifts are ordered, non-empty, inside the range and never overlap", () => {
    for (const c of cases) {
      const shifts = shiftsBetween(c.schedule, new Date(c.from), new Date(c.to));
      let last = c.from;
      for (const s of shifts) {
        expect(s.start.getTime()).toBeGreaterThanOrEqual(last);
        expect(s.end.getTime()).toBeGreaterThan(s.start.getTime());
        expect(s.end.getTime()).toBeLessThanOrEqual(c.to);
        last = s.end.getTime();
      }
    }
  });

  it("whoIsOnCall agrees with shiftsBetween at random instants and exactly at every boundary", () => {
    for (const c of cases) {
      const shifts = shiftsBetween(c.schedule, new Date(c.from), new Date(c.to));
      const expected = (t: number) => shifts.find((s) => s.start.getTime() <= t && s.end.getTime() > t)?.userId ?? null;
      const probes = [...Array.from({ length: 15 }, () => c.from + DAY + Math.floor(rnd() * 27 * DAY)), ...shifts.slice(1, 8).flatMap((s) => [s.start.getTime(), s.start.getTime() - 1])];
      for (const t of probes) if (t >= c.from + DAY && t < c.to - DAY) expect(whoIsOnCall(c.schedule, new Date(t))?.userId ?? null).toBe(expected(t));
    }
  });

  it("splitting a range does not change the answer", () => {
    for (const c of cases.slice(0, 20)) {
      const mid = c.from + Math.floor(rnd() * (c.to - c.from));
      const whole = shiftsBetween(c.schedule, new Date(c.from), new Date(c.to));
      const parts = [...shiftsBetween(c.schedule, new Date(c.from), new Date(mid)), ...shiftsBetween(c.schedule, new Date(mid), new Date(c.to))];
      // join the pieces cut at `mid` back together, then compare who is on when
      const joined: Shift[] = [];
      for (const p of parts) {
        const prev = joined[joined.length - 1];
        if (prev && prev.end.getTime() === mid && p.start.getTime() === mid && prev.userId === p.userId && prev.layerId === p.layerId && prev.overrideId === p.overrideId) prev.end = p.end;
        else joined.push({ ...p });
      }
      expect(brief(joined)).toEqual(brief(whole));
    }
  });

  it("an unrestricted rotation with every member covers every instant after it starts", () => {
    for (const c of cases) {
      const layers = c.schedule.layers.map((l) => ({ ...l, restrictions: null, startDate: "2026-01-01" }));
      const shifts = shiftsBetween({ timeZone: c.schedule.timeZone, layers }, new Date(c.from), new Date(c.to));
      const covered = shifts.reduce((n, s) => n + (s.end.getTime() - s.start.getTime()), 0);
      expect(covered).toBe(c.to - c.from);
    }
  });
});

describe("performance: paging must never stall on a large schedule", () => {
  // 10 layers of 1-hour rotations and 500 overrides over 90 days: about 21,600 layer segments plus the overrides
  const layers = Array.from({ length: 10 }, (_, i) => layer({ id: `perf${i}`, rotationType: "custom", shiftLengthHours: 1, handoffTime: "00:00", startDate: "2026-01-01", userIds: [`p${i}a`, `p${i}b`, `p${i}c`] }));
  const start = Date.UTC(2026, 2, 1);
  const overrides = Array.from({ length: 500 }, (_, k) => ({ id: `o${k}`, userId: `x${k % 7}`, startsAt: new Date(start + k * 4 * HOUR), endsAt: new Date(start + k * 4 * HOUR + (1 + (k % 30)) * HOUR), createdAt: new Date(Date.UTC(2026, 0, 1) + k) }));
  const big = sched("America/New_York", layers, overrides);
  const time = (fn: () => unknown, runs = 5) => {
    fn(); // warm up the formatter and offset caches, as a long-running server has
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); ms.push(performance.now() - t); }
    return ms.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };
  it("computes 90 days of shifts in well under 200 ms", () => {
    let count = 0;
    const median = time(() => { count = shiftsBetween(big, new Date(start), new Date(start + 90 * DAY)).length; });
    console.log(`oncall perf: shiftsBetween 10 layers x 1 h + 500 overrides over 90 days: ${median.toFixed(1)} ms median, ${count} shifts`);
    // overrides take ~83 of the 90 days (each newer one cuts the previous short), hourly handoffs fill the rest
    expect(count).toBeGreaterThan(600);
    expect(median).toBeLessThan(200);
  });
  it("answers who is on call in a few milliseconds", () => {
    const at = new Date(start + 45 * DAY + 1234567);
    const whoMs = time(() => whoIsOnCall(big, at), 21);
    const nowMs = time(() => onCallAt(big, at), 21);
    console.log(`oncall perf: whoIsOnCall ${whoMs.toFixed(2)} ms median, onCallAt ${nowMs.toFixed(2)} ms median`);
    expect(onCallAt(big, at)).toBe(whoIsOnCall(big, at)?.userId ?? null);
    expect(whoMs).toBeLessThan(10);
    expect(nowMs).toBeLessThan(5);
  });
  it("the sweep agrees with a brute-force check of every override at random instants", () => {
    const shifts = shiftsBetween(big, new Date(start), new Date(start + 90 * DAY));
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const t = start + Math.floor(rnd() * 90 * DAY);
      const covering = overrides.filter((o) => o.startsAt.getTime() <= t && o.endsAt.getTime() > t).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
      const got = shifts.find((s) => s.start.getTime() <= t && s.end.getTime() > t);
      if (covering.length) expect(got?.overrideId, new Date(t).toISOString()).toBe(covering[0].id);
      else expect(got?.layerId).toBe("perf9");
    }
  });
});
