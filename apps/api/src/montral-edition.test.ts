import { describe, expect, it } from "vitest";
import { MONTRAL_TOOLS } from "./montral-edition";

const tool = (name: string) => MONTRAL_TOOLS.find((t) => t.name === name)!;
const inbox = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

describe("Montral MCP webhook tools", () => {
  it("pages and filters webhook events through the REST query, encoding search text", () => {
    const events = tool("list_webhook_events");
    expect(events.readOnly).toBe(true);
    expect(events.build(events.schema.parse({ id: inbox }))).toEqual({ method: "GET", path: `/api/hooks/inboxes/${inbox}/events` });
    const built = events.build(events.schema.parse({ id: inbox, before: inbox, method: "PUT", q: "100% & more" }));
    const u = new URL("http://x" + built.path);
    expect(u.pathname).toBe(`/api/hooks/inboxes/${inbox}/events`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ before: inbox, method: "PUT", q: "100% & more" });
  });
  it("rejects filter values the REST route would refuse", () => {
    const events = tool("list_webhook_events");
    expect(events.schema.safeParse({ id: inbox, method: "GET" }).success).toBe(false);
    expect(events.schema.safeParse({ id: inbox, before: "nope" }).success).toBe(false);
    expect(events.schema.safeParse({ id: "../x" }).success).toBe(false);
  });
  it("marks inbox and event deletion as destructive and never exposes replay to agents", () => {
    expect(tool("delete_webhook_inbox").destructive).toBe(true);
    const del = tool("delete_webhook_event");
    expect(del.destructive).toBe(true);
    expect(del.build(del.schema.parse({ id: inbox, eventId: inbox }))).toEqual({ method: "DELETE", path: `/api/hooks/inboxes/${inbox}/events/${inbox}` });
    expect(del.schema.safeParse({ id: inbox, eventId: "../../x" }).success).toBe(false);
    // Replay sends outbound requests; it stays a human action in the app.
    expect(MONTRAL_TOOLS.some((t) => /replay/.test(t.name))).toBe(false);
  });
});
