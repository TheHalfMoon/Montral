import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../env";
import { allow } from "../ratelimit";

const month = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
const reviewSchema = z.object({
  month,
  recipientUserId: z.string().min(1).max(200),
  decision: z.enum(["provider_accepted", "unresolved"]),
  evidenceRef: z.string().regex(/^[A-Za-z0-9._:/-]{8,160}$/),
  // An explicit assertion is essential: a provider timeout is not evidence of
  // acceptance, and this endpoint must never be a "retry" button.
  acknowledgment: z.literal("I_verified_external_provider_evidence"),
}).strict();
const summarySchema = z.object({ month });

/** Staged-only, owner-authenticated operator routes. OFF by default.
 * Never allow a bearer/API key to impersonate the reviewing human. This is
 * not a production rollout or an independent verification of SMTP evidence. */
export const monthlyReconciliation = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    if (c.env.MONTRAL_RECONCILIATION_ENABLED !== "true" || !c.get("entitlements").claimMonthlyOutboxAttempt)
      return c.json({ error: "Not found" }, 404);
    // Require actual Better Auth session, not API keys / OAuth robot grants.
    if (c.get("requestPrincipal")?.kind !== "session" || c.get("workspaceGrant") !== null)
      return c.json({ error: "Signed-in session required" }, 403);
    if (await c.get("repo").memberRole(c.get("userId"), c.get("orgId")) !== "owner")
      return c.json({ error: "Workspace owner required" }, 403);
    c.header("cache-control", "no-store");
    await next();
  })
  .get("/summary", zValidator("query", summarySchema), async (c) => {
    const { month: m } = c.req.valid("query");
    const result = await c.get("repo").monthlyReportReconciliationSummary(c.get("orgId"), m, c.get("userId"));
    return c.json(result);
  })
  .post("/review", async (c, next) => {
    // Strict Origin and JSON, independent of CORS, to prevent cookie-based
    // cross-origin CSRF and simple form submissions. No origin = refused.
    const origin = c.req.header("origin");
    if (!origin || origin !== c.env.WEB_ORIGIN) return c.json({ error: "Origin not allowed" }, 403);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(c.req.header("content-type") ?? ""))
      return c.json({ error: "JSON required" }, 415);
    const key = `monthly-reconcile:${c.get("orgId")}:${c.get("userId")}`;
    if (!(await allow(c.get("repo"), key, 12, 3600)))
      return c.json({ error: "Too many reviews" }, 429);
    await next();
  }, zValidator("json", reviewSchema), async (c) => {
    const body = c.req.valid("json");
    const applied = await c.get("repo").reconcileMonthlyReportRecipient(
      c.get("orgId"), body.month, body.recipientUserId, c.get("userId"), body.decision, body.evidenceRef,
    );
    // No user-address, raw evidence or recipient record returned. A declined
    // review may mean in-flight, already reviewed or missing scoped record.
    return c.json({ applied });
  });
