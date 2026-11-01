import { describe, expect, it } from "vitest";
import { limitedJsonBody } from "./json-body-budget";

const request = (body: BodyInit, headers?: Record<string, string>) =>
  new Request("http://localhost/api", {
    method: "POST", headers, body, duplex: "half",
  } as RequestInit & { duplex: "half" });

describe("bounded JSON request reader", () => {
  it("accepts a valid small body without cloning or consuming it twice", async () => {
    expect(await limitedJsonBody(request(JSON.stringify({ name: "Safe" })), 1024))
      .toEqual({ name: "Safe" });
    expect(await limitedJsonBody(request("{invalid"), 1024)).toBeNull();
    expect(await limitedJsonBody(new Request("http://localhost/api", { method: "POST" }), 1024)).toBeNull();
  });

  it("rejects a forged small Content-Length before JSON parse", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4096)); },
    });
    await expect(limitedJsonBody(request(stream, { "content-length": "1" }), 1024))
      .rejects.toMatchObject({ status: 413 });
  });

  it("rejects an oversized declared Content-Length without draining a hostile stream", async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(2048)); },
      cancel() { return new Promise<void>(() => {}); },
    });
    await expect(limitedJsonBody(request(stream, { "content-length": "99999999" }), 1024))
      .rejects.toMatchObject({ status: 413 });
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("does not await cancellation of an oversize stream", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2048)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const result = await Promise.race([
      limitedJsonBody(request(stream), 1024).then(() => 200, (error: { status: number }) => error.status),
      new Promise<number>(resolve => setTimeout(() => resolve(999), 200)),
    ]);
    expect(result).toBe(413);
    expect(canceled).toBe(true);
  });

  it("applies one wall-clock deadline to an incomplete body regardless of chunk pacing", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"name":')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const result = await Promise.race([
      limitedJsonBody(request(stream), 1024, 30).then(() => 200, (error: { status: number }) => error.status),
      new Promise<number>(resolve => setTimeout(() => resolve(999), 200)),
    ]);
    expect(result).toBe(408);
    expect(canceled).toBe(true);
  });
});
