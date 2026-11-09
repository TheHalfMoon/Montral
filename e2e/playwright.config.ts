// Cross-browser and WCAG 2.1 AA qualification of the built self-hosted Node server. Run from the repo root after
// building (see .github/workflows/montral-browsers.yml):
//   TEST_DATABASE_URL=postgres://.../montral_test_xbrowser pnpm --filter @montral/e2e test
// global-setup.ts starts the server on a free local port against the disposable database and stops it afterwards.
import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  forbidOnly: CI,
  // a flaky engine is a finding, not something to retry away
  retries: 0,
  workers: CI ? 3 : 2,
  fullyParallel: true,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 14"] } },
  ],
});
