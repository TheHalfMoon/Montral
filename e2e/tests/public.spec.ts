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
  // Visibility is true partway through a reveal, when opacity still blends text with the background.
  // Measure the rendered hero at its final contrast without disabling motion or any axe rule.
  await expect(page.locator(".hero h1")).toHaveCSS("opacity", "1");
  await expect.poll(() => page.locator(".hero .rv.in").evaluateAll((nodes) => nodes
    .filter((node) => { const box = node.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; })
    .every((node) => getComputedStyle(node).opacity === "1"))).toBe(true);
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

test("sign-in single sign-on entry is accessible", async ({ page, guard }, testInfo) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with SSO" }).click();
  await expect(page.getByLabel("Work email or workspace ID")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with SSO" })).toBeVisible();
  await checkA11y(page, testInfo, "sign-in-sso");
  // back from the identity provider with a refusal: explained, and the panel is open
  await page.goto("/login?sso_error=link_required");
  await expect(page.getByRole("alert")).toContainText("An account with this email already exists");
  await expect(page).toHaveURL(/\/login$/);
  await checkA11y(page, testInfo, "sign-in-sso-error");
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
