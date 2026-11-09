import { describe, expect, it, vi } from "vitest";
import { mounted } from "./mounted";

describe("mounted()", () => {
  it("delivers results and failures while the component is mounted", async () => {
    const life = mounted();
    const ok = vi.fn();
    const fail = vi.fn();
    await life.settle(Promise.resolve(1), ok, fail);
    await life.settle(Promise.reject(new TypeError("Failed to fetch")), ok, fail);
    expect(ok).toHaveBeenCalledWith(1);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("drops a request the browser aborted after unmount, without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const life = mounted();
      const ok = vi.fn();
      const fail = vi.fn();
      let reject!: (e: unknown) => void;
      const pending = life.settle(new Promise((_, r) => { reject = r; }), ok, fail);
      life.cancel(); // navigation unmounted the view
      reject(new TypeError("Load failed")); // WebKit's wording for the aborted fetch
      await pending;
      // and a late success is not applied to the unmounted component either
      await life.settle(Promise.resolve("late"), ok, fail);
      await new Promise((r) => setTimeout(r, 0));
      expect(ok).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(life.alive()).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("handles a rejection even when no failure callback is given", async () => {
    const life = mounted();
    await expect(life.settle(Promise.reject(new Error("x")), () => {})).resolves.toBeUndefined();
  });
});
