import { describe, expect, it } from "vitest";
import { resolveOnCall, validateOnCall, type OnCallRotation, type OnCallOverride } from "./oncall";
const d = (s: string) => new Date(s);
const rotation: OnCallRotation = {
  anchor: d("2026-03-28T00:00:00Z"), shiftMinutes: 1440,
  participants: ["alice", "bob", "carol"],
};
const override = (start: string, end: string, participantId: string, priority = 1): OnCallOverride =>
  ({ start: d(start), end: d(end), participantId, priority });
describe("UTC on-call resolution", () => {
  it("rotates at exact UTC boundaries, before anchor, and across DST changes", () => {
    expect(resolveOnCall(rotation, [], d("2026-03-27T23:59:59Z")).participantId).toBe("carol");
    expect(resolveOnCall(rotation, [], d("2026-03-28T00:00:00Z")).participantId).toBe("alice");
    expect(resolveOnCall(rotation, [], d("2026-03-29T00:00:00Z")).participantId).toBe("bob");
    expect(resolveOnCall(rotation, [], d("2026-03-30T00:00:00Z")).participantId).toBe("carol");
  });
  it("applies half-open overrides, higher priority, and preserves next transition", () => {
    const os = [override("2026-03-28T10:00:00Z","2026-03-28T16:00:00Z","bob"),
      override("2026-03-28T12:00:00Z","2026-03-28T14:00:00Z","carol",2)];
    expect(resolveOnCall(rotation,os,d("2026-03-28T09:00:00Z"))).toMatchObject({
      participantId:"alice", source:"rotation", validUntil:d("2026-03-28T10:00:00Z") });
    expect(resolveOnCall(rotation,os,d("2026-03-28T12:00:00Z"))).toMatchObject({
      participantId:"carol", source:"override", validUntil:d("2026-03-28T14:00:00Z") });
    expect(resolveOnCall(rotation,os,d("2026-03-28T14:00:00Z")).participantId).toBe("bob");
    expect(resolveOnCall(rotation,os,d("2026-03-28T16:00:00Z")).participantId).toBe("alice");
  });
  it("rejects ambiguous equal-priority overlaps regardless of row order", () => {
    const os=[override("2026-03-28T10:00:00Z","2026-03-28T16:00:00Z","bob"),
      override("2026-03-28T12:00:00Z","2026-03-28T18:00:00Z","carol")];
    expect(() => validateOnCall(rotation,os)).toThrow(/Ambiguous/);
    expect(() => validateOnCall(rotation,os.reverse())).toThrow(/Ambiguous/);
  });
  it("fails closed for malformed recipients, invalid dates, zero shifts, duplicate participants and unsafe priorities", () => {
    expect(() => resolveOnCall(rotation,[],new Date(NaN))).toThrow();
    expect(() => validateOnCall({...rotation,shiftMinutes:0},[])).toThrow();
    expect(() => validateOnCall({...rotation,participants:["alice","alice"]},[])).toThrow();
    expect(() => validateOnCall({...rotation,participants:["alice@example.com"]},[])).toThrow();
    expect(() => validateOnCall(rotation,[override("2026-03-28T18:00:00Z","2026-03-28T17:00:00Z","bob")])).toThrow();
    expect(() => validateOnCall(rotation,[override("2026-03-28T10:00:00Z","2026-03-28T11:00:00Z","bob",Infinity)])).toThrow();
  });
});
