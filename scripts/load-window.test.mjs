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

test("rolling window matches a brute-force oracle across deterministic adversarial histories", () => {
  // Independent O(n²) oracle: catches off-by-one, duplicate-timestamp and sliding-pointer regressions.
  let seed = 0x12345678;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let trial = 0; trial < 200; trial++) {
    const windowSec = 1 + (next() % 15);
    const observations = [];
    const expectedHistogram = {};
    let expectedMax = 0;
    for (let monitor = 0; monitor < 1 + (next() % 6); monitor++) {
      const times = [];
      let t = next() % 20;
      for (let i = 0, count = next() % 24; i < count; i++) {
        t += next() % 5; // duplicate timestamps and window-boundary crossings
        times.push(t);
        observations.push({ id: String(monitor), t });
      }
      if (times.length) {
        let worst = 0;
        for (let i = 0; i < times.length; i++) {
          let count = 0;
          for (let j = i; j < times.length && times[j] - times[i] < windowSec; j++) count++;
          worst = Math.max(worst, count);
        }
        expectedMax = Math.max(expectedMax, worst);
        expectedHistogram[worst] = (expectedHistogram[worst] ?? 0) + 1;
      }
    }
    assert.deepEqual(densestMonitorWindow(observations, windowSec),
      { max: expectedMax, histogram: expectedHistogram }, `trial ${trial}`);
  }
});
test("invalid windows cannot make a burst disappear", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 0]) {
    assert.throws(() => densestMonitorWindow([{ id: "a", t: 1 }], value), RangeError);
  }
});
