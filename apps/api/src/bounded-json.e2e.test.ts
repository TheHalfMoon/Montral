import { openDatabase } from "@montral/db-pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "bounded-json-test-secret-no-real-data", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };
const app = createApp(openDatabase);

describe.skipIf(!url)("authenticated JSON body memory budgets", () => {
  let cookie = "";
  beforeAll(async () => {
    const db = openDatabase(url!);
    try { await db.migrate(); } finally { await db.close(1); }
    const signup = await app.fetch(new Request(origin + "/api/auth/sign-up/email", {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: `json-budget-${crypto.randomUUID()}@example.com`, name: "Budget", password: "correct horse battery" }),
    }), env as never);
    expect(signup.status).toBe(200);
    cookie = signup.headers.getSetCookie().map(x => x.split(";")[0]).join("; ");
  });

  const send = (method: string, path: string, data: unknown) =>
    app.fetch(new Request(origin + "/api" + path, {
      method, headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(data),
    }), env as never);

  it("refuses oversized workspace creation before writing a new workspace", async () => {
    const body = { name: "Valid workspace", padding: "x".repeat(24 * 1024) };
    expect((await send("POST", "/workspaces", body)).status).toBe(413);
  });

  it("refuses oversized locale changes before updating the user's profile", async () => {
    expect((await send("PATCH", "/me/locale", { locale: "en", padding: "x".repeat(24 * 1024) })).status).toBe(413);
  });

  it("rejects a stalled monitor import at the total read deadline without database writes", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"monitors":[')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const response = await app.fetch(new Request(origin + "/api/monitors/import", {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }), env as never);
    expect(response.status).toBe(408);
    expect(((await response.json()) as { error: string }).error).toMatch(/timed out/i);
    expect(canceled).toBe(true);
  }, 15_000);

  it("refuses oversized manual check before reading or spending credits", async () => {
    expect((await send("POST", `/monitors/${crypto.randomUUID()}/check`, { region: "auto", padding: "x".repeat(24 * 1024) })).status).toBe(413);
  });

  it("refuses oversized ordinary CRUD JSON before project or monitor writes", async () => {
    const get = async (path: string) => {
      const r = await app.fetch(new Request(origin + "/api" + path, { headers: { origin, cookie } }), env as never);
      expect(r.status).toBe(200);
      return r.json();
    };
    const before = await get("/projects");
    const padding = "x".repeat(4 * 1024 * 1024);
    expect((await send("POST", "/projects", { name: "Must not be stored", padding })).status).toBe(413);
    expect(await get("/projects")).toEqual(before);
    expect((await send("POST", "/monitors", { name: "Must not run", type: "heartbeat", padding })).status).toBe(413);
    expect(await get("/monitors")).toEqual([]);
    const valid = await send("POST", "/monitors", { name: "Valid heartbeat", type: "heartbeat" });
    expect(valid.status).toBe(201);
    const monitor = await valid.json() as { id: string };
    expect((await send("PATCH", `/monitors/${monitor.id}`, { paused: true })).status).toBe(200);
  });
});
