import { describe, expect, it } from "vitest";
import { manualCheckGate } from "./manual-check-gate";

describe("manual check gate", () => {
  it("admits up to the maximum, refuses beyond it, and frees a slot on release", () => {
    const gate = manualCheckGate(2);
    const a = gate.tryEnter();
    const b = gate.tryEnter();
    expect(a && b).toBeTruthy();
    expect(gate.tryEnter()).toBeNull();
    a!();
    expect(gate.inFlight()).toBe(1);
    const c = gate.tryEnter();
    expect(c).toBeTruthy();
    expect(gate.tryEnter()).toBeNull();
  });

  it("ignores a second release of the same slot (cannot push the count below the real number)", () => {
    const gate = manualCheckGate(1);
    const a = gate.tryEnter()!;
    a();
    a();
    expect(gate.inFlight()).toBe(0);
    const b = gate.tryEnter();
    expect(b).toBeTruthy();
    expect(gate.tryEnter()).toBeNull();
  });
});
