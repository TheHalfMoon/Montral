import { describe, expect, it, vi } from "vitest";
import { createNodeTickGate } from "./node-tick-gate";

const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe("self-hosted Node scheduler tick shutdown gate", () => {
  it("awaits the active tick and never admits another after stop", async () => {
    const gate = createNodeTickGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    expect(gate.start(async () => {
      seen.push("started");
      await blocked;
      seen.push("completed");
    })).toBe(true);
    expect(gate.start(async () => { seen.push("overlap"); })).toBe(false);
    await settle();
    expect(seen).toEqual(["started"]);
    let stopped = false;
    const drain = gate.stopAndWait().then(() => { stopped = true; });
    expect(gate.start(async () => { seen.push("after stop"); })).toBe(false);
    await settle();
    expect(stopped).toBe(false);
    release();
    await drain;
    expect(stopped).toBe(true);
    expect(seen).toEqual(["started", "completed"]);
    expect(gate.start(async () => { seen.push("later"); })).toBe(false);
    await gate.stopAndWait();
  });

  it("honors stop even if the admitted task has not yet begun", async () => {
    const gate = createNodeTickGate();
    const seen: string[] = [];
    expect(gate.start(async () => { seen.push("admitted"); })).toBe(true);
    const stop = gate.stopAndWait();
    expect(gate.start(async () => { seen.push("not admitted"); })).toBe(false);
    await stop;
    expect(seen).toEqual(["admitted"]);
  });

  it("suppresses sensitive tick errors, clears admission and stops cleanly", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const gate = createNodeTickGate();
      expect(gate.start(async () => { throw new Error("synthetic-secret-token"); })).toBe(true);
      await settle();
      expect(log.mock.calls.flat().join(" ")).not.toContain("synthetic-secret-token");
      const seen: string[] = [];
      expect(gate.start(async () => { seen.push("retry"); })).toBe(true);
      await gate.stopAndWait();
      expect(seen).toEqual(["retry"]);
    } finally {
      log.mockRestore();
    }
  });

  it("can be stopped without ever starting a tick", async () => {
    const gate = createNodeTickGate();
    await gate.stopAndWait();
    expect(gate.start(async () => {})).toBe(false);
  });
});