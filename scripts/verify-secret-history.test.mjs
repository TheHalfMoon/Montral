import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_START_COMMIT, interpretHistoryScan } from "./verify-secret-history.mjs";

const finding = {
  Commit: "a".repeat(40),
  File: "apps/api/src/sample.test.ts",
  StartLine: 3,
  RuleID: "generic-api-key",
};

test("baseline remains a full 40-character git SHA", () => {
  assert.match(HISTORY_START_COMMIT, /^[0-9a-f]{40}$/);
});

test("complete scan with zero matches passes", () => {
  assert.deepEqual(interpretHistoryScan(0, null, false), { total: 0, blocked: false });
  assert.deepEqual(interpretHistoryScan(0, [], true), { total: 0, blocked: false });
  assert.deepEqual(interpretHistoryScan(0, null, true), { total: 0, blocked: false });
});

test("a historical finding after the baseline blocks", () => {
  assert.deepEqual(interpretHistoryScan(7, [finding], true), { total: 1, blocked: true });
  assert.deepEqual(interpretHistoryScan(7, [finding, finding], true), { total: 2, blocked: true });
});

test("scanner error, timeout and unknown exit always fail closed", () => {
  for (const status of [null, -1, 1, 2, 124, 127]) {
    assert.throws(() => interpretHistoryScan(status, [], true), /failed or timed out/);
  }
});

test("an absent report after finding exit is not silently accepted", () => {
  assert.throws(() => interpretHistoryScan(7, undefined, false), /omitted/);
});

test("contradictory clean exit with findings is refused", () => {
  assert.throws(() => interpretHistoryScan(0, [finding], true), /despite successful exit/);
});

test("contradictory match exit with empty findings is refused", () => {
  assert.throws(() => interpretHistoryScan(7, [], true), /no findings/);
  assert.throws(() => interpretHistoryScan(7, null, true), /no findings/);
});

test("missing and nonarray reports fail closed", () => {
  assert.throws(() => interpretHistoryScan(0, {}, true), /invalid JSON/);
  assert.throws(() => interpretHistoryScan(7, {}, true), /invalid JSON/);
});

test("partial finding metadata cannot pass the gate", () => {
  for (const item of [
    { ...finding, Commit: "" },
    { ...finding, Commit: "not-a-full-sha" },
    { ...finding, RuleID: null },
    { ...finding, File: null },
    { ...finding, StartLine: 0 },
    { ...finding, StartLine: "3" },
  ]) {
    assert.throws(() => interpretHistoryScan(7, [item], true), /invalid finding metadata/);
  }
});
