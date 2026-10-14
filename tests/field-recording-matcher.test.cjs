const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FieldRecordingMatcher } = require("../.test-build/utils/field-recording-matcher.js");
const { FieldRecordingBuffer } = require("../.test-build/utils/field-recording.js");
const buffered = () => {
  const buffer = new FieldRecordingBuffer();
  for (let i = 0; i < 5; i++) {
    const raw = { lng: 44.1, lat: 41.98 + i * 0.0001, accuracy: 3, timestamp: 1800000000000 + i * 1000, speedMps: 10, heading: 0 };
    buffer.ingest({ raw, sample: raw, accepted: true, visible: true, observedAt: raw.timestamp });
  }
  return buffer;
};
const match = request => ({ tracepoints: request.samples.map((s, i) => ({ coordinate: [s.lng, s.lat], matchingIndex: 0, waypointIndex: i, alternatives: 0 })),
  matchings: [{ confidence: 0.99, legs: request.samples.slice(1).map((s, i) => [[request.samples[i].lng, request.samples[i].lat], [s.lng, s.lat]]) }] });

test("concurrent stop, retry and save matching requests are serialized", async () => {
  let active = 0, maximum = 0, calls = 0;
  const recorder = new FieldRecordingMatcher(buffered(), async request => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return match(request);
  }, () => {});
  await Promise.all([recorder.process(), recorder.process(true), recorder.process(true)]);
  assert.equal(maximum, 1);
  assert.equal(calls, 2);
  assert.equal(recorder.buffer.pendingCount, 0);
  assert.equal(recorder.buffer.points.length, 5);
});

test("a delayed old response is aborted and cannot alter a new recording", async () => {
  let resolve, oldSignal, oldRequest;
  const oldBuffer = buffered();
  const recorder = new FieldRecordingMatcher(oldBuffer, (request, signal) => {
    oldRequest = request; oldSignal = signal;
    return new Promise(done => { resolve = done; });
  }, () => {});
  const pending = recorder.process();
  const next = new FieldRecordingBuffer();
  recorder.replace(next);
  assert.equal(oldSignal.aborted, true);
  resolve(match(oldRequest)); await pending;
  assert.strictEqual(recorder.buffer, next);
  assert.equal(next.points.length, 0);
  assert.equal(oldBuffer.points.length, 0);
  assert.equal(recorder.matching, false);
});

test("an upstream outage retains the pending fixes for a successful retry", async () => {
  let fail = true;
  const recorder = new FieldRecordingMatcher(buffered(), async request => {
    if (fail) throw new Error("synthetic offline");
    return match(request);
  }, () => {});
  await recorder.process(true);
  assert.equal(recorder.buffer.issue, "unavailable");
  assert.equal(recorder.buffer.pendingCount, 5);
  assert.equal(recorder.buffer.observations.length, 5);
  fail = false; await recorder.process(true);
  assert.equal(recorder.buffer.pendingCount, 0);
  assert.equal(recorder.buffer.points.length, 5);
});

test("disposing a pending matcher suppresses late updates", async () => {
  let resolve, request, updates = 0;
  const recorder = new FieldRecordingMatcher(buffered(), input => { request = input; return new Promise(done => { resolve = done; }); }, () => updates++);
  const pending = recorder.process();
  recorder.invalidate();
  const prior = updates;
  resolve(match(request)); await pending;
  assert.equal(updates, prior);
  assert.equal(recorder.buffer.points.length, 0);
});
