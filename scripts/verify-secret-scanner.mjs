import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const lineHash = (text) => createHash("sha256").update(text).digest("hex");

export function approvedFixtureReport(findings, approved, getLine) {
  if (!Array.isArray(findings) || !Array.isArray(approved)) {
    throw new Error("Secret scan results or reviewed fixtures are malformed");
  }
  const allowances = new Map();
  for (const fixture of approved) {
    if (
      !fixture || typeof fixture.file !== "string" ||
      typeof fixture.rule !== "string" ||
      !Number.isSafeInteger(fixture.line) || fixture.line < 1 ||
      !/^[0-9a-f]{64}$/.test(fixture.sha256) ||
      !Number.isSafeInteger(fixture.count) || fixture.count < 1 ||
      typeof fixture.reason !== "string" || !fixture.reason.trim()
    ) {
      throw new Error("Reviewed fixture record is invalid");
    }
    const key = [fixture.file, fixture.line, fixture.rule, fixture.sha256].join("\t");
    if (allowances.has(key)) throw new Error("Duplicate reviewed fixture record");
    allowances.set(key, fixture.count);
  }
  const unexpected = [];
  for (const finding of findings) {
    if (
      !finding || typeof finding.File !== "string" ||
      typeof finding.RuleID !== "string" ||
      !Number.isSafeInteger(finding.StartLine) || finding.StartLine < 1
    ) {
      throw new Error("Secret scan finding metadata is invalid");
    }
    const sourceLine = getLine(finding.File, finding.StartLine);
    const key = [finding.File, finding.StartLine, finding.RuleID, lineHash(sourceLine)].join("\t");
    const remaining = allowances.get(key) ?? 0;
    if (remaining > 0) allowances.set(key, remaining - 1);
    else unexpected.push({
      file: finding.File,
      line: finding.StartLine,
      rule: finding.RuleID,
    });
  }
  const stale = Array.from(allowances.values()).reduce((sum, remaining) => sum + remaining, 0);
  return { unexpected, stale, scanned: findings.length };
}

function scan() {
  const root = process.cwd();
  const fixtures = JSON.parse(
    readFileSync(new URL("./secret-scan-synthetic-fixtures.json", import.meta.url), "utf8"),
  );
  const binary = process.env.GITLEAKS_BIN || "gitleaks";
  const temp = mkdtempSync(path.join(tmpdir(), "montral-secret-audit-"));
  const reportPath = path.join(temp, "findings.json");
  try {
    const run = spawnSync(binary, [
      "dir", ".", "--no-banner", "--log-level", "error",
      "--redact=100", "--timeout", "120",
      "--report-format", "json", "--report-path", reportPath,
      "--exit-code", "7",
    ], {
      cwd: root, encoding: "utf8", timeout: 150_000,
      maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (run.error) throw new Error("Secret scanner could not finish");
    if (run.status !== 0 && run.status !== 7) {
      throw new Error("Secret scanner failed or timed out");
    }
    let findings = [];
    if (existsSync(reportPath)) {
      const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
      if (parsed !== null && !Array.isArray(parsed)) {
        throw new Error("Secret scanner returned malformed report");
      }
      findings = parsed ?? [];
    } else if (run.status === 7) {
      throw new Error("Secret scanner found matches but did not provide a report");
    }
    if ((run.status === 7) !== (findings.length > 0)) {
      throw new Error("Secret scanner exit status contradicts its report");
    }
    const fileCache = new Map();
    const getLine = (reported, lineNumber) => {
      if (reported.includes("\0")) throw new Error("Secret scan path is invalid");
      const resolved = path.resolve(root, reported);
      const relative = path.relative(root, resolved).replaceAll("\\", "/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new Error("Secret scan reported a path outside the repository");
      }
      if (!fileCache.has(relative)) {
        fileCache.set(relative, readFileSync(resolved, "utf8").split(/\r?\n/));
      }
      const content = fileCache.get(relative)[lineNumber - 1];
      if (content === undefined) throw new Error("Secret scan reported a missing source line");
      return content;
    };
    // Normalize OS-specific path separators before looking up exact reviewed fixtures.
    const normalized = findings.map((finding) => {
      if (typeof finding?.File !== "string") throw new Error("Missing finding path");
      const resolved = path.resolve(root, finding.File);
      const relative = path.relative(root, resolved).replaceAll("\\", "/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new Error("Secret scan reported a path outside the repository");
      }
      return { File: relative, RuleID: finding.RuleID, StartLine: finding.StartLine };
    });
    const verdict = approvedFixtureReport(normalized, fixtures, getLine);
    console.log(
      `SECRET_SCAN_COUNTS matches=${verdict.scanned} reviewed_fixtures=${verdict.scanned - verdict.unexpected.length} unexpected=${verdict.unexpected.length} stale=${verdict.stale}`,
    );
    for (const item of verdict.unexpected.slice(0, 20)) {
      console.error(`SECRET_SCAN_UNREVIEWED file=${item.file} line=${item.line} rule=${item.rule}`);
    }
    if (verdict.unexpected.length || verdict.stale) {
      console.error("SECRET_SCAN_BLOCKED: new matches or changed/stale synthetic fixtures require review");
      process.exitCode = 1;
    } else {
      console.log("SECRET_SCAN_GATE_PASS: no new matches beyond exact-line reviewed synthetic fixtures");
    }
  } finally {
    // The scanner report can contain sensitive matches: never persist it or log its body.
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    scan();
  } catch (error) {
    console.error(`SECRET_SCAN_UNVERIFIED: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 2;
  }
}
