import { describe, expect, it } from "vitest";
import { regionLocked, regionRunState, toggleRegion } from "./regions";

describe("toggleRegion", () => {
  it("replaces auto with the first region picked", () => {
    expect(toggleRegion(["auto"], "us-east", 1)).toEqual(["us-east"]);
    expect(toggleRegion(["auto"], "us-east", 3)).toEqual(["us-east"]);
  });
  it("switches to another region on a one-region plan", () => {
    expect(toggleRegion(["us-east"], "eu-central", 1)).toEqual(["eu-central"]);
    expect(toggleRegion(["us-east"], "auto", 1)).toEqual(["auto"]);
  });
  it("adds regions up to the limit and then holds", () => {
    expect(toggleRegion(["us-east"], "eu-central", 3)).toEqual(["us-east", "eu-central"]);
    expect(toggleRegion(["us-east", "eu-central", "ap-southeast"], "us-west", 3)).toEqual(["us-east", "eu-central", "ap-southeast"]);
  });
  it("falls back to auto when the last one is switched off", () => {
    expect(toggleRegion(["us-east"], "us-east", 3)).toEqual(["auto"]);
    expect(toggleRegion(["us-east", "eu-central"], "us-east", 3)).toEqual(["eu-central"]);
  });
});

describe("regionRunState", () => {
  it("shows a drained probe without confusing its historical uptime with a current check", () => {
    const configured = ["us-east", "eu-central"];
    const drained = new Set(["eu-central"]);
    expect(regionRunState(configured, "eu-central", null, drained)).toBe("drained");
    expect(regionRunState(configured, "us-east", null, drained)).toBe("active");
    expect(regionRunState(configured, "auto", null, drained)).toBe("historical");
  });
  it("marks regions beyond a downgraded plan cap even when also drained", () => {
    const configured = ["us-east", "eu-central", "ap-southeast"];
    const drained = new Set(["eu-central", "ap-southeast"]);
    expect(regionRunState(configured, "us-east", 1, drained)).toBe("active");
    expect(regionRunState(configured, "eu-central", 1, drained)).toBe("plan-capped");
    expect(regionRunState(configured, "ap-southeast", 1, drained)).toBe("plan-capped");
    expect(regionRunState(configured, "eu-central", 2, drained)).toBe("drained");
  });
  it("does not label scheduler auto as drained, and preserves old unconfigured history", () => {
    expect(regionRunState(["auto"], "auto", 1, new Set(["auto"]))).toBe("active");
    expect(regionRunState(["us-east"], "eu-central", null, new Set(["eu-central"]))).toBe("historical");
    expect(regionRunState(["us-east", "us-east", "eu-central"], "eu-central", 1, new Set())).toBe("plan-capped");
  });
});

describe("regionLocked", () => {
  it("never locks a one-region plan, where picking replaces", () => {
    expect(regionLocked(["auto"], "us-east", 1)).toBe(false);
    expect(regionLocked(["us-east"], "eu-central", 1)).toBe(false);
  });
  it("locks the unselected options of a full multi-region selection", () => {
    const full = ["us-east", "eu-central", "ap-southeast"];
    expect(regionLocked(full, "us-west", 3)).toBe(true);
    expect(regionLocked(full, "us-east", 3)).toBe(false);
    expect(regionLocked(["us-east", "eu-central"], "us-west", 3)).toBe(false);
  });
});
