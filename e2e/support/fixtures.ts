// Shared fixtures: every page in every engine is watched for Content Security Policy violations (reported from a
// `securitypolicyviolation` listener installed before any page script runs), uncaught page errors, console errors
// and failed HTTP responses.
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";

const CSP_PREFIX = "__MONTRAL_CSP_VIOLATION__";

export type PageGuard = {
  /** CSP violations seen so far (directive, blocked URI, path). Always fatal. */
  csp: string[];
  /** console.error messages and uncaught exceptions seen so far. */
  errors: string[];
  /** HTTP responses >= 400 that are not in EXPECTED_FAILED_RESPONSES ("METHOD /path STATUS"). */
  failedResponses: string[];
};

/**
 * Failed responses that are the designed behaviour of an anonymous visit, each with its reason. Everything else that
 * fails is reported.
 */
const EXPECTED_FAILED_RESPONSES: { method: string; path: string; status: number; why: string }[] = [
  { method: "GET", path: "/api/me", status: 401, why: "signed-out probe: landing, docs and sign-in pages ask whether a session exists" },
  { method: "GET", path: "/api/public/status/montral", status: 404, why: "landing/docs show the hosted service's own status page; a self-hosted instance has none" },
];

// Chromium also logs every failed response as a URL-less console error; failedResponses reports those with the URL.
const NETWORK_CONSOLE_ERROR = /^Failed to load resource: the server responded with a status of \d+/;

export const test = base.extend<{ guard: PageGuard }>({
  guard: [async ({ page }, use, testInfo) => {
    const guard: PageGuard = { csp: [], errors: [], failedResponses: [] };
    // A console message is the one reporting channel every engine supports and no CSP can block.
    await page.addInitScript((prefix: string) => {
      addEventListener("securitypolicyviolation", (e) => {
        console.log(prefix + JSON.stringify({
          directive: e.violatedDirective, blocked: e.blockedURI, path: location.pathname, sample: (e.sample || "").slice(0, 60),
        }));
      });
    }, CSP_PREFIX);
    const here = () => { try { return new URL(page.url()).pathname; } catch { return page.url(); } };
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith(CSP_PREFIX)) guard.csp.push(text.slice(CSP_PREFIX.length));
      else if (msg.type() === "error" && !NETWORK_CONSOLE_ERROR.test(text)) guard.errors.push(`${here()}: ${text}`);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      const method = response.request().method();
      if (EXPECTED_FAILED_RESPONSES.some((e) => e.method === method && e.path === url.pathname && e.status === response.status())) return;
      guard.failedResponses.push(`${method} ${url.origin === process.env.MONTRAL_E2E_BASE_URL ? url.pathname : url.origin + url.pathname} ${response.status()} (on ${here()})`);
    });
    page.on("pageerror", (error) => guard.errors.push(`${here()}: uncaught ${error.name}: ${error.message}`));
    await use(guard);
    if (testInfo.status !== testInfo.expectedStatus) {
      // What the page showed when the test failed, in the CI log itself. Bearer-token receiver URLs are redacted.
      const snapshot = await page.locator("body").ariaSnapshot({ timeout: 5000 }).catch((e: Error) => `unavailable: ${e.message}`);
      console.log(`FAILED PAGE ${testInfo.project.name} ${here()}:\n` +
        snapshot.replace(/\/api\/hooks\/receive\/\S+/g, "/api/hooks/receive/[redacted]").slice(0, 6000));
    }
    if (guard.errors.length) {
      testInfo.annotations.push({ type: "console-errors", description: guard.errors.slice(0, 20).join("\n") });
    }
    if (guard.failedResponses.length) {
      testInfo.annotations.push({ type: "failed-responses", description: guard.failedResponses.slice(0, 20).join("\n") });
    }
    expect(guard.csp, "Content Security Policy violations during the test").toEqual([]);
  }, { auto: true }],
});

export { expect };

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Rules switched off for the whole suite. Each needs a specific, written justification; an empty list is the goal.
 */
export const DISABLED_RULES: Record<string, string> = {};

type AxeViolation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

function describeNode(n: AxeViolation["nodes"][number]) {
  const data = n.any.find((c) => c.data && typeof c.data === "object" && "contrastRatio" in c.data)?.data as
    { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string } | undefined;
  return n.target.join(" ") + (data ? ` [${data.fgColor} on ${data.bgColor} = ${data.contrastRatio}, needs ${data.expectedContrastRatio}]` : "");
}

function describe(v: AxeViolation) {
  return `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}): ` +
    v.nodes.slice(0, 12).map(describeNode).join(" | ") +
    (v.nodes[0]?.failureSummary ? ` - ${v.nodes[0].failureSummary.replace(/\s+/g, " ").slice(0, 200)}` : "");
}

/**
 * Runs axe-core (WCAG 2.0/2.1 A and AA) on the current page. Serious and critical violations fail the test (softly,
 * so one run reports every page); moderate and minor ones are reported as annotations. The full result is attached.
 */
export async function checkA11y(page: Page, testInfo: TestInfo, name: string) {
  const results = await new AxeBuilder({ page })
    // axe's CSSOM preload re-downloads cross-origin stylesheets with XHR, which the landing page's strict connect-src
    // (rightly) blocks and reports as a CSP violation by the test tool, not the app. No WCAG A/AA rule needs it.
    .options({ preload: { assets: ["media"] } })
    .withTags(WCAG_TAGS)
    .disableRules(Object.keys(DISABLED_RULES))
    .analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const advisory = results.violations.filter((v) => !(v.impact === "serious" || v.impact === "critical"));
  for (const v of advisory) testInfo.annotations.push({ type: `a11y-${v.impact ?? "unknown"}`, description: `${name}: ${describe(v)}` });
  // printed so the CI log is the complete per-engine record, even for passing pages
  console.log(`AXE ${testInfo.project.name} ${name}: ${blocking.length} serious/critical, ${advisory.length} moderate/minor` +
    advisory.map((v) => `\n  advisory ${describe(v)}`).join(""));
  expect.soft(blocking.map(describe), `serious/critical WCAG 2.1 AA violations on ${name}`).toEqual([]);
}

/** A unique, synthetic identity for one test. */
export function synthetic(testInfo: TestInfo) {
  const id = `${testInfo.project.name.replace(/[^a-z0-9]/gi, "").toLowerCase()}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id, email: `montral-xbrowser-${id}@example.test` };
}
