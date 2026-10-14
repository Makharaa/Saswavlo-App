const test = require("node:test");
const assert = require("node:assert/strict");
const { mapEngineService } = require("../.test-build/services/map-engine.js");

test("automatic editor routing pins positions without imposing a departure bearing", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const endpoints = [[44.11, 41.98], [44.109, 41.981]];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ coordinates: endpoints, distanceMeters: 120 }) };
  };
  try {
    const result = await mapEngineService.routeLeg(endpoints, { targetHint: "selected-left-road" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/map/route");
    assert.deepEqual(calls[0].body.waypoints, endpoints);
    assert.deepEqual(calls[0].body.radiuses, [3, 3]);
    assert.deepEqual(calls[0].body.hints, [null, "selected-left-road"]);
    assert.equal("bearings" in calls[0].body, false);
    assert.deepEqual(result.coordinates, endpoints);
  } finally { global.fetch = originalFetch; }
});

test("a server routing failure does not invent a straight road automatically", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, json: async () => ({ error: "No connected road" }) });
  try {
    await assert.rejects(mapEngineService.routeLeg([[44.11, 41.98], [44.109, 41.981]]), /No connected road/);
  } finally { global.fetch = originalFetch; }
});

test("field matching sends the raw chronological measurements and supports cancellation", async () => {
  const originalFetch = global.fetch;
  const samples = [0, 1, 2].map(i => ({ lng: 44.1, lat: 41.98 + i * 0.0001, accuracy: 8, timestamp: 1800000000000 + i * 1000, speedMps: 10, heading: 0 }));
  const controller = new AbortController();
  global.fetch = async (url, options) => {
    assert.equal(url, "/api/map/match");
    assert.strictEqual(options.signal, controller.signal);
    const input = JSON.parse(options.body);
    assert.equal(input.samples.length, 3);
    assert.deepEqual(input.samples[1], { lng: samples[1].lng, lat: samples[1].lat, accuracy: 8, timestamp: samples[1].timestamp });
    assert.deepEqual(input.hints, [null, "confirmed-road", null]);
    return { ok: true, json: async () => ({ tracepoints: [], matchings: [] }) };
  };
  try { await mapEngineService.match(samples, { signal: controller.signal, hints: [null, "confirmed-road", null] }); }
  finally { global.fetch = originalFetch; }
});
