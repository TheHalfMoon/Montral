// Customer onboarding and usage UX (SaaS stage 5), per engine/viewport, against the built self-hosted Node server.
//
// The server under test is the community edition with metering off, so the first half proves the self-hosted UX:
// the first-run checklist is derived from real data and can be hidden, and there is no usage banner, no Plan & usage
// entry and no limit anywhere. The second half shows what a metered (hosted) customer sees by answering the few API
// reads involved with synthetic responses (page.route): near-limit and used-up banners, the meters, a quota refusal
// explained with its reset date and an upgrade link, and the suspended-workspace notice. No figure here describes a
// real plan; the plan is called "Synthetic plan" and every allowance is a round test number.
import type { Page, Route } from "@playwright/test";
import { checkA11y, expect, synthetic, test } from "../support/fixtures";

// The app registers a service worker (lib/pwa.ts). In WebKit the page's fetches then reach the network through it,
// where page.route never sees them, so the synthetic API answers below would silently not apply: no worker here.
test.use({ baseURL: process.env.MONTRAL_E2E_BASE_URL, serviceWorkers: "block" });

const nextUtcMonth = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)).toISOString(); };
const quota = (used: number, limit: number) => ({ used, limit, periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString(), periodEnd: nextUtcMonth() });
const syntheticUsage = (over: Record<string, unknown>) => ({
  metered: true, periodEnd: nextUtcMonth(), limit: 2000, used: 10, periodStart: quota(0, 1).periodStart,
  credits: quota(10, 2000), emails: quota(0, 10), webhookEvents: quota(0, 100), browserSeconds: quota(0, 100), activeMonitors: 1,
  plan: { id: "synthetic", name: "Synthetic plan", maxActiveMonitors: 3, minIntervalSec: 120, maxRegions: 1, upgradeUrl: "/app/billing" },
  ...over,
});
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
// Playwright's unroute matches a function matcher by identity, so each matcher is one shared function
const isUsage = (url: URL) => url.pathname === "/api/usage";
const answerUsage = (page: Page, body: unknown) => page.route(isUsage, (route) => json(route, 200, body));

test("onboarding checklist, usage banner, quota message and suspended notice", async ({ page, guard, baseURL, browserName }, testInfo) => {
  test.setTimeout(180_000);
  const who = synthetic(testInfo);
  let monitorId = "";

  await test.step("sign up: the empty dashboard shows the first-run checklist", async () => {
    await page.goto("/signup");
    const form = page.locator("form.auth-fields");
    await form.getByLabel("Name", { exact: true }).fill("Montral Onboarding QA");
    await form.getByLabel("Work email").fill(who.email);
    await form.locator("input[autocomplete=new-password]").fill("correct horse battery staple");
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
    const checklist = page.getByRole("region", { name: "Welcome to Montral." });
    await expect(checklist).toBeVisible();
    await expect(checklist.locator("[data-step=workspace]")).toHaveClass(/done/);
    await expect(checklist.locator("[data-step=monitor]")).not.toHaveClass(/done/);
    await expect(checklist.locator("[data-step=status-page]")).toContainText("Optional");
    // the empty state cannot be hidden: it is the way to the first monitor
    await expect(checklist.getByRole("button", { name: "Hide checklist" })).toHaveCount(0);
  });

  await test.step("self-hosted: no usage banner, no Plan & usage entry, no limits", async () => {
    await expect(page.locator("[data-usage-alert]")).toHaveCount(0);
    await expect(page.locator("nav.nl a[data-nav=usage]")).toHaveJSProperty("hidden", true);
    await page.goto("/app/usage");
    await expect(page.getByText("This deployment has no plans or usage limits.")).toBeVisible();
    await expect(page.locator(".meter, [data-usage-alert]")).toHaveCount(0);
  });

  await test.step("after the first monitor the checklist stays until an alert channel exists, and can be hidden", async () => {
    const created = await page.request.post("/api/monitors", { data: { name: `Synthetic heartbeat ${who.id}`, type: "heartbeat", intervalSec: 3600 } });
    expect(created.status()).toBe(201);
    monitorId = (await created.json() as { id: string }).id;
    await page.goto("/app");
    const checklist = page.getByRole("region", { name: "Finish setting up" });
    await expect(checklist).toBeVisible();
    await expect(checklist.locator("[data-step=monitor]")).toHaveClass(/done/);
    await expect(checklist.locator("[data-step=channel]")).not.toHaveClass(/done/);
    await expect(checklist.getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/app/alerting");
    await checkA11y(page, testInfo, "dashboard-checklist");
    await checklist.getByRole("button", { name: "Hide checklist" }).click();
    await expect(checklist).toBeHidden();
    await page.reload();
    await expect(page.getByText(`Synthetic heartbeat ${who.id}`).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Finish setting up" })).toHaveCount(0);
  });

  await test.step("metered, near the limit: a banner links to usage and billing; the meters show the state", async () => {
    await answerUsage(page, syntheticUsage({ webhookEvents: quota(85, 100) }));
    await page.goto("/app");
    const bar = page.locator("[data-usage-alert=near]");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Nearly used up for this month: Webhook events.");
    await expect(bar).toContainText("(UTC)");
    await expect(bar.getByRole("link", { name: "View usage" })).toHaveAttribute("href", "/app/usage");
    await expect(bar.getByRole("link", { name: "Upgrade plan" })).toHaveAttribute("href", "/app/billing");
    await expect(page.locator("nav.nl a[data-nav=usage]")).toHaveJSProperty("hidden", false);
    await checkA11y(page, testInfo, "usage-banner-near");
    await page.goto("/app/usage");
    await expect(page.getByRole("heading", { level: 2, name: "Synthetic plan" })).toBeVisible();
    await expect(page.locator("[data-meter-state=near]")).toHaveCount(1);
    await expect(page.getByRole("progressbar", { name: "Webhook events" })).toHaveAttribute("aria-valuenow", "85");
    await expect(page.getByRole("progressbar", { name: "Checks" })).toHaveAttribute("aria-valuenow", "0");
    await checkA11y(page, testInfo, "usage-near");
  });

  await test.step("metered, used up: the banner says so and can be dismissed for the session", async () => {
    await page.unroute(isUsage);
    await answerUsage(page, syntheticUsage({ credits: quota(2000, 2000), webhookEvents: quota(85, 100) }));
    await page.goto("/app/usage");
    const bar = page.locator("[data-usage-alert=exhausted]");
    await expect(bar).toContainText("Used up for this month: Checks.");
    await expect(page.locator("[data-meter-state=exhausted]")).toContainText("Used up");
    await expect(page.locator("[data-meter-state=exhausted]").getByRole("link", { name: "Upgrade your plan" })).toHaveAttribute("href", "/app/billing");
    await checkA11y(page, testInfo, "usage-exhausted");
    await bar.getByRole("button", { name: "Dismiss" }).click();
    await expect(bar).toBeHidden();
    await page.goto("/app");
    await expect(page.getByText(`Synthetic heartbeat ${who.id}`).first()).toBeVisible();
    await expect(page.locator("[data-usage-alert]")).toHaveCount(0);
  });

  await test.step("a quota refusal is explained with the reset date and an upgrade link, not the raw error", async () => {
    // shown as an outbound monitor, so it has a Check now button; the check itself is answered with the refusal
    const isMonitor = (url: URL) => url.pathname === `/api/monitors/${monitorId}`;
    const isCheck = (url: URL) => url.pathname === `/api/monitors/${monitorId}/check`;
    await page.route(isMonitor, async (route) => {
      const real = await route.fetch();
      await json(route, real.status(), { ...(await real.json()), type: "http", target: "https://example.test/" });
    });
    await page.route(isCheck, (route) =>
      json(route, 402, { error: "No credits left this period", code: "credits_exhausted", resetsAt: nextUtcMonth() }));
    await page.goto(`/app/monitors/${monitorId}`);
    await page.getByRole("button", { name: "Check now" }).click();
    const notice = page.locator("[data-quota-code=credits_exhausted]");
    await expect(notice).toContainText("This workspace has used all of its checks for this month.");
    await expect(notice.getByRole("link", { name: "Upgrade plan" })).toHaveAttribute("href", "/app/billing");
    await expect(notice.getByRole("link", { name: "View usage" })).toHaveAttribute("href", "/app/usage");
    await expect(page.getByText("No credits left this period")).toHaveCount(0);
    await checkA11y(page, testInfo, "quota-refusal");
    await page.unroute(isMonitor);
    await page.unroute(isCheck);
  });

  await test.step("a suspended workspace shows a notice instead of raw errors", async () => {
    await page.unroute(isUsage);
    // what the API answers every workspace call while an operator has suspended it (docs/OPERATOR.md)
    await page.route((url) => url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/"), (route) =>
      json(route, 403, { error: "This workspace is suspended. Contact support.", code: "workspace_suspended" }));
    await page.goto("/app");
    const notice = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "This workspace is suspended" }) });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Nothing has been deleted");
    await expect(page.getByText("This workspace is suspended. Contact support.")).toHaveCount(0);
    await expect(page.locator("[data-usage-alert], .onb, .mon-tbl")).toHaveCount(0);
    await checkA11y(page, testInfo, "workspace-suspended");
  });

  // Same narrow WebKit exclusion as the signed-in journey: a navigation cancelling an in-flight same-origin /api fetch.
  const host = new URL(baseURL!).host.replace(/\./g, "\\.");
  const webkitCancelled = new RegExp(String.raw`: uncaught Fetch API cannot load http:\s?/+` + host + String.raw`/api/\S* due to access control checks\.$`);
  expect(guard.errors.filter((e) => !(browserName === "webkit" && webkitCancelled.test(e))), "console errors or uncaught exceptions").toEqual([]);
  // the only failed responses are the refusals this test answers itself
  const designed = (r: (typeof guard.failedRequests)[number]) =>
    (r.status === 402 && r.method === "POST" && r.path === `/api/monitors/${monitorId}/check`) ||
    (r.status === 403 && r.path.startsWith("/api/") && !r.path.startsWith("/api/auth/"));
  expect(guard.failedRequests.filter((r) => !designed(r)).map((r) => `${r.method} ${r.path} ${r.status} (on ${r.on})`), "unexpected failed requests").toEqual([]);
});
