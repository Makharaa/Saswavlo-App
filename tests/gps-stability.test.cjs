const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGpsFilterState, filterGpsSample } = require("../.test-build/utils/gps-filter.js");
const t0 = 1800000000000;
const raw = (meters, sec, speedMps = 0) => ({ lng: 44.1, lat: 41.98 + meters / 111195,
  accuracy: 3, timestamp: t0 + sec * 1000, speedMps, heading: speedMps ? 0 : null });

test("a reliable stop reaches the measured stop position then ignores stationary drift", () => {
  let state = createGpsFilterState();
  state = filterGpsSample(state, raw(0, 0, 10), t0).state;
  const stop = raw(10, 1);
  state = filterGpsSample(state, stop, stop.timestamp).state;
  assert.equal(state.filtered.lat, stop.lat);
  for (let i = 2; i < 20; i++) {
    const fix = raw(10 + (i % 2 ? 3 : -3), i);
    state = filterGpsSample(state, fix, fix.timestamp).state;
    assert.equal(state.filtered.lat, stop.lat);
    assert.equal(state.filtered.speedMps, 0);
  }
  const moving = raw(20, 20, 10);
  const next = filterGpsSample(state, moving, moving.timestamp);
  assert.equal(next.reason, null);
  assert.ok(next.sample.lat > stop.lat);
});

test("a GPS jump at ordinary apparent speed is rejected if device speed contradicts it", () => {
  const first = raw(0, 0, 5);
  const state = filterGpsSample(createGpsFilterState(), first, first.timestamp).state;
  const jump = raw(50, 1, 5); // 180 km/h is below the old 220 km/h-only gate.
  assert.equal(filterGpsSample(state, jump, jump.timestamp).reason, "impossible_jump");
});

test("holding unknown-speed drift never manufactures high-confidence stop evidence", () => {
  let state = createGpsFilterState();
  let held;
  for (let i = 0; i < 6; i++) {
    const fix = { ...raw(i % 2 ? 2 : 0, i, null), accuracy: 8 };
    const result = filterGpsSample(state, fix, fix.timestamp);
    state = result.state;
    held ??= result.sample.lat;
    assert.equal(result.sample.lat, held);
    assert.notEqual(result.sample.speedConfidence, "high");
  }
});
