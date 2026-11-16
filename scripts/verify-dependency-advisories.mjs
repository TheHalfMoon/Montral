import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

/**
 * Fail closed on absent, malformed or incomplete package-manager output.
 * A nonzero pnpm audit exit can legitimately mean only moderate advisories.
 */
export function summarizeAdvisoryReport(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("pnpm audit did not return vulnerability metadata");
  }
  if (!report.advisories || typeof report.advisories !== "object" || Array.isArray(report.advisories)) {
    throw new Error("pnpm audit did not return an advisories collection");
  }
  const result = {};
  for (const severity of SEVERITIES) {
    const count = counts[severity];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`pnpm audit returned missing or invalid ${severity} count`);
    }
    result[severity] = count;
  }
  const total = SEVERITIES.reduce((count, severity) => count + result[severity], 0);
  if (total === 0 && Object.keys(report.advisories).length > 0) {
    throw new Error("pnpm audit metadata reports zero issues but includes advisories");
  }
  return {
    counts: result,
    total,
    blocked: result.high > 0 || result.critical > 0,
  };
}

export function parseAdvisoryOutput(stdout) {
  if (typeof stdout !== "string" || !stdout.trim()) {
    throw new Error("pnpm audit returned no JSON output");
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("pnpm audit returned malformed JSON");
  }
  return summarizeAdvisoryReport(report);
}

function run() {
  const windows = process.platform === "win32";
  const executable = windows ? process.env.ComSpec || "cmd.exe" : "pnpm";
  const args = windows ? ["/d", "/s", "/c", "pnpm.cmd audit --prod --json"] : ["audit", "--prod", "--json"];
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`pnpm audit could not complete: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pnpm audit exited with unexpected status ${result.status}`);
  }
  const summary = parseAdvisoryOutput(result.stdout);
  if (result.status === 1 && summary.total === 0) {
    throw new Error("pnpm audit exited with failure despite reporting zero advisories");
  }
  const c = summary.counts;
  console.log(
    `DEPENDENCY_AUDIT_COUNTS info=${c.info} low=${c.low} moderate=${c.moderate} high=${c.high} critical=${c.critical}`,
  );
  if (c.moderate || c.low || c.info) {
    console.warn("DEPENDENCY_AUDIT_NOTICE: low/moderate/info findings require triage; they are not release clearance.");
  }
  if (summary.blocked) {
    console.error("DEPENDENCY_AUDIT_BLOCKED: one or more high/critical dependency advisories.");
    process.exitCode = 1;
  } else {
    console.log("DEPENDENCY_AUDIT_GATE_PASS: no high/critical vulnerabilities in the audited production lock graph.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run();
  } catch (error) {
    console.error(`DEPENDENCY_AUDIT_UNVERIFIED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
