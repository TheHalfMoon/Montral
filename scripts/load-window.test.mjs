import test from "node:test";
import assert from "node:assert/strict";
import { densestMonitorWindow } from "./load-window.mjs";

test("empty data is not mistaken for a completed recovery", () => {
  assert.deepEqual(densestMonitorWindow([], 60), { max: 0, histogram: {} });
});
test("rolling window catches bursts across fixed bucket boundaries", () => {
  const obs = [{ id: "a", t: 59 }, { id: "a", t: 60 }, { id: "a", t: 61 }];
  assert.deepEqual(densestMonitorWindow(obs, 60), { max: 3, histogram: { 3: 1 } });
});
test("exact boundary excluded, equal timestamps included", () => {
  const obs = [{ id: "a", t: 0 }, { id: "a", t: 0 }, { id: "a", t: 60 }];
  assert.equal(densestMonitorWindow(obs, 60).max, 2);
});
test("monitors isolated and histogram counts monitors", () => {
  const obs = [{ id: "a", t: 0 }, { id: "a", t: 1 }, { id: "b", t: 0 }];
  assert.deepEqual(densestMonitorWindow(obs, 60), { max: 2, histogram: { 1: 1, 2: 1 } });
});
test("malformed data cannot under-report bursts", () => {
  assert.throws(() => densestMonitorWindow([{ id: "a", t: 2 }, { id: "a", t: 1 }], 60), /ordered/);
  assert.throws(() => densestMonitorWindow([{ id: "a", t: 0 }, { id: "b", t: 1 }, { id: "a", t: 2 }], 60), /grouped/);
  assert.throws(() => densestMonitorWindow([{ id: "a", t: NaN }], 60), /finite/);
  assert.throws(() => densestMonitorWindow([{ id: "a", t: 0 }], 0), /positive/);
});