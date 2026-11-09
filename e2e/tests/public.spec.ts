// Anonymous pages: the landing page, sign-in, sign-up and the self-hosting docs, in every engine and viewport.
import { checkA11y, expect, test } from "../support/fixtures";

test.use({ baseURL: process.env.MONTRAL_E2E_BASE_URL });

test("landing page renders with its scripts, no console errors and no CSP violations", async ({ page, guard }, testInfo) => {
  await page.goto("/");
  // /landing.js renders the four sample monitors; it only runs if the strict script CSP allows it
  await expect(page.locator("#mons .mon")).toHaveCount(4);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const policy = await page.locator('meta[http-equiv="content-security-policy"]').getAttribute("content");
  expect(policy).toMatch(/script-src 'self' 'sha256-/);
  expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await checkA11y(page, testInfo, "landing");
  expect(guard.errors, "console errors on the landing page").toEqual([]);
  expect(guard.failedResponses, "unexpected failed requests on the landing page").toEqual([]);
});

test("sign-in page is accessible", async ({ page, guard }, testInfo) => {
  await page.goto("/login");
  await expect(page.locator("form.auth-fields input[type=email]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await checkA11y(page, testInfo, "sign-in");
  expect(guard.errors).toEqual([]);
  expect(guard.failedResponses).toEqual([]);
});

test("sign-up page is accessible", async ({ page, guard }, testInfo) => {
  await page.goto("/signup");
  await expect(page.locator("form.auth-fields input[autocomplete=name]")).toBeVisible();
  await expect(page.locator("main#main-content h1")).toBeVisible();
  await checkA11y(page, testInfo, "sign-up");
  expect(guard.errors).toEqual([]);
  expect(guard.failedResponses).toEqual([]);
});

test("self-hosting docs render and are accessible", async ({ page, guard }, testInfo) => {
  const response = await page.goto("/docs/self-host");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("body")).toContainText(/docker/i);
  await checkA11y(page, testInfo, "docs-self-host");
  expect(guard.errors, "console errors on the docs page").toEqual([]);
  expect(guard.failedResponses, "unexpected failed requests on the docs page").toEqual([]);
});
