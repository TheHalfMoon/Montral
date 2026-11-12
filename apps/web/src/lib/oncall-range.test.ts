import { describe, expect, it, vi } from "vitest";
import { oncallOverrideRange } from "./oncall-range";

describe("on-call override range", () => {
  it("never exceeds the API's exact 90-day millisecond limit", () => {
    for (const now of [Date.UTC(2026, 0, 1), Date.UTC(2026, 10, 12, 23, 59, 59, 999), Date.UTC(2028, 1, 29), 2_000_000_000_000]) {
      const { from, to } = oncallOverrideRange(now);
      expect(new Date(to).getTime() - new Date(from).getTime()).toBe(90 * 86_400_000);
      expect(new Date(from).toISOString()).toBe(from);
      expect(new Date(to).toISOString()).toBe(to);
    }
  });

  it("reads the current clock once, never as two drifting instants", () => {
    const spy = vi.spyOn(Date, "now").mockImplementationOnce(() => 2_000_000_000_000)
      .mockImplementationOnce(() => 2_000_000_000_023);
    try {
      const { from, to } = oncallOverrideRange();
      expect(new Date(to).getTime() - new Date(from).getTime()).toBe(90 * 86_400_000);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
