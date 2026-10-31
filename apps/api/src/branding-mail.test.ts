import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@montral/repo";
import { notifyIncidentUpdate } from "./alerts";
import { actionEmail, configureEmail, setMailTransport } from "./email";
import { unmetered, type Entitlements } from "./entitlements";

const sent: { fromName: string; to: string; html: string; text: string }[] = [];
const target = (email: string, hideBranding: boolean) => ({ email, locale: "en", token: `t-${email}`, slug: "acme", title: "Acme Status", hideBranding });
const repo = {
  subscribersFor: async () => [target("hidden@example.com", true), target("shown@example.com", false)],
} as unknown as Repo;
const update = { status: "investigating", body: "Looking into it" };
const inc = { organizationId: "org", monitorId: "m1", title: "API errors" };

beforeEach(() => {
  configureEmail({ EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://app.example.com" } as never);
  setMailTransport(async (m) => void sent.push(m));
  sent.length = 0;
});
afterEach(() => setMailTransport(undefined));

describe("white-labelled mail", () => {
  it("replaces the Montral header and sender with the brand name", () => {
    const mail = actionEmail({ title: "T", body: "B", cta: "Open", url: "https://x.test", brand: "Acme Status" });
    expect(mail.html).toContain("Acme Status");
    expect(mail.html).not.toContain("logo-mark.png");
    expect(actionEmail({ title: "T", body: "B", cta: "Open", url: "https://x.test" }).html).toContain("logo-mark.png");
  });

  it("sends subscriber mail under the page title when the page hides the brand and the plan allows it", async () => {
    await notifyIncidentUpdate(repo, inc, update, unmetered);
    expect(sent.find((m) => m.to === "hidden@example.com")).toMatchObject({ fromName: "Acme Status" });
    expect(sent.find((m) => m.to === "hidden@example.com")!.html).not.toContain("logo-mark.png");
    expect(sent.find((m) => m.to === "shown@example.com")).toMatchObject({ fromName: "Acme Status via Montral" });
  });

  it("delivers incident updates with normal branding when the plan backend fails", async () => {
    const secret = "synthetic-provider-secret-DO-NOT-LOG";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const meter: Entitlements = {
      ...unmetered,
      plan: async () => { throw new Error(`Billing connection failed: ${secret}`); },
    };
    try {
      await expect(notifyIncidentUpdate(repo, inc, update, meter)).resolves.toBeUndefined();
      expect(sent.map((m) => m.to)).toEqual(["hidden@example.com", "shown@example.com"]);
      expect(sent.map((m) => m.fromName)).toEqual(["Acme Status via Montral", "Acme Status via Montral"]);
      expect(sent.every((m) => m.html.includes("logo-mark.png"))).toBe(true);
      expect(log).toHaveBeenCalledWith("subscriber branding entitlement unavailable; using Montral branding");
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { log.mockRestore(); }
  });

  it("isolates a malformed subscriber while sending a valid incident update", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { subscribersFor: async () => [null, target("healthy@example.com", false)] } as unknown as Repo;
    try {
      await expect(notifyIncidentUpdate(broken, inc, update)).resolves.toBeUndefined();
      expect(sent.map((m) => m.to)).toEqual(["healthy@example.com"]);
      expect(log).toHaveBeenCalledWith("subscriber email delivery failed");
    } finally { log.mockRestore(); }
  });

  it("keeps the Montral brand for everyone when the plan does not include hiding it", async () => {
    const basic: Entitlements = { ...unmetered, plan: async () => ({ id: "basic", name: "Basic", maxActiveMonitors: 1, minIntervalSec: 60, hideBranding: false }) };
    await notifyIncidentUpdate(repo, inc, update, basic);
    expect(sent.map((m) => m.fromName)).toEqual(["Acme Status via Montral", "Acme Status via Montral"]);
  });
});
