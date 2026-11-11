import { describe, expect, it } from "vitest";
import { dismissOnboarding, onboardingComplete, onboardingDismissed, onboardingProgress, onboardingSteps, showOnboarding } from "./onboarding";

const counts = (monitors: number, channels: number, statusPages: number) => ({ monitors, channels, statusPages });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("first-run checklist", () => {
  it("derives every step from the workspace's data; the workspace step is always done", () => {
    expect(onboardingSteps(counts(0, 0, 0)).map((s) => [s.key, s.done, s.optional])).toEqual([
      ["workspace", true, false], ["monitor", false, false], ["channel", false, false], ["status-page", false, true],
    ]);
    expect(onboardingSteps(counts(2, 1, 1)).every((s) => s.done)).toBe(true);
    expect(onboardingProgress(counts(1, 0, 1))).toEqual({ done: 3, total: 4 });
  });
  it("is complete with a monitor and an alert channel; the status page is optional", () => {
    expect(onboardingComplete(counts(1, 0, 5))).toBe(false);
    expect(onboardingComplete(counts(0, 1, 0))).toBe(false);
    expect(onboardingComplete(counts(1, 1, 0))).toBe(true);
  });
  it("shows on an empty workspace even when hidden, and after the first monitor until complete or hidden", () => {
    expect(showOnboarding(counts(0, 0, 0), { allProjects: false, dismissed: true })).toBe(true);
    expect(showOnboarding(counts(1, 0, 0), { allProjects: false, dismissed: false })).toBe(true);
    expect(showOnboarding(counts(1, 0, 0), { allProjects: false, dismissed: true })).toBe(false);
    expect(showOnboarding(counts(1, 1, 0), { allProjects: false, dismissed: false })).toBe(false);
  });
  it("never shows in the read-only All projects view", () => {
    expect(showOnboarding(counts(0, 0, 0), { allProjects: true, dismissed: false })).toBe(false);
  });
  it("remembers hiding per workspace only", () => {
    const store = memory();
    expect(onboardingDismissed("ws-a", store)).toBe(false);
    dismissOnboarding("ws-a", store);
    expect(onboardingDismissed("ws-a", store)).toBe(true);
    expect(onboardingDismissed("ws-b", store)).toBe(false);
    // no workspace or no storage (private mode): nothing remembered, nothing thrown
    dismissOnboarding(null, store);
    expect(onboardingDismissed(null, store)).toBe(false);
    expect(onboardingDismissed("ws-a", null)).toBe(false);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(() => dismissOnboarding("ws-a", throwing)).not.toThrow();
    expect(onboardingDismissed("ws-a", throwing)).toBe(false);
  });
});
