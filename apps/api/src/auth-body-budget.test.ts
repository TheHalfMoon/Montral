import { describe, expect, it } from "vitest";
import { limitedAuthBody } from "./auth-body-budget";

describe("auth email quota body budget", () => {
  it("rejects 32 KiB of synthetic JSON without parsing it", async () => {
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "test@example.test", padding: "x".repeat(32 * 1024) }) });
    expect(await limitedAuthBody(req)).toEqual({ oversized: true });
  });
  it("rejects a forged short content length when the stream actually exceeds the budget", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(8192).fill(88)); },
    });
    const req = new Request("http://localhost", {
      method: "POST", headers: { "content-length": "1" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(await limitedAuthBody(req)).toEqual({ oversized: true });
  });

  it("rejects an explicit huge content-length before consuming any bytes", async () => {
    let reads = 0;
    const req = new Request("http://localhost", {
      method: "POST", headers: { "content-length": "99999999" },
      body: new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(10)); } }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(await limitedAuthBody(req)).toEqual({ oversized: true });
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("does not wait forever for a slow email-auth body whose cancellation never settles", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const req = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const outcome = await Promise.race([
      limitedAuthBody(req, 30).then(() => "accepted", (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-stalled"), 160)),
    ]);
    expect(outcome).toBe("Authentication body read timeout");
    expect(canceled).toBe(true);
  });

  it("keeps small normal requests available to downstream handlers", async () => {
    const body = JSON.stringify({ email: "test@example.test" });
    const req = new Request("http://localhost", { method: "POST", body });
    expect(await limitedAuthBody(req)).toEqual({ oversized: false, email: "test@example.test" });
    expect(await req.text()).toBe(body);
  });
});
