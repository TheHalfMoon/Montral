import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdvisoryOutput, summarizeAdvisoryReport } from "./verify-dependency-advisories.mjs";

const counts = (updates = {}) => ({
  info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...updates,
});
const report = (updates = {}, advisories = {}) => ({
  metadata: { vulnerabilities: counts(updates) },
  advisories,
});

test("zero advisories allow the security gate", () => {
  const result = parseAdvisoryOutput(JSON.stringify(report()));
  assert.equal(result.total, 0);
  assert.equal(result.blocked, false);
});

test("low and moderate issues are visible but not blocking", () => {
  const result = summarizeAdvisoryReport(report({ low: 1, moderate: 2 }, { "123": {} }));
  assert.equal(result.total, 3);
  assert.equal(result.blocked, false);
});

test("high issues block the security gate", () => {
  const result = summarizeAdvisoryReport(report({ high: 1 }, { "1": {} }));
  assert.equal(result.blocked, true);
});

test("critical issues block the security gate regardless of other counts", () => {
  const result = summarizeAdvisoryReport(report({ critical: 1, moderate: 9 }, { "1": {} }));
  assert.equal(result.blocked, true);
});

test("a missing advisories object never counts as a clean scan", () => {
  assert.throws(() => summarizeAdvisoryReport({ metadata: { vulnerabilities: counts() } }), /advisories collection/);
});

test("a missing metadata object never counts as a clean scan", () => {
  assert.throws(() => summarizeAdvisoryReport({ advisories: {} }), /vulnerability metadata/);
});

test("incomplete or nonnumeric vulnerability counts are refused", () => {
  for (const bad of [null, "0", -1, 0.2, Number.NaN]) {
    assert.throws(() => summarizeAdvisoryReport(report({ critical: bad })), /invalid critical/);
  }
  const bad = report();
  delete bad.metadata.vulnerabilities.high;
  assert.throws(() => summarizeAdvisoryReport(bad), /invalid high/);
});

test("conflicting clean metadata with nonempty advisories is refused", () => {
  assert.throws(() => summarizeAdvisoryReport(report({}, { "unexpected": {} })), /zero issues/);
});

test("malformed or absent JSON is refused", () => {
  assert.throws(() => parseAdvisoryOutput(""), /no JSON/);
  assert.throws(() => parseAdvisoryOutput("NOT_JSON"), /malformed JSON/);
  assert.throws(() => parseAdvisoryOutput('{"advisories":{}'), /malformed JSON/);
});

test("array-shaped advisories and counts are not accepted", () => {
  const brokenAdvisories = report();
  brokenAdvisories.advisories = [];
  assert.throws(() => summarizeAdvisoryReport(brokenAdvisories), /advisories collection/);
  const brokenCounts = report();
  brokenCounts.metadata.vulnerabilities = [];
  assert.throws(() => summarizeAdvisoryReport(brokenCounts), /vulnerability metadata/);
});

test("positive vulnerability counts with no advisory records are always rejected", () => {
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    const incomplete = report({ [severity]: 1 });
    assert.throws(() => summarizeAdvisoryReport(incomplete), /no advisory records/);
    assert.throws(() => parseAdvisoryOutput(JSON.stringify(incomplete)), /no advisory records/);
  }
});

test("advisory record count need not match affected dependency count", () => {
  const result = summarizeAdvisoryReport(report(
    { low: 3, moderate: 2 },
    { "one-shared-advisory": { severity: "moderate" } },
  ));
  assert.equal(result.total, 5);
  assert.equal(result.blocked, false);
});

test("one advisory with critical and moderate exposures still blocks", () => {
  const result = summarizeAdvisoryReport(report(
    { critical: 1, moderate: 4 },
    { "one-shared-advisory": { severity: "critical" } },
  ));
  assert.equal(result.total, 5);
  assert.equal(result.blocked, true);
});