// Synthetic UI qualification only: the real operator API requires a fresh second-factor session.
// The unauthorised first step hits the real API. Later mocked responses exercise the browser,
// confirmation gates, private error UX and request bodies without claiming an MFA session was issued.
import { checkA11y, expect, synthetic, test } from "../support/fixtures";
import type { Route } from "@playwright/test";

test.use({ baseURL: process.env.MONTRAL_E2E_BASE_URL, serviceWorkers: "block" });

const answer = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });

test("operator console is denied by default and confirms every synthetic state change", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const who = synthetic(testInfo);
  await page.goto("/signup");
  const form = page.locator("form.auth-fields");
  await form.getByLabel("Name", { exact: true }).fill("Operator Console QA");
  await form.getByLabel("Work email").fill(who.email);
  await form.locator("input[autocomplete=new-password]").fill("correct horse battery staple");
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });

  // No configured operator identity or MFA: a normal user must never see platform data.
  await page.goto("/app/operator");
  await expect(page.getByRole("heading", { name: "Operator access denied" })).toBeVisible();
  await expect(page.getByText("Synthetic Platform")).toHaveCount(0);

  let suspended = false;
  let drained = false;
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  const workspace = () => ({
    id: "synthetic-org-1", name: "Synthetic Platform", slug: "synthetic-platform",
    createdAt: "2026-01-01T00:00:00.000Z", memberCount: 2, monitorCount: 3,
    ownerEmail: "owner@synthetic.test", suspended, plan: "synthetic",
  });
  const region = () => ({
    id: "synthetic-east", name: "Synthetic East", configured: true, status: drained ? "drained" : "up",
    monitors: 3, drained, lastAnswerAt: "2026-01-01T00:00:00.000Z", lastUnreachableAt: null,
    lastUnreachableReason: null, drainedAt: null,
  });
  await page.route((url) => url.pathname.startsWith("/api/operator/"), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/operator", "");
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      posted.push({ path, body });
      if (path === "/workspaces/synthetic-org-1/suspend") suspended = true;
      else if (path === "/workspaces/synthetic-org-1/unsuspend") suspended = false;
      else if (path === "/probes/synthetic-east/drain") drained = true;
      else if (path === "/probes/synthetic-east/undrain") drained = false;
      else return answer(route, 404, { error: "Not found" });
      return answer(route, 200, { id: path.split("/")[2], suspended, drained });
    }
    if (path === "/workspaces") return answer(route, 200, { workspaces: [workspace()], next: null });
    if (path === "/workspaces/synthetic-org-1") return answer(route, 200, {
      ...workspace(), suspension: suspended ? { reason: "operator", note: null, suspendedBy: "synthetic",
        suspendedAt: "2026-01-01T00:00:00.000Z" } : null, usage: { credits: null, emails: null },
    });
    if (path === "/probes") return answer(route, 200, { auto: { monitors: 0 }, regions: [region()] });
    return answer(route, 404, { error: "Not found" });
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Platform operations" })).toBeVisible();
  await page.getByRole("button", { name: /Synthetic Platform/ }).click();
  const detail = page.getByRole("region", { name: "Selected workspace" });
  await expect(detail.getByText("owner@synthetic.test")).toBeVisible();
  await expect(detail.getByRole("button", { name: "Suspend workspace" })).toBeDisabled();
  await detail.getByLabel(/Type the exact workspace slug/).fill("Synthetic-platform");
  await expect(detail.getByRole("button", { name: "Suspend workspace" })).toBeDisabled();
  await detail.getByLabel(/Type the exact workspace slug/).fill("synthetic-platform");
  await expect(detail.getByRole("button", { name: "Suspend workspace" })).toBeEnabled();
  await detail.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(detail.getByRole("button", { name: "Lift suspension" })).toBeVisible();
  expect(posted[0]).toEqual({ path: "/workspaces/synthetic-org-1/suspend", body: { reason: "operator", note: "" } });
  await detail.getByLabel(/Type the exact workspace slug/).fill("synthetic-platform");
  await detail.getByRole("button", { name: "Lift suspension" }).click();
  await expect(detail.getByRole("button", { name: "Suspend workspace" })).toBeVisible();
  expect(posted[1]?.path).toBe("/workspaces/synthetic-org-1/unsuspend");

  const probes = page.getByRole("region", { name: "Probe region controls" });
  await probes.getByRole("button", { name: "Drain", exact: true }).click();
  await expect(probes.getByRole("button", { name: "Confirm drain" })).toBeDisabled();
  await probes.getByLabel(/Type region ID/).fill("synthetic-east");
  await probes.getByRole("button", { name: "Confirm drain" }).click();
  await expect(probes.getByRole("button", { name: "Undrain", exact: true })).toBeVisible();
  expect(posted[2]).toEqual({ path: "/probes/synthetic-east/drain", body: { note: "" } });
  await probes.getByRole("button", { name: "Undrain", exact: true }).click();
  await probes.getByLabel(/Type region ID/).fill("synthetic-east");
  await probes.getByRole("button", { name: "Confirm undrain" }).click();
  await expect(probes.getByRole("button", { name: "Drain", exact: true })).toBeVisible();
  expect(posted[3]?.path).toBe("/probes/synthetic-east/undrain");
  await checkA11y(page, testInfo, "operator-console-synthetic");
});
