// One signed-in user journey per engine/viewport, all with synthetic data against the disposable database: sign up,
// dashboard and skip link, a heartbeat monitor (never probes anything external), a public status page, a password
// status page (locked form, wrong password refused, right password unlocks), and a webhook inbox.
import { checkA11y, expect, synthetic, test } from "../support/fixtures";

test.use({ baseURL: process.env.MONTRAL_E2E_BASE_URL });

test("signed-in journey: monitors, status pages, password page, webhook inbox", async ({ page, context, request, baseURL }, testInfo) => {
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
});
