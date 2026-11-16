import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedFixtureReport, lineHash } from "./verify-secret-scanner.mjs";

const file = "apps/api/src/synthetic.test.ts";
const rule = "generic-api-key";
const line = 'const fixture = "only-a-synthetic-test-value";';
const match = { File: file, StartLine: 12, RuleID: rule };
const fixture = {
  file, line: 12, rule, sha256: lineHash(line), count: 1,
  reason: "generated synthetic test fixture",
};
const reader = (_file, _line) => line;

test("reviewed exact source-line fixture is allowed", () => {
  const result = approvedFixtureReport([match], [fixture], reader);
  assert.deepEqual(result, { unexpected: [], stale: 0, scanned: 1 });
});

test("a new token on the same file and line cannot reuse the approval", () => {
  const changed = approvedFixtureReport([match], [fixture], () => line + "-changed");
  assert.equal(changed.unexpected.length, 1);
  assert.equal(changed.stale, 1);
});

test("a match at a new line is never approved", () => {
  const result = approvedFixtureReport([{ ...match, StartLine: 13 }], [fixture], reader);
  assert.equal(result.unexpected.length, 1);
});

test("a match under another detection rule is never approved", () => {
  const result = approvedFixtureReport([{ ...match, RuleID: "private-key" }], [fixture], reader);
  assert.equal(result.unexpected.length, 1);
});

test("a match under another path is never approved", () => {
  const result = approvedFixtureReport([{ ...match, File: "src/other.ts" }], [fixture], reader);
  assert.equal(result.unexpected.length, 1);
});

test("one approval never hides a second match on the same line", () => {
  const result = approvedFixtureReport([match, match], [fixture], reader);
  assert.equal(result.unexpected.length, 1);
  assert.equal(result.stale, 0);
});

test("reviewed duplicate matches require an exact count", () => {
  const result = approvedFixtureReport([match, match], [{ ...fixture, count: 2 }], reader);
  assert.equal(result.unexpected.length, 0);
  assert.equal(result.stale, 0);
});

test("stale fixture approvals fail even when the source scanner is empty", () => {
  const result = approvedFixtureReport([], [fixture], reader);
  assert.equal(result.stale, 1);
});

test("an empty scanner report and empty fixture set are valid", () => {
  assert.deepEqual(approvedFixtureReport([], [], reader), { unexpected: [], stale: 0, scanned: 0 });
});

test("invalid report and invalid fixture collections are rejected", () => {
  assert.throws(() => approvedFixtureReport({}, [], reader), /malformed/);
  assert.throws(() => approvedFixtureReport([], {}, reader), /malformed/);
});

test("invalid fixture metadata, missing hashes and repeated allowances are rejected", () => {
  assert.throws(() => approvedFixtureReport([], [{ ...fixture, sha256: "abc" }], reader), /invalid/);
  assert.throws(() => approvedFixtureReport([], [{ ...fixture, reason: "" }], reader), /invalid/);
  assert.throws(() => approvedFixtureReport([], [fixture, fixture], reader), /Duplicate/);
});

test("invalid finding metadata is rejected without looking up source content", () => {
  assert.throws(() => approvedFixtureReport([{ ...match, StartLine: -1 }], [fixture], reader), /invalid/);
  assert.throws(() => approvedFixtureReport([{ ...match, RuleID: null }], [fixture], reader), /invalid/);
});
