const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FieldRecordingBuffer } = require("../.test-build/utils/field-recording.js");
const { confirmRoadSection, parseRoadTraceMatch, validRoadMatchFixes } = require("../.test-build/utils/road-trace-match.js");
const { haversineMeters } = require("../.test-build/utils/geo.js");
const t0 = 1800000000000;
const coordinate = (x, y = 0) => [44.1 + x / (111195 * Math.cos(41.98 * Math.PI / 180)), 41.98 + y / 111195];
const fix = (x, y, second, speedMps = 10, accuracy = 8) => {
  const [lng, lat] = coordinate(x, y);
  return { lng, lat, timestamp: t0 + second * 1000, accuracy, speedMps, heading: null };
};
const observation = raw => ({ raw, sample: raw, accepted: true, visible: true, observedAt: raw.timestamp });
const ingest = (buffer, samples) => samples.forEach(s => buffer.ingest(observation(s)));
const match = (coordinates, alternatives = [], confidence = 0.99) => ({
  tracepoints: coordinates.map((c, i) => ({ coordinate: c, matchingIndex: 0, waypointIndex: i, alternatives: alternatives[i] ?? 0, hint: `road-${i}` })),
  matchings: [{ confidence, legs: coordinates.slice(1).map((c, i) => [coordinates[i], c]) }],
});
const osrmBody = coordinates => ({ code: "Ok", tracepoints: coordinates.map((location, i) => ({ location, matchings_index: 0, waypoint_index: i, alternatives_count: 0 })),
  matchings: [{ confidence: 0.99, legs: coordinates.slice(1).map((c, i) => ({ steps: [{ geometry: { coordinates: [coordinates[i], c] } }] })) }] });

test("noisy fixes on a straight road are matched as a chronological window, never independent nearest points", () => {
  const buffer = new FieldRecordingBuffer();
  ingest(buffer, [fix(0, 0, 0), fix(7, 10, 1), fix(-7, 20, 2), fix(6, 30, 3), fix(-6, 40, 4)]);
  const request = buffer.request();
  assert.equal(request.samples.length, 5);
  assert.equal(buffer.confirm(request, match([0, 10, 20, 30, 40].map(y => coordinate(0, y)))), true);
  assert.deepEqual(buffer.points, [0, 10, 20].map(y => coordinate(0, y)));
  assert.equal(buffer.pendingCount, 2);
  assert.equal(buffer.observations[1].raw.lng, coordinate(7, 10)[0]);
});

test("an ambiguous intersection is deferred and the confirmed prefix never changes", () => {
  const buffer = new FieldRecordingBuffer();
  const samples = [0, 10, 20, 30, 40].map((y, i) => fix(0, y, i));
  ingest(buffer, samples);
  const request = buffer.request();
  assert.equal(buffer.confirm(request, match(samples.map(s => [s.lng, s.lat]), [0, 0, 2, 1, 0])), true);
  const prefix = [...buffer.points];
  assert.deepEqual(prefix, [coordinate(0, 0), coordinate(0, 10)]);
  assert.equal(buffer.confirm(buffer.request(true), match(samples.map(s => [s.lng, s.lat]), [], 0.3)), false);
  assert.deepEqual(buffer.points, prefix);
  assert.equal(buffer.issue, "ambiguous");
  assert.equal(buffer.pendingCount, 3);
});

test("a real turn retains road curve vertices instead of drawing a chord", () => {
  const samples = [fix(0, 0, 0), fix(0, 10, 1), fix(10, 20, 2), fix(20, 20, 3), fix(30, 20, 4)];
  const output = match(samples.map(s => [s.lng, s.lat]));
  output.matchings[0].legs[1] = [coordinate(0, 10), coordinate(0, 16), coordinate(4, 20), coordinate(10, 20)];
  const section = confirmRoadSection(samples, output, null, null, true).section;
  assert.ok(section);
  assert.ok(section.coordinates.some(c => c[0] === coordinate(0, 16)[0] && c[1] === coordinate(0, 16)[1]));
  assert.deepEqual(section.coordinates.at(-1), coordinate(30, 20));
});

test("returning on the same road preserves each visit and its direction", () => {
  const samples = [0, 15, 30, 15, 0].map((y, i) => fix(0, y, i));
  const section = confirmRoadSection(samples, match(samples.map(s => [s.lng, s.lat])), null, null, true).section;
  assert.deepEqual(section.coordinates, [0, 15, 30, 15, 0].map(y => coordinate(0, y)));
});

test("standing still holds the confirmed marker and adds no zigzags", () => {
  const buffer = new FieldRecordingBuffer();
  const samples = [fix(0, 0, 0), fix(0, 10, 1), fix(0, 20, 2, 0)];
  ingest(buffer, samples);
  assert.equal(buffer.confirm(buffer.request(true), match(samples.map(s => [s.lng, s.lat]))), true);
  const points = [...buffer.points];
  for (let i = 3; i < 40; i++) buffer.ingest(observation(fix(i % 2 ? 5 : -5, 20, i, 0)));
  assert.deepEqual(buffer.points, points);
  assert.equal(buffer.pendingCount, 0);
  assert.deepEqual([buffer.roadSample.lng, buffer.roadSample.lat], coordinate(0, 20));
  assert.ok(buffer.observations.length > 30);
});

test("moderate GPS teleportation inconsistent with measured motion is rejected", () => {
  const buffer = new FieldRecordingBuffer();
  ingest(buffer, [fix(0, 0, 0, 5, 3), fix(0, 50, 1, 5, 3)]);
  assert.equal(buffer.fixes.length, 1);
  assert.equal(buffer.issue, "jump");
  assert.equal(buffer.rejectedSamples, 1);
});

test("poor fixes and network failure preserve evidence without switching to a raw marker", () => {
  const buffer = new FieldRecordingBuffer();
  const samples = [0, 10, 20].map((y, i) => fix(0, y, i));
  ingest(buffer, samples);
  buffer.confirm(buffer.request(true), match(samples.map(s => [s.lng, s.lat])));
  const held = buffer.roadSample;
  buffer.ingest(observation(fix(40, 30, 3, 10, 60)));
  assert.strictEqual(buffer.roadSample, held);
  buffer.issue = "unavailable";
  buffer.ingest(observation(fix(0, 30, 4)));
  assert.strictEqual(buffer.roadSample, held);
  assert.equal(buffer.pendingCount, 1);
  assert.equal(buffer.observations.at(-2).raw.accuracy, 60);
});

test("split matches and real GPS gaps cannot be joined by a straight line", () => {
  const samples = [0, 10, 20, 30].map((y, i) => fix(0, y, i));
  const split = match(samples.map(s => [s.lng, s.lat]));
  split.matchings.push(split.matchings[0]);
  split.tracepoints[2].matchingIndex = 1;
  const result = confirmRoadSection(samples, split, 0, coordinate(0, 0), true);
  assert.equal(result.section, null);
  assert.equal(result.reason, "gap");
  assert.equal(confirmRoadSection(samples, split, null, null, true).reason, "gap");
  const buffer = new FieldRecordingBuffer();
  ingest(buffer, [fix(0, 0, 0), fix(0, 200, 30)]);
  assert.equal(buffer.gap, true);
  assert.equal(buffer.request(), null);
  assert.equal(buffer.points.length, 0);
});

test("explicitly finishing only the confirmed part preserves the discarded raw evidence", () => {
  const buffer = new FieldRecordingBuffer();
  const samples = [0, 10, 20, 30, 40].map((y, i) => fix(0, y, i));
  ingest(buffer, samples);
  buffer.confirm(buffer.request(), match(samples.map(s => [s.lng, s.lat])));
  const prefix = [...buffer.points];
  buffer.gap = true;
  buffer.finishConfirmedPart();
  assert.equal(buffer.pendingCount, 0);
  assert.equal(buffer.gap, false);
  assert.deepEqual(buffer.points, prefix);
  assert.equal(buffer.observations.length, 5);
});

test("an invented side-road detour is rejected even with a high matching confidence", () => {
  const samples = [0, 10, 20].map((y, i) => fix(0, y, i, 10, 3));
  const output = match(samples.map(s => [s.lng, s.lat]));
  output.matchings[0].legs[0] = [coordinate(0, 0), coordinate(70, 0), coordinate(70, 10), coordinate(0, 10)];
  assert.equal(confirmRoadSection(samples, output, null, null, true).reason, "detour");
});

test("finishing does not silently drop an ambiguous tail and pending fixes survive restore", () => {
  const buffer = new FieldRecordingBuffer();
  const samples = [0, 10, 20, 30, 40].map((y, i) => fix(0, y, i));
  ingest(buffer, samples);
  buffer.confirm(buffer.request(), match(samples.map(s => [s.lng, s.lat])));
  const restored = new FieldRecordingBuffer(buffer.points, buffer.snapshot());
  const request = restored.request(true);
  const output = match(request.samples.map(s => [s.lng, s.lat]));
  output.tracepoints.at(-1).alternatives = 2;
  assert.equal(restored.confirm(request, output), false);
  assert.equal(restored.pendingCount, 2);
  assert.deepEqual(restored.points, buffer.points);
  output.tracepoints.at(-1).alternatives = 0;
  assert.equal(restored.confirm(request, output), true);
  assert.equal(restored.pendingCount, 0);
  assert.deepEqual(restored.points.at(-1), coordinate(0, 40));
  assert.equal(restored.rebaseAt(fix(0, 150, 100, 0)), false);
  assert.equal(restored.rebaseAt(fix(0, 40, 100, 0)), true);
});

test("a bounded window drains a long buffered trace without rebuilding its prefix", () => {
  const buffer = new FieldRecordingBuffer();
  ingest(buffer, Array.from({ length: 90 }, (_, i) => fix(0, i * 10, i)));
  let passes = 0;
  while (buffer.pendingCount) {
    const request = buffer.request(true);
    assert.ok(request.samples.length <= 32);
    assert.equal(buffer.confirm(request, match(request.samples.map(s => [s.lng, s.lat]))), true);
    assert.ok(++passes < 10);
  }
  assert.equal(buffer.points.length, 90);
  assert.ok(haversineMeters({ lng: buffer.points.at(-1)[0], lat: buffer.points.at(-1)[1] }, { lng: coordinate(0, 890)[0], lat: coordinate(0, 890)[1] }) < 0.01);
});

test("the upstream parser rejects displaced fixes and disconnected step geometry", () => {
  const samples = [0, 10, 20].map((y, i) => fix(0, y, i));
  const body = osrmBody(samples.map(s => [s.lng, s.lat]));
  assert.equal(parseRoadTraceMatch(body, samples).tracepoints.length, 3);
  body.tracepoints[1].location = coordinate(100, 10);
  assert.throws(() => parseRoadTraceMatch(body, samples), /GPS/);
  body.tracepoints[1].location = coordinate(0, 10);
  body.matchings[0].legs[0].steps.push({ geometry: { coordinates: [coordinate(20, 20), coordinate(25, 20)] } });
  assert.throws(() => parseRoadTraceMatch(body, samples), /გაწყვეტილია/);
});

test("match request validation rejects coarse, duplicate-second and reordered fixes", () => {
  const samples = [0, 10, 20].map((y, i) => fix(0, y, i));
  assert.equal(validRoadMatchFixes(samples), true);
  assert.equal(validRoadMatchFixes([samples[1], samples[0], samples[2]]), false);
  assert.equal(validRoadMatchFixes([samples[0], { ...samples[1], timestamp: t0 + 500 }, samples[2]]), false);
  assert.equal(validRoadMatchFixes(samples.map(s => ({ ...s, accuracy: 38 }))), false);
});
