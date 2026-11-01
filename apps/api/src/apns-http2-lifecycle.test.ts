import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APNS_RESPONSE_MAX_BYTES, sendHttp2Request } from "./apns";

const request = { host: "api.push.apple.com", path: "/3/device/synthetic", headers: { authorization: "bearer synthetic" }, body: "{}" };

function fakeRequest() {
  const stream = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    end: vi.fn(),
  });
  const session = { request: vi.fn(() => stream) };
  return { stream, session };
}

afterEach(() => { vi.useRealTimers(); });

describe("APNs Node HTTP/2 stream lifecycle", () => {
  it("rejects promptly when the response stream closes without end, even after valid status/data", async () => {
    vi.useFakeTimers();
    const { stream, session } = fakeRequest();
    const pending = sendHttp2Request(session, request);
    const rejected = vi.fn();
    void pending.catch(rejected);
    stream.emit("response", { ":status": 410 });
    stream.emit("data", Buffer.from('{"reason":"Unregistered"'));
    stream.emit("close");
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(rejected.mock.calls[0][0])).toMatch(/closed|aborted|incomplete/i);
    expect(stream.close).toHaveBeenCalledOnce();
    // Incomplete provider data must never be mistaken for a 410 dead-device decision.
  });

  it("rejects promptly on remote aborted, and does not resolve if end follows", async () => {
    vi.useFakeTimers();
    const { stream, session } = fakeRequest();
    const pending = sendHttp2Request(session, request);
    const rejected = vi.fn();
    void pending.catch(rejected);
    stream.emit("aborted");
    stream.emit("end");
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("honors 64 KiB in Node HTTP/2 and never resolves an oversized 410", async () => {
    const { stream, session } = fakeRequest();
    const pending = sendHttp2Request(session, request);
    stream.emit("response", { ":status": 410 });
    stream.emit("data", Buffer.alloc(APNS_RESPONSE_MAX_BYTES, 65));
    stream.emit("data", Buffer.from("!"));
    stream.emit("end");
    await expect(pending).rejects.toThrow(/64 KiB limit/);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("preserves small complete UTF-8 split HTTP/2 responses", async () => {
    const { stream, session } = fakeRequest();
    const pending = sendHttp2Request(session, request);
    const body = Buffer.from('{"reason":"BadDeviceToken","note":"é🎯"}');
    stream.emit("response", { ":status": 400 });
    stream.emit("data", body.subarray(0, body.length - 2));
    stream.emit("data", body.subarray(body.length - 2));
    stream.emit("end");
    await expect(pending).resolves.toEqual({ status: 400, body: body.toString("utf8") });
    expect(stream.close).not.toHaveBeenCalled();
  });
});
