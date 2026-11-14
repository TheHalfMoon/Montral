import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zValidator } from "./bounded-validator";

const LIMIT = 4 * 1024 * 1024;
const app = new Hono()
  .post("/project", zValidator("json", z.object({ name: z.string().max(80) })), (c) => c.json(c.req.valid("json"), 201))
  .get("/query", zValidator("query", z.object({ q: z.string() })), (c) => c.json(c.req.valid("query")));
const streamRequest = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request("http://localhost/project", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: stream, duplex: "half" } as RequestInit);

afterEach(() => vi.useRealTimers());

describe("bounded JSON validator", () => {
  it.each([{}, { "content-length": "1" }] as Record<string, string>[])("refuses chunked oversized JSON before schema parsing (%j)", async (headers) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "Valid", ignored: "x".repeat(LIMIT) }));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); }, cancel });
    expect((await app.fetch(streamRequest(stream, headers))).status).toBe(413);
  });

  it("bounds total upload time without waiting for hostile cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"name":')); }, cancel });
    let status: number | undefined;
    const pending = Promise.resolve(app.fetch(streamRequest(stream))).then((r) => { status = r.status; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(status).toBe(408);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps native successful, malformed, schema-error and query behavior", async () => {
    const send = (body: string) => app.request("/project", { method: "POST", headers: { "content-type": "application/json" }, body });
    const good = await send('{"name":"Valid"}');
    expect(good.status).toBe(201);
    expect(await good.json()).toEqual({ name: "Valid" });
    for (const raw of ["{", "", '{"name":42}']) expect((await send(raw)).status).toBe(400);
    expect(await (await app.request("/query?q=normal")).json()).toEqual({ q: "normal" });
  });

  it("counts UTF-8 bytes at the exact ceiling, including JSON framing", async () => {
    const fixed = JSON.stringify({ name: "Valid", ignored: "" });
    const remainder = LIMIT - new TextEncoder().encode(fixed).length;
    const ignored = "é".repeat(Math.floor(remainder / 2)) + (remainder % 2 ? "x" : "");
    const exact = JSON.stringify({ name: "Valid", ignored });
    expect(new TextEncoder().encode(exact).length).toBe(LIMIT);
    const send = (body: string) => app.request("/project", { method: "POST", headers: { "content-type": "application/problem+json; charset=utf-8" }, body });
    expect((await send(exact)).status).toBe(201);
    expect((await send(JSON.stringify({ name: "Valid", ignored: ignored + "x" }))).status).toBe(413);
  });

  it("refuses an oversized declared length without reading or waiting for cancellation", async () => {
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel: () => new Promise<void>(() => {}) }, { highWaterMark: 0 });
    expect((await app.fetch(streamRequest(stream, { "content-length": String(LIMIT + 1) }))).status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
  });

  it("forwards async hooks and custom validation options", async () => {
    const custom = vi.fn(async (schema: z.ZodType, value: unknown) => schema.safeParseAsync(value));
    const hooked = new Hono().post("/", zValidator("json", z.object({ name: z.string() }), async (result, c) => {
      await Promise.resolve();
      if (!result.success) return c.json({ error: "Custom validation error" }, 422);
    }, { validationFunction: custom }), (c) => c.json(c.req.valid("json")));
    const send = (body: unknown) => hooked.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await send({ name: "Normal" })).json()).toEqual({ name: "Normal" });
    expect((await send({ name: 42 })).status).toBe(422);
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("keeps failed upload streams a private malformed-JSON refusal", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("private-upload-error")); } });
    const res = await app.fetch(streamRequest(stream));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("private-upload-error");
  });

  it("keeps production validator imports behind the shared byte/deadline gate", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const bypasses = readdirSync(root, { recursive: true }).filter((entry): entry is string => typeof entry === "string"
      && entry.endsWith(".ts") && !entry.endsWith(".test.ts") && entry !== "bounded-validator.ts")
      .filter((entry) => /from\s+["']@hono\/zod-validator["']/.test(readFileSync(join(root, entry), "utf8")));
    expect(bypasses).toEqual([]);
  });
});
