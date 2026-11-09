// Shared fixtures: every page in every engine is watched for Content Security Policy violations (reported from a
// `securitypolicyviolation` listener installed before any page script runs), uncaught page errors and console errors.
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";

const CSP_PREFIX = "__MONTRAL_CSP_VIOLATION__";

export type PageGuard = {
  /** CSP violations seen so far (directive, blocked URI, path). Always fatal. */
  csp: string[];
  /** console.error messages and uncaught exceptions seen so far. */
  errors: string[];
};

export const test = base.extend<{ guard: PageGuard }>({
  guard: [async ({ page }, use, testInfo) => {
    const guard: PageGuard = { csp: [], errors: [] };
    // A console message is the one reporting channel every engine supports and no CSP can block.
    await page.addInitScript((prefix: string) => {
      addEventListener("securitypolicyviolation", (e) => {
        console.log(prefix + JSON.stringify({
          directive: e.violatedDirective, blocked: e.blockedURI, path: location.pathname, sample: (e.sample || "").slice(0, 60),
        }));
      });
    }, CSP_PREFIX);
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith(CSP_PREFIX)) guard.csp.push(text.slice(CSP_PREFIX.length));
      else if (msg.type() === "error") guard.errors.push(`${new URL(page.url()).pathname}: ${text}`);
    });
    page.on("pageerror", (error) => guard.errors.push(`${new URL(page.url()).pathname}: uncaught ${error.name}: ${error.message}`));
    await use(guard);
    if (guard.errors.length) {
      testInfo.annotations.push({ type: "console-errors", description: guard.errors.slice(0, 20).join("\n") });
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

/**
 * Runs axe-core (WCAG 2.0/2.1 A and AA) on the current page. Serious and critical violations fail the test (softly,
 * so one run reports every page); moderate and minor ones are reported as annotations. The full result is attached.
 */
export async function checkA11y(page: Page, testInfo: TestInfo, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(Object.keys(DISABLED_RULES))
    .analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  const describe = (v: (typeof results.violations)[number]) =>
    `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}: ` +
    v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ") + ")" +
    (v.nodes[0]?.failureSummary ? ` - ${v.nodes[0].failureSummary.replace(/\s+/g, " ").slice(0, 240)}` : "");
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const advisory = results.violations.filter((v) => !(v.impact === "serious" || v.impact === "critical"));
  for (const v of advisory) testInfo.annotations.push({ type: `a11y-${v.impact ?? "unknown"}`, description: `${name}: ${describe(v)}` });
  expect.soft(blocking.map(describe), `serious/critical WCAG 2.1 AA violations on ${name}`).toEqual([]);
}

/** A unique, synthetic identity for one test. */
export function synthetic(testInfo: TestInfo) {
  const id = `${testInfo.project.name.replace(/[^a-z0-9]/gi, "").toLowerCase()}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id, email: `montral-xbrowser-${id}@example.test` };
}
