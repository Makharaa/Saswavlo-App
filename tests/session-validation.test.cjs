const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sessionSchema } = require("../.test-build/utils/session-validation.js");
const fixture = require("./fixtures/stop-left-real.json");
const input = () => ({ clientSessionId: "validation-fixture", routeId: 1, routeVersion: 2, mode: "real", assistMode: "exam",
  startedAt: fixture.trace[0].observedAt, finishedAt: fixture.trace.at(-1).observedAt, durationSeconds: 30,
  distanceMeters: 200, maxSpeedKmh: 36, speedingEvents: 0, offRouteEvents: 0, checkpointsCompleted: 2, checkpointsTotal: 2,
  events: [], trace: fixture.trace, traceComplete: true });

test("a trace requires a pinned route while older queued results remain compatible", () => {
  assert.equal(sessionSchema.safeParse(input()).success, true);
  assert.equal(sessionSchema.safeParse({ ...input(), routeVersion: null }).success, false);
  const legacy = input(); delete legacy.trace; delete legacy.traceComplete; delete legacy.routeVersion;
  assert.equal(sessionSchema.safeParse(legacy).success, true);
  assert.equal(sessionSchema.safeParse({ ...input(), routeId: null }).success, false);
});
test("invalid trace order, coordinates, events and oversized traces are rejected", () => {
  const original = input();
  assert.equal(sessionSchema.safeParse({ ...original, trace: [...original.trace].reverse() }).success, false);
  assert.equal(sessionSchema.safeParse({ ...original, trace: [{ ...original.trace[0], raw: { ...original.trace[0].raw, lat: 95 } }] }).success, false);
  assert.equal(sessionSchema.safeParse({ ...original, events: [{ type: "checkpoint", timestamp: original.finishedAt + 61_000 }] }).success, false);
  assert.equal(sessionSchema.safeParse({ ...original, trace: Array(20_001).fill(original.trace[0]) }).success, false);
});
test("rejected device outliers are retained without allowing unsafe filtered samples", () => {
  const original = input();
  const point = { ...original.trace[0], raw: { ...original.trace[0].raw, speedMps: 400, accuracy: 1_000_000 }, sample: null, accepted: false, reason: "invalid" };
  assert.equal(sessionSchema.safeParse({ ...original, trace: [point] }).success, true);
  assert.equal(sessionSchema.safeParse({ ...original, trace: [{ ...point, sample: point.raw, accepted: true }] }).success, false);
});
test("virtual clocks are restricted to ordered, bounded simulation traces", () => {
  const original = input();
  const trace = original.trace.map((point, i) => ({ ...point, raw: null, evaluationTime: original.startedAt + i * 1000 }));
  assert.equal(sessionSchema.safeParse({ ...original, trace, mode: "simulation" }).success, true);
  assert.equal(sessionSchema.safeParse({ ...original, trace }).success, false);
  trace[2] = { ...trace[2], evaluationTime: original.startedAt - 5000 };
  assert.equal(sessionSchema.safeParse({ ...original, trace, mode: "simulation" }).success, false);
});
