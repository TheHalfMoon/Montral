import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * All current-tree source matches are handled separately by verify-secret-scanner.mjs.
 * The archived baseline commit contains historical fixture and manifest matches
 * requiring independent historical review, so this history gate checks NEW commits.
 */
export const HISTORY_START_COMMIT = "dc02d027768c2ee9c9d1c05d98e1d1832cef36a4";

export function interpretHistoryScan(status, report, reportExists) {
  if (status !== 0 && status !== 7) {
    throw new Error("History scanner failed or timed out");
  }
  if (!reportExists) {
    if (status === 7) throw new Error("History scanner reported matches but omitted the report");
    return { total: 0, blocked: false };
  }
  if (report !== null && !Array.isArray(report)) {
    throw new Error("History scanner returned invalid JSON findings");
  }
  const items = report ?? [];
  if (status === 0 && items.length > 0) {
    throw new Error("History scanner reported findings despite successful exit");
  }
  if (status === 7 && items.length === 0) {
    throw new Error("History scanner returned no findings despite match exit");
  }
  for (const hit of items) {
    if (
      !hit || typeof hit.File !== "string" ||
      typeof hit.RuleID !== "string" ||
      !/^[a-f0-9]{40}$/.test(hit.Commit) ||
      !Number.isSafeInteger(hit.StartLine) || hit.StartLine < 1
    ) {
      throw new Error("History scanner produced invalid finding metadata");
    }
  }
  return { total: items.length, blocked: items.length > 0 };
}

function gitCommand(args, root) {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Required complete Git history or baseline revision was unavailable");
  }
  return result.stdout.trim();
}

function scan() {
  const root = process.cwd();
  if (!/^[a-f0-9]{40}$/.test(HISTORY_START_COMMIT)) {
    throw new Error("Historical baseline commit is not pinned to a full Git object ID");
  }
  if (gitCommand(["rev-parse", "--is-shallow-repository"], root) !== "false") {
    throw new Error("A complete checkout is required to audit history; fetch-depth: 0");
  }
  gitCommand(["merge-base", "--is-ancestor", HISTORY_START_COMMIT, "HEAD"], root);
  const commits = Number(gitCommand(["rev-list", "--count", `${HISTORY_START_COMMIT}..HEAD`], root));
  if (!Number.isSafeInteger(commits) || commits < 0) {
    throw new Error("Could not count Git commits since history baseline");
  }

  const binary = process.env.GITLEAKS_BIN || "gitleaks";
  const temp = mkdtempSync(path.join(tmpdir(), "montral-history-secret-"));
  const reportPath = path.join(temp, "history-findings.json");
  try {
    const run = spawnSync(binary, [
      "git", ".", `--log-opts=${HISTORY_START_COMMIT}..HEAD`,
      "--no-banner", "--log-level", "error",
      "--redact=100", "--timeout", "180",
      "--report-format", "json", "--report-path", reportPath,
      "--exit-code", "7",
    ], {
      cwd: root, encoding: "utf8", timeout: 210_000,
      maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (run.error) throw new Error("Historical source scanner could not finish");
    const reportExists = existsSync(reportPath);
    let report;
    if (reportExists) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        throw new Error("Historical source scanner returned malformed JSON");
      }
    }
    const verdict = interpretHistoryScan(run.status, report, reportExists);
    console.log(
      `HISTORY_SECRET_SCAN_COUNTS commits_after_baseline=${commits} new_matches=${verdict.total}`,
    );
    if (verdict.blocked) {
      // Never log the matched text, secret, diff, evidence body or scanner report.
      console.error("HISTORY_SECRET_SCAN_BLOCKED: new committed secret patterns detected.");
      for (const hit of report.slice(0, 20)) {
        console.error(
          `HISTORY_SECRET_SCAN_LOCATION commit=${hit.Commit.slice(0, 12)} file=${hit.File.replace(/[^\x20-\x7e]/g,"?").slice(0,180)} line=${hit.StartLine} rule=${hit.RuleID}`,
        );
      }
      process.exitCode = 1;
    } else {
      console.log("HISTORY_SECRET_SCAN_GATE_PASS: no new secret patterns introduced after the archived baseline.");
    }
  } finally {
    // A history report may contain secrets even if redaction is requested.
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    scan();
  } catch (error) {
    console.error(
      `HISTORY_SECRET_SCAN_UNVERIFIED: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
    process.exitCode = 2;
  }
}
