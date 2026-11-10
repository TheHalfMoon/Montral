// One signed-in user journey per engine/viewport, all with synthetic data against the disposable database: sign up,
// dashboard and skip link, a heartbeat monitor (never probes anything external), a public status page, a password
// status page (locked form, wrong password refused, right password unlocks), and a webhook inbox.
import { checkA11y, expect, synthetic, test } from "../support/fixtures";

test.use({ baseURL: process.env.MONTRAL_E2E_BASE_URL });

test("signed-in journey: monitors, status pages, password page, webhook inbox", async ({ page, context, request, baseURL, guard, browserName }, testInfo) => {
  test.setTimeout(180_000);
  const who = synthetic(testInfo);
  const monitorName = `Synthetic heartbeat ${who.id}`;
  const publicSlug = `pub-${who.id}`.slice(0, 40);
  const lockedSlug = `pw-${who.id}`.slice(0, 40);
  const lockedTitle = `Partner status ${who.id}`;
  const pagePassword = "synthetic-partner-pass";

  await test.step("sign up a new account", async () => {
    await page.goto("/signup");
    const form = page.locator("form.auth-fields");
    await form.getByLabel("Name", { exact: true }).fill("Montral Cross-browser QA");
    await form.getByLabel("Work email").fill(who.email);
    await form.locator("input[autocomplete=new-password]").fill("correct horse battery staple");
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
  });

  await test.step("dashboard renders and the skip link moves to the main content", async () => {
    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.getByRole("button", { name: /Add your first monitor|New monitor/ }).first()).toBeVisible();
    await expect(page.locator("nav.nl a[data-nav=monitors]")).toHaveAttribute("aria-current", "page");
    await checkA11y(page, testInfo, "dashboard");
    // Keyboard only: the first Tab from the top of the page reaches the skip link, which becomes visible.
    await page.locator("body").focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
    const skip = page.locator("a.skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);
    // focus moves into the main landmark, so the next Tab continues from the page content, not the sidebar
    await expect(page.locator("main#main-content")).toBeFocused();
    await expect(page.locator("main#main-content")).toBeInViewport();
  });

  await test.step("create a heartbeat monitor and see it in the list", async () => {
    await page.getByRole("button", { name: /Add your first monitor|New monitor/ }).first().click();
    const form = page.locator("form.mform");
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: /Heartbeat \(cron\)/ }).click();
    await form.getByLabel("Name", { exact: true }).fill(monitorName);
    await form.getByRole("button", { name: "Create monitor" }).click();
    await expect(form).toBeHidden();
    await expect(page.getByText(monitorName).first()).toBeVisible();
    const rows = await (await page.request.get("/api/monitors")).json() as { name: string; type: string }[];
    expect(rows.find((m) => m.name === monitorName)?.type).toBe("heartbeat");
    await page.goto("/app");
    await expect(page.getByText(monitorName).first()).toBeVisible();
    await checkA11y(page, testInfo, "monitor-list");
  });

  await test.step("create a public status page in the UI", async () => {
    await page.goto("/app/status-pages");
    await page.getByRole("button", { name: /Create a status page|New status page/ }).first().click();
    const dialog = page.locator(".modal form");
    await dialog.getByLabel("Title").fill(`Public status ${who.id}`);
    await dialog.getByLabel("Slug").fill(publicSlug);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/status-pages\/[^/]+$/);
  });

  await test.step("create a status page and protect it with a password in the UI", async () => {
    await page.goto("/app/status-pages");
    await page.getByRole("button", { name: /Create a status page|New status page/ }).first().click();
    const dialog = page.locator(".modal form");
    await dialog.getByLabel("Title").fill(lockedTitle);
    await dialog.getByLabel("Slug").fill(lockedSlug);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/status-pages\/[^/]+$/);
    await page.getByRole("radio", { name: "Password or share link" }).click();
    await expect(page.getByRole("radio", { name: "Password or share link" })).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("Page password").fill(pagePassword);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();
    // proven from the outside below: the anonymous visitor gets the 401 lock form
  });

  await test.step("create a webhook inbox, capture a synthetic event and view it", async () => {
    await page.goto("/app/hooks");
    await expect(page.locator("nav.nl a[data-nav=hooks]")).toHaveAttribute("aria-current", "page");
    await page.getByLabel("Inbox name").fill(`Synthetic inbox ${who.id}`);
    await page.getByRole("button", { name: "+ New inbox" }).click();
    const receiver = (await page.locator(".fresh code").textContent()) ?? "";
    expect(receiver.startsWith(`${baseURL}/api/hooks/receive/`)).toBe(true);
    // The receiver URL is a bearer secret: posted to once here, never printed or attached.
    const posted = await request.post(receiver, { data: { synthetic: "xbrowser-e2e" } });
    expect(posted.status()).toBe(202);
    await page.getByRole("button", { name: "Refresh" }).click();
    const event = page.locator("details").first();
    await expect(event).toBeVisible();
    await event.locator("summary").click();
    await expect(page.locator(".code2").filter({ hasText: "xbrowser-e2e" }).first()).toBeVisible();

    // Configurable receiver response: edit, preview, save, then the sender gets it (still a synthetic POST).
    await page.getByLabel(/^Status code/).fill("201");
    await page.getByLabel(/^Content type/).selectOption("application/json");
    await page.getByLabel(/^Response body/).fill('{"mocked":true}');
    await page.getByRole("button", { name: "+ Response header" }).click();
    await page.getByLabel("Response header name 1", { exact: true }).fill("X-Mock-Id");
    await page.getByLabel("Response header value 1", { exact: true }).fill("xbrowser");
    await expect(page.getByRole("region", { name: "Preview" })).toContainText("HTTP/1.1 201");
    await expect(page.getByRole("region", { name: "Preview" })).toContainText("X-Mock-Id: xbrowser");
    await page.getByRole("button", { name: "Save response" }).click();
    await expect(page.getByText("Response saved. New requests get it right away.")).toBeVisible();
    const answered = await request.post(receiver, { data: { synthetic: "xbrowser-response" } });
    expect(answered.status()).toBe(201);
    expect(answered.headers()["x-mock-id"]).toBe("xbrowser");
    expect(answered.headers()["cache-control"]).toBe("private, no-store");
    expect(await answered.text()).toBe('{"mocked":true}');
    await checkA11y(page, testInfo, "webhook-inbox");
  });

  await test.step("on-call page: schedule, who is on call, timeline, overrides and escalation policy are accessible", async () => {
    const me = await (await page.request.get("/api/me")).json() as { userId: string };
    const created = await page.request.post("/api/oncall/schedules", { data: {
      name: `Synthetic rotation ${who.id}`, timeZone: "Europe/London",
      layers: [{ name: "Primary rotation", userIds: [me.userId], rotationType: "weekly", handoffTime: "09:00", handoffWeekday: 1, startDate: "2026-01-05", restrictions: [] }],
    } });
    expect(created.status()).toBe(201);
    const schedule = await created.json() as { id: string };
    const policy = await page.request.post("/api/escalation-policies", { data: { name: `Synthetic Sev1 ${who.id}`, steps: [{ timeoutMin: 5, scheduleIds: [schedule.id] }] } });
    expect(policy.status()).toBe(201);
    await page.goto("/app/oncall");
    await expect(page.getByRole("heading", { level: 1, name: "On-call" })).toBeVisible();
    await expect(page.locator("nav.nl a[data-nav=oncall]")).toHaveAttribute("aria-current", "page");
    // the one-person rotation means the journey's user is on call now, and for the next two weeks
    await expect(page.getByRole("heading", { name: "Next two weeks" })).toBeVisible();
    await expect(page.getByRole("region", { name: `Shifts of Synthetic rotation ${who.id} in the next two weeks` }).locator("tbody tr").first()).toContainText("Montral Cross-browser QA");
    await expect(page.getByLabel("Name", { exact: true }).first()).toHaveValue(`Synthetic rotation ${who.id}`);
    await expect(page.getByRole("region", { name: "Escalation policies" }).locator("b", { hasText: `Synthetic Sev1 ${who.id}` })).toBeVisible();
    await checkA11y(page, testInfo, "oncall");
  });

  await test.step("audit log lists the journey's changes and is accessible", async () => {
    await page.goto("/app/audit-log");
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    await expect(page.locator("table.audit-tbl tbody tr").first()).toBeVisible();
    await expect(page.locator("table.audit-tbl tbody")).not.toHaveAttribute("aria-busy", "true");
    await checkA11y(page, testInfo, "audit-log");
  });

  await test.step("settings with the single sign-on card are accessible to the owner", async () => {
    await page.goto("/app/settings");
    await expect(page.getByRole("heading", { level: 3, name: "Single sign-on (OpenID Connect)" })).toBeVisible();
    await expect(page.getByLabel("Issuer URL")).toBeVisible();
    await expect(page.getByText("/api/auth/sso/callback")).toBeVisible();
    await checkA11y(page, testInfo, "settings-sso");
  });

  // From here on the visitor is an outsider: no session cookie.
  await context.clearCookies();

  await test.step("public status page opens for an anonymous visitor", async () => {
    const response = await page.goto(`/status/${publicSlug}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText(`Public status ${who.id}`).first()).toBeVisible();
    await checkA11y(page, testInfo, "status-page-public");
  });

  await test.step("password page: locked form, wrong password refused, correct password unlocks", async () => {
    const response = await page.goto(`/status/${lockedSlug}`);
    expect(response?.status()).toBe(401);
    const form = page.locator("form#unlock");
    await expect(form.getByLabel("Password")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(lockedTitle);
    await checkA11y(page, testInfo, "status-page-locked");
    await form.getByLabel("Password").fill("not-the-password");
    await form.getByRole("button", { name: "Open status page" }).click();
    await expect(page.locator("#unlock-msg")).toHaveText(/not right/);
    await expect(page.locator("body")).not.toContainText(lockedTitle);
    await form.getByLabel("Password").fill(pagePassword);
    await form.getByRole("button", { name: "Open status page" }).click();
    await expect(page.getByText(lockedTitle).first()).toBeVisible({ timeout: 25_000 });
    expect(await page.evaluate(() => document.cookie.includes("montral_sa_")), "status access cookie must be HttpOnly").toBe(false);
  });

  // Crashes (React render errors, invalid pattern attributes), console errors and unhandled promise rejections fail the
  // journey in every engine.
  //
  // The one exclusion is narrow. When a navigation cancels an in-flight same-origin /api fetch, WebKit raises
  // "Fetch API cannot load <url> due to access control checks." through Playwright's `pageerror` channel. That is
  // where uncaught errors arrive, so the entry looks like an uncaught exception. In run 42567389270 it appeared for a
  // request the app does handle (the subscribers load, inside try/catch). A rejection the app genuinely leaves
  // unhandled also produces its own separate `pageerror` entry ("Unhandled Promise Rejection: TypeError: Load
  // failed"), and that entry is NOT filtered.
  //
  // Chromium and Firefox have no equivalent message. There an unhandled aborted fetch surfaces as "Failed to fetch" or
  // "NetworkError when attempting to fetch resource" and fails the journey, so a missing handler is caught in two more
  // engines even if WebKit's wording ever changed. The filter matches only this exact message for this server's
  // origin and /api paths, and only in WebKit.
  const host = new URL(baseURL!).host.replace(/\./g, "\\.");
  const webkitCancelled = new RegExp(String.raw`: uncaught Fetch API cannot load http:\s?/+` + host + String.raw`/api/\S* due to access control checks\.$`);
  const cancelledByNavigation = (e: string) => browserName === "webkit" && webkitCancelled.test(e);
  expect(guard.errors.filter((e) => !cancelledByNavigation(e)), "console errors or uncaught exceptions during the journey").toEqual([]);

  // Failed HTTP responses: the global list allows only the anonymous /api/me probe and the hosted status-page widget.
  // The journey deliberately causes exactly these, matched by method, path and status, nothing broader:
  const designed = [
    { method: "GET", path: `/status/${lockedSlug}`, status: 401, why: "the outsider opens the password page: lock form served with 401" },
    { method: "POST", path: "/api/public/status/_/unlock", status: 401, why: "the wrong password is refused" },
  ];
  const isDesigned = (r: (typeof guard.failedRequests)[number]) =>
    designed.some((d) => d.method === r.method && d.path === r.path && d.status === r.status);
  expect(guard.failedRequests.filter((r) => !isDesigned(r)).map((r) => `${r.method} ${r.path} ${r.status} (on ${r.on})`),
    "unexpected failed requests during the journey").toEqual([]);
  // and the designed failures did happen (each exactly once), so the allowance cannot hide a changed flow
  for (const d of designed) {
    expect(guard.failedRequests.filter((r) => r.method === d.method && r.path === d.path && r.status === d.status).length, d.why).toBe(1);
  }
});
