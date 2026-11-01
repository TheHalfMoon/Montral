import { afterEach, describe, expect, it, vi } from "vitest";
import { APNS_RESPONSE_MAX_BYTES, apnsResponseCollector, fetchTransport } from "./apns";

const request = { host: "api.push.apple.com", path: "/3/device/synthetic", headers: { authorization: "bearer fake-test-only" }, body: "{}" };

afterEach(() => vi.unstubAllGlobals());

describe("APNs fetch response body memory budget", () => {
  it("rejects and cancels an oversized streamed APNs provider response without buffering it all", async () => {
    let canceled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(40 * 1024).fill(88));
      },
      cancel() { canceled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 410 })));
    await expect(fetchTransport(request)).rejects.toThrow(/APNs response.*limit|APNs response.*large/i);
    expect(canceled).toBe(true);
    expect(reads).toBeLessThanOrEqual(3);
  });

  it("bounds byte chunks at 64 KiB even when UTF-8 code points straddle chunks", () => {
    const collector = apnsResponseCollector();
    const prefix = new TextEncoder().encode("ok 🎯");
    expect(collector.append(prefix.subarray(0, prefix.length - 1))).toBe(true);
    expect(collector.append(prefix.subarray(prefix.length - 1))).toBe(true);
    expect(collector.text()).toBe("ok 🎯");
    expect(collector.append(new Uint8Array(APNS_RESPONSE_MAX_BYTES - prefix.length))).toBe(true);
    expect(collector.append(new Uint8Array([1]))).toBe(false);
    expect(collector.text().slice(0, 5)).toBe("ok 🎯");
  });

  it("preserves a normal small UTF-8 APNs response and its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reason: "BadDeviceToken", note: "é🎯" }), { status: 400 })));
    await expect(fetchTransport(request)).resolves.toEqual({ status: 400, body: JSON.stringify({ reason: "BadDeviceToken", note: "é🎯" }) });
  });
});
