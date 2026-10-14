const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compileDrivingRoute, createEvaluationState, evaluateDrivingPoint, replayDrivingTrace } = require("../.test-build/utils/driving-evaluator.js");
const { nextSimulationStep } = require("../.test-build/utils/driving-simulation.js");
const { normalizeDrivingSession } = require("../.test-build/utils/session-normalizer.js");
const { sessionSchema } = require("../.test-build/utils/session-validation.js");
const fixture = require("./fixtures/stop-left-real.json");

function simulate(multiplier, source = fixture.route) {
  const compiled = compileDrivingRoute(source);
  const startedAt = fixture.trace[0].observedAt;
  let clock = startedAt, observedAt = startedAt, index = 0, state = createEvaluationState();
  const first = compiled.path[0];
  const initial = { observedAt, evaluationTime: clock, raw: null, accepted: true, visible: true,
    sample: { lng: first[0], lat: first[1], accuracy: 0, timestamp: observedAt, speedMps: 0, heading: null, speedConfidence: "high", headingConfidence: "unknown" } };
  const trace = [initial]; state = evaluateDrivingPoint(compiled, state, initial).state;
  for (let count = 0; count < compiled.path.length + 100; count++) {
    const step = nextSimulationStep(compiled, state, index);
    if (!step) break;
    index = step.index; clock += step.elapsed; observedAt += Math.max(60, Math.round(step.elapsed / multiplier));
    const point = { observedAt, evaluationTime: clock, raw: null, accepted: true, visible: true,
      sample: { lng: step.coordinate[0], lat: step.coordinate[1], accuracy: 0, timestamp: observedAt,
        speedMps: step.speedKmh / 3.6, heading: step.heading, speedConfidence: "high", headingConfidence: step.heading == null ? "unknown" : "high" } };
    trace.push(point); state = evaluateDrivingPoint(compiled, state, point).state;
  }
  assert.equal(index, compiled.path.length - 1, "playback must not get stuck on a stop");
  const input = { clientSessionId: "simulation-fixture", routeId: 1, routeVersion: 2, mode: "simulation", assistMode: "exam",
    startedAt, finishedAt: observedAt, durationSeconds: 0, distanceMeters: 0, maxSpeedKmh: 0, speedingEvents: 0, offRouteEvents: 0,
    checkpointsCompleted: state.completed.length, checkpointsTotal: compiled.checkpoints.length, events: [], trace, traceComplete: true };
  assert.equal(sessionSchema.safeParse(input).success, true);
  return { compiled, state, trace, result: normalizeDrivingSession(input, source) };
}
test("1x and 6x simulation complete the same stop and turn with identical virtual duration", () => {
  const slow = simulate(1), fast = simulate(6);
  assert.deepEqual(slow.state.completed, [0, 1]); assert.deepEqual(fast.state.completed, slow.state.completed);
  assert.equal(fast.result.durationSeconds, slow.result.durationSeconds);
  assert.equal(fast.result.distanceMeters, slow.result.distanceMeters);
  assert.ok(fast.result.finishedAt < slow.result.finishedAt);
  assert.ok(slow.result.distanceMeters > slow.compiled.total * 0.98, "the initial and final approach legs must be recorded");
  assert.equal(fast.result.checkpointsCompleted, fast.state.completed.length);
  assert.deepEqual(replayDrivingTrace(fast.compiled, fast.trace, "simulation").state.completed, fast.state.completed);
});
test("a stop already behind a newly active instruction does not trap playback", () => {
  const compiled = compileDrivingRoute(fixture.route);
  const stopIndex = compiled.checkpoints[0].pathIndex;
  const step = nextSimulationStep(compiled, createEvaluationState(), stopIndex + 2);
  assert.equal(step.index, stopIndex + 3); assert.ok(step.speedKmh > 0);
});
test("instruction-only stop marker is announced and passed without simulation dwell", () => {
  const source=structuredClone(fixture.route);
  source.checkpoints[0].evaluation={instructionOnly:true};
  source.checkpoints[0].triggerMeters=30;
  const played=simulate(1,source);
  assert.deepEqual(played.state.completed,[0,1]);
  const stop=played.compiled.checkpoints[0];
  const atMarker=played.trace.filter(point=>Math.abs(point.sample.lng-stop.checkpoint.lng)<0.00002 &&
    Math.abs(point.sample.lat-stop.checkpoint.lat)<0.00002);
  assert.ok(atMarker.length>0);
  assert.ok(atMarker.every(point=>point.sample.speedMps>0),"instruction markers never add a stationary dwell");
  const step=nextSimulationStep(played.compiled,createEvaluationState(),stop.pathIndex);
  assert.equal(step.index,stop.pathIndex+1);
  assert.ok(step.speedKmh>0);
});
