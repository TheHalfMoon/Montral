/**
 * Browser monitors through the API on real PostgreSQL: creation and validation, write-only secrets (never returned, not
 * even to owners, nor in exports or audit events), member permissions, Workers / disabled refusals, and a real run
 * recorded with its steps and screenshot, visible only within the workspace.
 *
 * The parts that create monitors need a Chromium (creation verifies the server can start one): they run where one is
 * available and are required in the browser-checks CI job (BROWSER_CHECK_TESTS=required).
 */
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { openDatabase } from "@montral/db-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { BROWSER_MIN_INTERVAL_SEC, configureBrowserChecks, resetBrowserAvailability, setBrowserTestAllowance } from "./browser-check";
import { MASK } from "./secrets";
import { sendUncheckedDigests } from "./scheduler";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const pw = await import("playwright-core").catch(() => null);
const explicit = process.env.BROWSER_EXECUTABLE_PATH;
const exe = explicit || pw?.chromium.executablePath() || "";
const haveChromium = !!pw && !!exe && existsSync(exe);
const required = process.env.BROWSER_CHECK_TESTS === "required";
const SECRET_VALUE = `pw-${crypto.randomUUID()}`;
const base = { DATABASE_URL: url, BETTER_AUTH_SECRET: "browser-check-e2e-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

type Call = (cookie: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; text: string; cookie: string; headers: Headers }>;

function harness(env: Record<string, string | undefined>) {
  const db = openDatabase(url!, { max: 2 });
  const app = createApp(openDatabase);
  const call: Call = async (cookie, method, path, body) => {
    const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
    const text = r.headers.get("content-type")?.includes("json") ? await r.text() : "";
    return { status: r.status, body: text ? JSON.parse(text) : null, text, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), headers: r.headers };
  };
  const signup = async () => {
    const r = await call("", "POST", "/auth/sign-up/email", { email: `browser-${crypto.randomUUID()}@example.com`, name: "Browser", password: "correct horse battery" });
    expect(r.status).toBe(200);
    return { id: r.body.user.id as string, cookie: r.cookie };
  };
  return { db, call, signup };
}

const journey = (start: string) => ({
  steps: [
    { action: "goto", url: `${start}/login` },
    { action: "fill", selector: "#user", value: "alice" },
    { action: "fill", selector: "#pass", secretRef: "password" },
    { action: "click", selector: "#submit" },
    { action: "assertText", selector: "#greeting", contains: "Welcome", timeoutMs: 3000 },
  ],
  timeoutMs: 20000,
  screenshot: "on_failure",
});

describe.skipIf(!url)("browser monitors refused where they cannot run (PostgreSQL)", () => {
  it("refuses creation with 400 when browser checks are not enabled, and on Cloudflare Workers", async () => {
    const { db, call, signup } = harness(base);
    try {
      await db.migrate();
      const owner = await signup();
      expect(await call(owner.cookie, "POST", "/monitors", { name: "Journey", type: "browser", browser: journey("https://example.com") }))
        .toMatchObject({ status: 400, body: { code: "browser_checks_disabled" } });
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      try {
        expect(await call(owner.cookie, "POST", "/monitors", { name: "Journey", type: "browser", browser: journey("https://example.com") }))
          .toMatchObject({ status: 400, body: { code: "browser_checks_unsupported", error: expect.stringMatching(/^Browser checks need the self-hosted Node runtime/) } });
      } finally {
        vi.unstubAllGlobals();
      }
      // malformed journeys never reach the runtime check
      for (const browser of [{ steps: [] }, { steps: [{ action: "click", selector: "#a" }] }, { steps: [{ action: "goto", url: "file:///etc/passwd" }] }, { steps: [{ action: "goto", url: "https://example.com" }, { action: "evaluate", script: "1" }] }]) {
        expect((await call(owner.cookie, "POST", "/monitors", { name: "Bad", type: "browser", browser })).status, JSON.stringify(browser)).toBe(400);
      }
      // browser fields on another type are refused
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Http", type: "http", target: "https://1.1.1.1/", browserSecrets: { a: "b" } })).status).toBe(400);
    } finally {
      configureBrowserChecks({});
      await db.close(2);
    }
  });
});

describe("browser API tests need Chromium", () => {
  it.runIf(required && !!url)("Chromium is installed (BROWSER_CHECK_TESTS=required)", () => expect(haveChromium).toBe(true));
});

describe.skipIf(!url || !haveChromium)("browser monitors through the API (PostgreSQL + Chromium)", () => {
  let site: Server;
  let start = "";
  beforeAll(async () => {
    site = createServer((req, res) => {
      const page = (b: string, status = 200) => { res.writeHead(status, { "content-type": "text/html" }); res.end(`<!doctype html><body>${b}</body>`); };
      if (req.url === "/login" && req.method === "POST") {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
          const f = new URLSearchParams(body);
          if (f.get("pass") === SECRET_VALUE) { res.writeHead(302, { location: "/home", "set-cookie": "s=1; Path=/" }); res.end(); } else page(`<p id="bad">no</p>`, 401);
        });
        return;
      }
      if (req.url === "/login") return page(`<form method="post" action="/login"><input id="user" name="user"><input id="pass" name="pass"><button id="submit">Go</button></form>`);
      if (req.url === "/home") return page(`<h1 id="greeting">Welcome ${(req.headers.cookie ?? "").includes("s=1") ? "back" : "stranger"}</h1>`);
      page("x", 404);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    start = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    configureBrowserChecks({});
    setBrowserTestAllowance(undefined);
    await new Promise((r) => site.close(r));
  });

  it("creates, validates, never returns secrets, enforces member permissions, audits and records runs", async () => {
    // The synthetic site is on loopback, which browser checks never reach, not even with the private opt-ins below:
    // the test seam allows exactly its ip:port. ALLOW_PRIVATE_TARGETS and BROWSER_CHECK_ALLOW_PRIVATE_TARGETS are on to
    // prove loopback, metadata and this server's own addresses stay refused regardless.
    const env = { ...base, BROWSER_CHECKS: "enabled", BROWSER_EXECUTABLE_PATH: explicit, ALLOW_PRIVATE_TARGETS: "true", BROWSER_CHECK_ALLOW_PRIVATE_TARGETS: "true" };
    resetBrowserAvailability();
    setBrowserTestAllowance([start.replace("http://", "")]);
    const { db, call, signup } = harness(env);
    try {
      await db.migrate();
      const owner = await signup();
      const member = await signup();
      const orgId = (await call(owner.cookie, "GET", "/me")).body.organization.id;
      await db.query(`insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, 'member', now())`, [crypto.randomUUID(), orgId, member.id]);
      member.cookie = (await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId })).cookie || member.cookie;

      // a journey that uses a secret it does not have is refused
      expect(await call(owner.cookie, "POST", "/monitors", { name: "Journey", type: "browser", browser: journey(start) })).toMatchObject({ status: 400, body: { code: "browser_secret_missing" } });
      // limits
      const many = { steps: [{ action: "goto", url: `${start}/login` }, ...Array.from({ length: 20 }, () => ({ action: "click", selector: "#submit" }))] };
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Long", type: "browser", browser: many })).status).toBe(400);
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Slow", type: "browser", browser: { ...journey(start), timeoutMs: 61_000 } })).status).toBe(400);
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Engine", type: "browser", browser: { steps: [{ action: "goto", url: start }, { action: "click", selector: "internal:role=button" }] } })).status).toBe(400);
      // metadata, loopback (other ports) and localhost are never targets, even with both private opt-ins
      for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:1/", "http://[::1]:8080/", "http://localhost:8080/", "http://[::ffff:127.0.0.1]:9/"]) {
        expect(await call(owner.cookie, "POST", "/monitors", { name: "Refused", type: "browser", browser: { steps: [{ action: "goto", url }] } }), url).toMatchObject({ status: 400 });
      }

      const created = await call(owner.cookie, "POST", "/monitors", { name: "Journey", type: "browser", browser: journey(start), browserSecrets: { password: SECRET_VALUE } });
      expect(created).toMatchObject({ status: 201, body: { type: "browser", target: `${start}/login`, browserSecrets: { password: MASK }, regions: ["auto"] } });
      // browser checks run at most every 5 minutes (asked for 60 s by default)
      expect(created.body.intervalSec).toBe(BROWSER_MIN_INTERVAL_SEC);
      expect(created.text).not.toContain(SECRET_VALUE);
      const id = created.body.id as string;
      const path = `/monitors/${id}`;
      expect((await call(owner.cookie, "PATCH", path, { intervalSec: 60 })).body.intervalSec).toBe(BROWSER_MIN_INTERVAL_SEC);
      // the ciphertext is bound to this monitor: copied onto another monitor it does not decrypt (checked at run time below)
      // stored encrypted, never in plaintext
      const [row] = await db.query<{ browser_secrets: Record<string, string> }>("select browser_secrets from monitor where id = $1", [id]);
      expect(row.browser_secrets.password).toMatch(/^v1\./);
      expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);

      // never returned: not to the owner, not to members, not in lists or exports
      for (const who of [owner, member]) {
        const one = await call(who.cookie, "GET", path);
        expect(one.body.browserSecrets).toEqual({ password: MASK });
        expect(one.text).not.toContain("v1.");
        const list = await call(who.cookie, "GET", "/monitors");
        expect(list.text).not.toContain(SECRET_VALUE);
        expect(list.text).not.toContain(row.browser_secrets.password);
        const exported = await call(who.cookie, "GET", "/monitors/export");
        expect(exported.text).not.toContain(SECRET_VALUE);
        expect(exported.body.monitors.find((m: any) => m.name === "Journey").browserSecrets).toBeUndefined();
      }

      // a member cannot point the journey elsewhere while keeping the stored secret...
      const moved = { ...journey(start), steps: [...journey(start).steps.slice(0, 4), { action: "assertText", contains: "x" }] };
      expect(await call(member.cookie, "PATCH", path, { browser: moved })).toMatchObject({ status: 403, body: { code: "protected_browser_secrets" } });
      expect(await call(member.cookie, "PATCH", path, { browser: moved, browserSecrets: { password: MASK } })).toMatchObject({ status: 403, body: { code: "protected_browser_secrets" } });
      // ...but may rename, replace the secret with their own value, or change the journey with a new value
      expect((await call(member.cookie, "PATCH", path, { name: "Renamed" })).status).toBe(200);
      expect((await call(member.cookie, "PATCH", path, { browser: moved, browserSecrets: { password: "member-supplied" } })).status).toBe(200);
      // the owner restores the real value and journey; masks keep stored values, unknown names are refused
      expect((await call(owner.cookie, "PATCH", path, { browser: journey(start), browserSecrets: { password: SECRET_VALUE } })).status).toBe(200);
      expect((await call(owner.cookie, "PATCH", path, { browserSecrets: { password: MASK } })).status).toBe(200);
      expect(await call(owner.cookie, "PATCH", path, { browserSecrets: {} })).toMatchObject({ status: 400, body: { code: "browser_secret_missing" } });
      expect((await call(owner.cookie, "PATCH", path, { target: "https://example.com/" })).status).toBe(400);
      const [after] = await db.query<{ browser_secrets: Record<string, string> }>("select browser_secrets from monitor where id = $1", [id]);
      expect(after.browser_secrets.password).toMatch(/^v1\./);

      // import cannot create browser monitors (secrets and runtime checks happen on create only)
      const preview = await call(owner.cookie, "POST", "/monitors/import/preview", { monitors: [{ sourceId: "b1", name: "B", type: "browser", browser: journey(start) }] });
      expect(preview.body.report[0].error).toMatch(/cannot be imported/);

      // no spot check for browser monitors: it would hand back the run (and its screenshot) outside the run history
      for (const region of ["auto", "us-east"]) {
        expect(await call(member.cookie, "POST", `${path}/check`, { region }), region).toMatchObject({ status: 400, body: { code: "regions_not_supported" } });
      }

      // one real run through "check now", recorded with its steps
      expect((await call(owner.cookie, "POST", `${path}/check`, {})).status).toBe(200);
      const runs = await call(member.cookie, "GET", `${path}/browser-runs`);
      expect(runs.status).toBe(200);
      expect(runs.body.runs[0]).toMatchObject({ ok: true, failedStep: null, error: null, hasScreenshot: false });
      expect(runs.body.runs[0].steps.map((s: any) => s.action)).toEqual(["goto", "fill", "fill", "click", "assertText"]);
      expect((await call(owner.cookie, "GET", path)).body).toMatchObject({ status: "up" });

      // a failing run keeps a screenshot; this journey uses a secret, so it is for owners and admins only
      expect((await call(owner.cookie, "PATCH", path, { browserSecrets: { password: "wrong-value" } })).status).toBe(200);
      expect((await call(owner.cookie, "POST", `${path}/check`, {})).status).toBe(200);
      const failed = (await call(owner.cookie, "GET", `${path}/browser-runs`)).body.runs[0];
      expect(failed).toMatchObject({ ok: false, failedStep: 4, error: "Step 5 (assertText): element not found", hasScreenshot: true });
      const shot = await call(owner.cookie, "GET", `${path}/browser-runs/${failed.id}/screenshot`);
      expect(shot.status).toBe(200);
      expect(shot.headers.get("content-type")).toBe("image/png");
      expect(shot.headers.get("cache-control")).toContain("no-store");
      // members get the run, never the screenshot
      const memberRuns = (await call(member.cookie, "GET", `${path}/browser-runs`)).body.runs;
      expect(memberRuns[0]).toMatchObject({ id: failed.id, ok: false, failedStep: 4, hasScreenshot: false });
      expect(await call(member.cookie, "GET", `${path}/browser-runs/${failed.id}/screenshot`)).toMatchObject({ status: 403, body: { code: "screenshot_managers_only" } });
      // authorization follows the run, not the monitor's current settings: the owner changes the journey so it no longer
      // types the secret (secrets still stored), and the old screenshot stays managers-only
      const noSecretJourney = { ...journey(start), steps: [{ action: "goto", url: `${start}/login` }, { action: "assertText", selector: "#nope", contains: "x", timeoutMs: 1000 }] };
      expect((await call(owner.cookie, "PATCH", path, { browser: noSecretJourney })).status).toBe(200);
      expect(await call(member.cookie, "GET", `${path}/browser-runs/${failed.id}/screenshot`)).toMatchObject({ status: 403, body: { code: "screenshot_managers_only" } });
      expect((await call(member.cookie, "GET", `${path}/browser-runs`)).body.runs.find((r: any) => r.id === failed.id)).toMatchObject({ usedSecrets: true, hasScreenshot: false });
      // a member strips the secrets (allowed: nothing stored is kept) and still cannot see it: removing secrets purges the
      // screenshots of the runs that used them, for everyone
      expect((await call(member.cookie, "PATCH", path, { browserSecrets: {} })).status).toBe(200);
      expect((await call(member.cookie, "GET", `${path}/browser-runs/${failed.id}/screenshot`)).status).toBe(404);
      expect((await call(owner.cookie, "GET", `${path}/browser-runs/${failed.id}/screenshot`)).status).toBe(404);
      // an in-flight run that started before the secrets changed keeps no screenshot (the purge already ran)
      const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
      const [{ browser_secrets_version: version }] = await db.query<{ browser_secrets_version: number }>("select browser_secrets_version from monitor where id = $1", [id]);
      const lateRun = { monitorId: id, ok: false, kind: "run" as const, usedSecrets: true, failedStep: 0, error: "Step 1 (goto): timed out", durationMs: 5, steps: [], blockedRequests: 0, peakRssMb: null, cpuMs: null, screenshot: png };
      await db.repo.recordBrowserRun!({ ...lateRun, secretsVersion: version - 1 });
      expect((await call(owner.cookie, "GET", `${path}/browser-runs`)).body.runs[0]).toMatchObject({ usedSecrets: true, hasScreenshot: false });
      await db.repo.recordBrowserRun!({ ...lateRun, secretsVersion: version });
      expect((await call(owner.cookie, "GET", `${path}/browser-runs`)).body.runs[0]).toMatchObject({ usedSecrets: true, hasScreenshot: true });

      // a run that typed no secret keeps its screenshot visible to members
      expect((await call(owner.cookie, "POST", `${path}/check`, {})).status).toBe(200);
      const plainRun = (await call(member.cookie, "GET", `${path}/browser-runs`)).body.runs[0];
      expect(plainRun).toMatchObject({ kind: "run", ok: false, usedSecrets: false, hasScreenshot: true });
      expect((await call(member.cookie, "GET", `${path}/browser-runs/${plainRun.id}/screenshot`)).status).toBe(200);
      expect((await call(owner.cookie, "PATCH", path, { browser: journey(start), browserSecrets: { password: SECRET_VALUE } })).status).toBe(200);

      // the browser runtime fails (runner unreachable): runs are recorded as errors, after 3 the monitor is unchecked and
      // owners and admins are told once; the runtime state is visible to members
      const statusBefore = (await call(owner.cookie, "GET", path)).body.status;
      const broken = harness({ ...env, BROWSER_RUNNER_URL: "http://127.0.0.1:9", BROWSER_RUNNER_TOKEN: "unreachable-runner-token-0123456789abcdef" });
      try {
        for (let i = 0; i < 4; i++) expect((await broken.call(owner.cookie, "POST", `${path}/check`, {})).status).toBe(200);
        const errorRuns = (await broken.call(member.cookie, "GET", `${path}/browser-runs`)).body.runs.slice(0, 4);
        expect(errorRuns.map((r: any) => r.kind)).toEqual(["error", "error", "error", "error"]);
        expect(errorRuns[0]).toMatchObject({ ok: false, error: "Browser runner unreachable" });
        const shown = (await broken.call(member.cookie, "GET", path)).body;
        expect(shown.uncheckedSince).toEqual(expect.any(String));
        // the last real verdict stays (nothing about the target was learned); the dashboard shows "unchecked"
        expect(shown.status).toBe(statusBefore);
        expect((await broken.call(member.cookie, "GET", "/monitors/browser-runtime")).body).toMatchObject({ enabled: true, mode: "runner", available: false, lastError: "Browser runner unreachable" });
        // owners and admins hear about it from the next housekeeping pass: one digest for the workspace
        await sendUncheckedDigests(db.repo);
        await sendUncheckedDigests(db.repo);
        const notices = await db.query<{ kind: string; status: string; status_message: string }>("select kind, status, status_message from alert_delivery where organization_id = $1 and kind = 'monitor.unchecked'", [orgId]);
        expect(notices).toHaveLength(1);
        expect(notices[0].status_message).toContain("Browser runner unreachable");
      } finally {
        await broken.db.close(2);
      }
      // the runtime is back: a real run clears the unchecked state
      expect((await call(owner.cookie, "POST", `${path}/check`, {})).status).toBe(200);
      expect((await call(member.cookie, "GET", path)).body.uncheckedSince).toBeNull();

      // the ciphertext is bound to this monitor: copied onto another monitor it is "not set" there
      const twin = await call(owner.cookie, "POST", "/monitors", { name: "Twin", type: "browser", browser: journey(start), browserSecrets: { password: "twin-value" } });
      expect(twin.status).toBe(201);
      const [cipher] = await db.query<{ browser_secrets: Record<string, string> }>("select browser_secrets from monitor where id = $1", [id]);
      await db.query("update monitor set browser_secrets = $1 where id = $2", [JSON.stringify(cipher.browser_secrets), twin.body.id]);
      expect((await call(owner.cookie, "POST", `/monitors/${twin.body.id}/check`, {})).status).toBe(200);
      expect((await call(owner.cookie, "GET", `/monitors/${twin.body.id}/browser-runs`)).body.runs[0]).toMatchObject({ ok: false, error: "Step 3 (fill): secret is not set" });
      const stranger = await signup();
      expect((await call(stranger.cookie, "GET", `${path}/browser-runs`)).status).toBe(404);
      expect((await call(stranger.cookie, "GET", `${path}/browser-runs/${failed.id}/screenshot`)).status).toBe(404);
      const results = (await call(owner.cookie, "GET", path)).body.results as { error: string | null }[];
      expect(JSON.stringify(results)).not.toContain("wrong-value");

      // audit: field names only, never secret values or ciphertext
      const [events] = [await db.query<{ action: string; changes: unknown }>("select action, changes from audit_event where organization_id = $1 order by created_at", [orgId])];
      const text = JSON.stringify(events);
      expect(events.some((e) => e.action === "monitor.create")).toBe(true);
      expect(text).toContain("browserSecrets");
      for (const leaked of [SECRET_VALUE, "member-supplied", "wrong-value", "v1."]) expect(text).not.toContain(leaked);

      // deleting the monitor deletes its runs
      expect((await call(owner.cookie, "DELETE", path)).status).toBe(204);
      const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from browser_check_run where monitor_id = $1", [id]);
      expect(n).toBe(0);
    } finally {
      await db.close(2);
    }
  }, 180_000);
});
