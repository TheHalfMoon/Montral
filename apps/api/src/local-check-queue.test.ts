import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalCheckQueue, claimsForUnstarted, LOCAL_CHECK_QUEUE_CAPACITY } from "./local-check-queue";
import type { CheckMessage } from "./scheduler";

const msg = (id: string, delaySeconds = 0) => ({
  body: { ids: [id] } satisfies CheckMessage,
  delaySeconds,
});

describe("self-hosted Node queue backpressure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reserves slots for running and ready work; rejects an entire overloaded batch", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const seen: string[] = [];
    const queue = createLocalCheckQueue(async (message) => {
      seen.push(message.ids[0]);
      if (message.ids[0] === "one") await gate;
    }, { maxPending: 2, concurrency: 1 });

    await queue.sendBatch([msg("one"), msg("two")]);
    expect(queue.pendingCount()).toBe(2);
    await expect(queue.sendBatch([msg("three"), msg("four")]))
      .rejects.toThrow("Local check queue capacity exceeded");
    expect(queue.pendingCount()).toBe(2);
    await vi.waitFor(() => expect(seen).toEqual(["one"]));

    unblock();
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
    expect(seen).toEqual(["one", "two"]);
    await queue.sendBatch([msg("three")]);
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
    expect(seen).toEqual(["one", "two", "three"]);
  });

  it("exposes the oldest running handler age without counting delayed or completed work", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const second = new Promise<void>((resolve) => { finishSecond = resolve; });
    const started: string[] = [];
    let clock = 1000;
    const queue = createLocalCheckQueue(async (message) => {
      started.push(message.ids[0]);
      await (message.ids[0] === "first" ? first : second);
    }, { maxPending: 3, concurrency: 2, now: () => clock });

    expect(queue.oldestRunningAgeMs()).toBe(0);
    await queue.sendBatch([msg("first")]);
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    clock = 1100;
    await queue.sendBatch([msg("second")]);
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    clock = 1800;
    expect(queue.oldestRunningAgeMs()).toBe(800);
    finishFirst();
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(1));
    expect(queue.oldestRunningAgeMs()).toBe(700);
    finishSecond();
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
    expect(queue.oldestRunningAgeMs()).toBe(0);
  });
  it("counts delayed timers towards the same limit, then frees capacity", async () => {
    const seen: string[] = [];
    const queue = createLocalCheckQueue(async (message) => {
      seen.push(message.ids[0]);
    }, { maxPending: 1 });
    await queue.sendBatch([msg("delayed", 0.03)]);
    expect(queue.oldestRunningAgeMs()).toBe(0);
    expect(queue.pendingCount()).toBe(1);
    await expect(queue.sendBatch([msg("rejected")]))
      .rejects.toThrow("Local check queue capacity exceeded");
    expect(seen).toEqual([]);
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0), { timeout: 2000 });
    expect(seen).toEqual(["delayed"]);
  });

  it("validates every message before reserving any part of its batch", async () => {
    const queue = createLocalCheckQueue(async () => {}, { maxPending: 3 });
    await expect(queue.sendBatch([msg("valid"), msg("bad", Number.POSITIVE_INFINITY)]))
      .rejects.toThrow("Invalid local check queue batch");
    await expect(queue.sendBatch([msg("valid"), msg("bad", -1)]))
      .rejects.toThrow("Invalid local check queue batch");
    expect(queue.pendingCount()).toBe(0);
    await queue.sendBatch([msg("valid")]);
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
  });

  it("frees capacity after a rejected or synchronously throwing handler without logging secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "synthetic-secret-private-probe-url";
    const seen: string[] = [];
    const queue = createLocalCheckQueue((message) => {
      seen.push(message.ids[0]);
      if (message.ids[0] === "fail") throw new Error(secret);
      return Promise.resolve();
    }, { maxPending: 1 });
    await queue.sendBatch([msg("fail")]);
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
    await queue.sendBatch([msg("recover")]);
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
    expect(seen).toEqual(["fail", "recover"]);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("rejects invalid capacity settings and keeps production bounds finite", () => {
    expect(LOCAL_CHECK_QUEUE_CAPACITY).toBeGreaterThan(0);
    expect(Number.isSafeInteger(LOCAL_CHECK_QUEUE_CAPACITY)).toBe(true);
    expect(() => createLocalCheckQueue(async () => {}, { maxPending: 0 })).toThrow();
    expect(() => createLocalCheckQueue(async () => {}, { maxPending: 1, concurrency: 2 })).toThrow();
    expect(() => createLocalCheckQueue(async () => {}, { maxPending: Number.POSITIVE_INFINITY })).toThrow();
  });
  it("returns only ready and delayed leased work on shutdown, drains running work", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const queue = createLocalCheckQueue(async (message) => {
      seen.push(message.ids[0]);
      if (message.ids[0] === "running") await blocked;
    }, { maxPending: 3, concurrency: 1 });
    const at = "2026-11-07T03:00:00.000Z";
    await queue.sendBatch([
      { body: { ids: ["running"], at: [at] } },
      { body: { ids: ["ready"], at: [at] } },
      { body: { ids: ["delayed"], at: [at] }, delaySeconds: 0.05 },
    ]);
    await vi.waitFor(() => expect(seen).toEqual(["running"]));
    expect(queue.pendingCount()).toBe(3);
    const unstarted = queue.stopAndTakeUnstarted();
    expect(unstarted.map((m) => m.ids[0])).toEqual(["ready", "delayed"]);
    expect(claimsForUnstarted(unstarted)).toEqual([
      { id: "ready", token: new Date(at) },
      { id: "delayed", token: new Date(at) },
    ]);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.stopAndTakeUnstarted()).toEqual([]);
    await expect(queue.sendBatch([msg("new")])).rejects.toThrow("shutting down");
    const draining = queue.waitForRunning(500);
    release();
    expect(await draining).toBe(true);
    expect(queue.pendingCount()).toBe(0);
    await new Promise((r) => setTimeout(r, 90));
    expect(seen).toEqual(["running"]); // delayed callback was canceled
  });

  it("times out a stuck running handler without releasing or duplicating its claim", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const queue = createLocalCheckQueue(async (message) => {
      seen.push(message.ids[0]);
      await blocked;
    });
    await queue.sendBatch([{ body: { ids: ["running"], at: ["2026-11-07T03:00:00.000Z"] } }]);
    await vi.waitFor(() => expect(seen).toEqual(["running"]));
    expect(queue.stopAndTakeUnstarted()).toEqual([]);
    expect(queue.pendingCount()).toBe(1);
    expect(await queue.waitForRunning(15)).toBe(false);
    expect(queue.pendingCount()).toBe(1);
    release();
    await vi.waitFor(() => expect(queue.pendingCount()).toBe(0));
    expect(await queue.waitForRunning(0)).toBe(true);
    await expect(queue.waitForRunning(-1)).rejects.toThrow("shutdown deadline");
  });

  it("never invents missing, malformed or mismatched lease tokens on shutdown", () => {
    const at = "2026-11-07T03:00:00.000Z";
    expect(claimsForUnstarted([
      { ids: ["legacy"] },
      { ids: ["incomplete", "misaligned"], at: [at] },
      { ids: ["malformed"], at: ["not-a-date"] },
      { ids: ["valid"], at: [at] },
    ])).toEqual([{ id: "valid", token: new Date(at) }]);
  });
});
