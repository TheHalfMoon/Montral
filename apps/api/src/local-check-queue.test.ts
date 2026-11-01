import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalCheckQueue, LOCAL_CHECK_QUEUE_CAPACITY } from "./local-check-queue";
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

  it("counts delayed timers towards the same limit, then frees capacity", async () => {
    const seen: string[] = [];
    const queue = createLocalCheckQueue(async (message) => {
      seen.push(message.ids[0]);
    }, { maxPending: 1 });
    await queue.sendBatch([msg("delayed", 0.03)]);
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
});
