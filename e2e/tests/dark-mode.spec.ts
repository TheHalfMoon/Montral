// Explicit dark-theme WCAG 2.1 AA qualification on the built self-hosted Node server.
// The landing page intentionally defaults to data-theme="light"; operating-system dark emulation
// alone would silently test its light palette. Set the actual theme attribute after navigation,
// assert the dark CSS token is active, then run axe. Every case runs in all five Playwright projects.
import { checkA11y, expect, synthetic, test } from "../support/fixtures";

test.use({ baseURL: process.env.MONTRAL_E2E_BASE_URL, colorScheme: "dark" });

async function activateDarkTheme(page: import("@playwright/test").Page) {
  await page.locator("html").evaluate((root) => { root.dataset.theme = "dark"; });
  const result = await page.locator("html").evaluate((root) => ({
    theme: root.dataset.theme,
    preference: matchMedia("(prefers-color-scheme: dark)").matches,
    bg: getComputedStyle(root).getPropertyValue("--bg").trim().toLowerCase(),
  }));
  expect(result, "the dark palette must actually be active, not just requested").toEqual({
    theme: "dark",
    preference: true,
    bg: "#0a0c0b",
  });
}

for (const [label, path] of [
  ["landing", "/"],
  ["sign-in", "/login"],
  ["sign-up", "/signup"],
  ["self-hosting docs", "/docs/self-host"],
] as const) {
  test(`dark theme: ${label} is accessible`, async ({ page, guard }, testInfo) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await activateDarkTheme(page);
    await checkA11y(page, testInfo, `dark-${label.replace(/\\s+/g, "-")}`);
    expect(guard.errors).toEqual([]);
    expect(guard.failedResponses).toEqual([]);
  });
}

test("dark theme: signed-in dashboard is accessible", async ({ page, guard }, testInfo) => {
  const who = synthetic(testInfo);
  await page.goto("/signup");
  const form = page.locator("form.auth-fields");
  await form.getByLabel("Name", { exact: true }).fill("Montral Dark Theme QA");
  await form.getByLabel("Work email").fill(who.email);
  await form.locator("input[autocomplete=new-password]").fill("correct horse battery staple");
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\\/app$/, { timeout: 30_000 });
  await expect(page.locator("main#main-content")).toBeVisible();
  await activateDarkTheme(page);
  await checkA11y(page, testInfo, "dark-dashboard");
  expect(guard.errors).toEqual([]);
  expect(guard.failedResponses).toEqual([]);
});
