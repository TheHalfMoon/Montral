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
  let enabled = true;
  let managedState: "registered" | "suspended" | "revoked" = "registered";
  let managedRegistrationCreated = false;
  let staleManagedResponses = 0;
  let denyProbeOnFirstMock = true;
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  const workspace = () => ({
    id: "synthetic-org-1", name: "Synthetic Platform", slug: "synthetic-platform",
    createdAt: "2026-01-01T00:00:00.000Z", memberCount: 2, monitorCount: 3,
    ownerEmail: "owner@synthetic.test", suspended, plan: "synthetic",
  });
  const region = () => ({
    id: "synthetic-east", name: "Synthetic East", configured: true, status: !enabled ? "deactivated" : drained ? "drained" : "up", enabled,
    monitors: 3, drained, lastAnswerAt: "2026-01-01T00:00:00.000Z", lastUnreachableAt: null,
    lastUnreachableReason: null, drainedAt: null,
  });
  const managedRegistration = () => ({
    region: "synthetic-managed-east", displayName: "Synthetic Managed East",
    endpointUrl: "https://probe.synthetic.test/api/probe/synthetic-managed-east", state: managedState,
    createdBy: "synthetic-operator", updatedBy: "synthetic-operator", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", executionEnabled: false,
  });
  await page.route((url) => url.pathname.startsWith("/api/operator/"), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/operator", "");
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      posted.push({ path, body });
      if (path === "/managed-probes") {
        managedRegistrationCreated = true;
        return answer(route, 201, { registration: managedRegistration() });
      }
      if (path === "/managed-probes/synthetic-managed-east/suspend") managedState = "suspended";
      else if (path === "/managed-probes/synthetic-managed-east/restore") managedState = "registered";
      else if (path === "/managed-probes/synthetic-managed-east/revoke") managedState = "revoked";
      else if (path.startsWith("/managed-probes/")) return answer(route, 200, { registration: managedRegistration() });
      else if (path === "/workspaces/synthetic-org-1/suspend") suspended = true;
      else if (path === "/workspaces/synthetic-org-1/unsuspend") suspended = false;
      else if (path === "/probes/synthetic-east/drain") drained = true;
      else if (path === "/probes/synthetic-east/undrain") drained = false;
      else if (path === "/probes/synthetic-east/deactivate") enabled = false;
      else if (path === "/probes/synthetic-east/activate") enabled = true;
      else if (path === "/probes/synthetic-east/validate") return answer(route, 200, {
        id: "synthetic-east", validated: true, identity: "reported_match", credentialProof: "matched", sourceAttestation: false, capabilities: [],
      });
      else return answer(route, 404, { error: "Not found" });
      return answer(route, 200, { id: path.split("/")[2], suspended, drained, enabled, changed: true });
    }
    if (path === "/workspaces") return answer(route, 200, { workspaces: [workspace()], next: null });
    if (path === "/workspaces/synthetic-org-1/suspension-history") return answer(route, 200, {
      workspaceId: "synthetic-org-1",
      events: posted.filter((p) => p.path.startsWith("/workspaces/synthetic-org-1/")).map((p, i) => ({
        id: `synthetic-event-${i + 1}`, action: p.path.endsWith("/unsuspend") ? "workspace.unsuspend" : "workspace.suspend",
        reason: "operator", createdAt: "2026-01-01T00:00:00.000Z",
      })).reverse(),
    });
    if (path === "/workspaces/synthetic-org-1") return answer(route, 200, {
      ...workspace(), suspension: suspended ? { reason: "operator", note: null, suspendedBy: "synthetic",
        suspendedAt: "2026-01-01T00:00:00.000Z" } : null, usage: { credits: null, emails: null },
    });
    if (path === "/audit") return answer(route, 200, { events: [
      { source: "probe", id: "lifecycle:1", action: "probe.deactivate", target: "synthetic-east", operatorId: "synthetic-operator", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
      { source: "probe", id: "validation:1", action: "probe.validation.validated", target: "synthetic-east", operatorId: "synthetic-operator", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
    ], next: null });
    if (path === "/managed-probes") {
      if (!managedRegistrationCreated) {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        staleManagedResponses++;
        return answer(route, 200, { registrations: [], nextCursor: null });
      }
      return answer(route, 200, { registrations: [managedRegistration()], nextCursor: null });
    }
    if (path === "/managed-probes/synthetic-managed-east/audit") return answer(route, 200, { region: "synthetic-managed-east", events: [
      { id: 1, region: "synthetic-managed-east", action: "register", operatorId: "synthetic-operator", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, region: "synthetic-managed-east", action: managedState === "registered" ? "restore" : managedState, operatorId: "synthetic-operator", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    if (path === "/probes") return denyProbeOnFirstMock
      ? answer(route, 403, { error: "private operator configuration" })
      : answer(route, 200, { auto: { monitors: 0 }, regions: [region()] });
    if (path === "/probes/synthetic-east/audit") return answer(route, 200, {
      region: "synthetic-east",
      events: [{ id: 19, region: "synthetic-east", action: "drain", operatorId: "synthetic-operator",
        note: "Synthetic maintenance", createdAt: "2026-01-01T00:00:00.000Z" }],
      lifecycleEvents: posted.filter((p) => p.path === "/probes/synthetic-east/activate" || p.path === "/probes/synthetic-east/deactivate")
        .map((p, i) => ({ id: i + 1, region: "synthetic-east", action: p.path.endsWith("/activate") ? "activate" : "deactivate",
          operatorId: "synthetic-operator", createdAt: "2026-01-01T00:00:00.000Z" })).reverse(),
    });
    return answer(route, 404, { error: "Not found" });
  });

  // The first mocked workspace list succeeds, but the operator loses MFA before the probes read.
  // The UI must revoke access and erase the already loaded workspace list, not merely warn about probes.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Operator access denied" })).toBeVisible();
  await expect(page.getByText("Synthetic Platform")).toHaveCount(0);
  denyProbeOnFirstMock = false;
  const initialManagedRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/operator/managed-probes");
  await page.reload();
  await initialManagedRequest;
  await expect(page.getByRole("heading", { name: "Platform operations" })).toBeVisible();
  const managed = page.getByRole("region", { name: "Managed probe registrations" });
  await expect(managed).toContainText("does not create or deliver credentials");
  await managed.getByLabel("Region ID").fill("synthetic-managed-east");
  await managed.getByLabel("Display name").fill("Synthetic Managed East");
  await managed.getByLabel("HTTPS probe endpoint").fill("https://probe.synthetic.test/api/probe/synthetic-managed-east");
  const freshManagedList = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/operator/managed-probes" && response.request().method() === "GET" && response.status() === 200;
  });
  await managed.getByRole("button", { name: "Register metadata" }).click();
  await freshManagedList;
  await expect(managed.getByText("Disabled", { exact: true })).toBeVisible();
  expect(posted.at(-1)).toEqual({ path: "/managed-probes", body: {
    region: "synthetic-managed-east", displayName: "Synthetic Managed East", endpointUrl: "https://probe.synthetic.test/api/probe/synthetic-managed-east",
  } });
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
  expect(posted.find((p) => p.path === "/workspaces/synthetic-org-1/suspend")).toEqual({ path: "/workspaces/synthetic-org-1/suspend", body: { reason: "operator", note: "" } });
  await detail.getByLabel(/Type the exact workspace slug/).fill("synthetic-platform");
  await detail.getByRole("button", { name: "Lift suspension" }).click();
  await expect(detail.getByRole("button", { name: "Suspend workspace" })).toBeVisible();
  expect(posted.find((p) => p.path === "/workspaces/synthetic-org-1/unsuspend")?.path).toBe("/workspaces/synthetic-org-1/unsuspend");
  const suspensionHistory = detail.getByRole("region", { name: "Workspace suspension history" });
  await expect(suspensionHistory).toContainText("Suspension lifted");
  await expect(suspensionHistory).toContainText("Suspended");
  await expect(suspensionHistory).toContainText("operator");
  await expect(suspensionHistory).not.toContainText("private operator note");

  const platformAudit = page.getByRole("region", { name: "Platform operator audit" });
  await platformAudit.getByRole("button", { name: "Search audit" }).click();
  await expect(platformAudit).toContainText("probe.deactivate");
  await expect(platformAudit).toContainText("probe.validation.validated");
  await expect(platformAudit).not.toContainText("credential fingerprint");

  const probes = page.getByRole("region", { name: "Probe region controls" });
  await probes.getByRole("button", { name: "Audit history" }).click();
  const history = probes.getByRole("region", { name: "Audit history for Synthetic East" });
  await expect(history).toContainText("Synthetic maintenance");
  await expect(history).toContainText("synthetic-operator");
  await probes.getByRole("button", { name: "Hide audit" }).click();
  await expect(history).toHaveCount(0);
  await probes.getByRole("button", { name: "Drain", exact: true }).click();
  await expect(probes.getByRole("button", { name: "Confirm drain" })).toBeDisabled();
  await probes.getByLabel(/Type region ID/).fill("synthetic-east");
  await probes.getByRole("button", { name: "Confirm drain" }).click();
  await expect(probes.getByRole("button", { name: "Undrain", exact: true })).toBeVisible();
  expect(posted.find((p) => p.path === "/probes/synthetic-east/drain")).toEqual({ path: "/probes/synthetic-east/drain", body: { note: "" } });
  await probes.getByRole("button", { name: "Undrain", exact: true }).click();
  await probes.getByLabel(/Type region ID/).fill("synthetic-east");
  await probes.getByRole("button", { name: "Confirm undrain" }).click();
  await expect(probes.getByRole("button", { name: "Drain", exact: true })).toBeVisible();
  expect(posted.find((p) => p.path === "/probes/synthetic-east/undrain")?.path).toBe("/probes/synthetic-east/undrain");

  await probes.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText(/Credential-possession validation succeeded/)).toBeVisible();
  await probes.getByRole("button", { name: "Deactivate", exact: true }).click();
  await probes.getByLabel(/Type region ID/).fill("synthetic-east");
  await probes.getByRole("button", { name: "Confirm deactivation" }).click();
  await expect(probes.getByRole("button", { name: "Activate", exact: true })).toBeVisible();
  await probes.getByRole("button", { name: "Activate", exact: true }).click();
  await probes.getByLabel(/Type region ID/).fill("synthetic-east");
  await probes.getByRole("button", { name: "Confirm activation" }).click();
  await expect(probes.getByRole("button", { name: "Deactivate", exact: true })).toBeVisible();
  expect(posted.filter((p) => ["/probes/synthetic-east/validate", "/probes/synthetic-east/deactivate", "/probes/synthetic-east/activate"].includes(p.path)).map((p) => p.path)).toEqual([
    "/probes/synthetic-east/validate", "/probes/synthetic-east/deactivate", "/probes/synthetic-east/activate",
  ]);

  await expect.poll(() => staleManagedResponses).toBeGreaterThan(0);
  await expect(managed).toContainText("Synthetic Managed East");
  await expect(managed.getByText("Disabled", { exact: true })).toBeVisible();
  await managed.getByRole("button", { name: "Registration audit" }).click();
  const managedAudit = managed.getByRole("region", { name: "Registration audit for synthetic-managed-east" });
  await expect(managedAudit).toContainText("register");
  await expect(managedAudit).toContainText("synthetic-operator");
  await managed.getByRole("button", { name: "Suspend metadata" }).click();
  await managed.getByLabel(/Type the exact region ID/).fill("synthetic-managed-east");
  await managed.getByRole("button", { name: "Confirm metadata suspension" }).click();
  await expect(managed).toContainText("suspended");
  await expect(managed.getByText("Disabled", { exact: true })).toBeVisible();
  await managed.getByRole("button", { name: "Restore metadata" }).click();
  await managed.getByLabel(/Type the exact region ID/).fill("synthetic-managed-east");
  await managed.getByRole("button", { name: "Confirm metadata restore" }).click();
  await managed.getByRole("button", { name: "Revoke metadata" }).click();
  await managed.getByLabel(/Type the exact region ID/).fill("synthetic-managed-east");
  await managed.getByRole("button", { name: "Confirm metadata revocation" }).click();
  await expect(managed).toContainText("revoked");
  await expect(managed.getByRole("button", { name: /^(Suspend|Restore|Revoke) metadata$/ })).toHaveCount(0);
  expect(posted.filter((p) => p.path.startsWith("/managed-probes/")).map((p) => p.path)).toEqual([
    "/managed-probes/synthetic-managed-east/suspend", "/managed-probes/synthetic-managed-east/restore", "/managed-probes/synthetic-managed-east/revoke",
  ]);
  await checkA11y(page, testInfo, "operator-console-synthetic");

  // A successful search begun under the old session must not reopen an operator UI after
  // a concurrent request proves that the session has lost operator access.
  let releaseDenied!: () => void;
  let releaseSearch!: () => void;
  const deniedGate = new Promise<void>((resolve) => { releaseDenied = resolve; });
  const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
  await page.route((url) => url.pathname.startsWith("/api/operator/"), async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/operator/probes") {
      await deniedGate;
      return answer(route, 403, { error: "private server denial" });
    }
    if (url.pathname === "/api/operator/workspaces" && url.searchParams.get("q") === "delayed") {
      await searchGate;
      return answer(route, 200, { workspaces: [workspace()], next: null });
    }
    return route.fallback();
  });
  await probes.getByRole("button", { name: "Refresh regions" }).click();
  await page.getByRole("textbox", { name: "Search workspaces" }).fill("delayed");
  const requested = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/operator/workspaces" && url.searchParams.get("q") === "delayed";
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await requested;
  releaseDenied();
  await expect(page.getByRole("heading", { name: "Operator access denied" })).toBeVisible();
  const oldResponse = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === "/api/operator/workspaces" && url.searchParams.get("q") === "delayed";
  });
  releaseSearch();
  await oldResponse;
  await page.waitForTimeout(100);
  await expect(page.getByRole("heading", { name: "Operator access denied" })).toBeVisible();
  await expect(page.getByText("Synthetic Platform")).toHaveCount(0);
  await expect(page.getByText("private server denial")).toHaveCount(0);
});
