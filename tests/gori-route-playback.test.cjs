const { test } = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../data/imports/catalog.json");
const {
  compileDrivingRoute,
  createEvaluationState,
  evaluateDrivingPoint,
  replayDrivingTrace,
} = require("../.test-build/utils/driving-evaluator.js");
const { nextSimulationStep } = require("../.test-build/utils/driving-simulation.js");
const { normalizeDrivingSession } = require("../.test-build/utils/session-normalizer.js");
const { sessionSchema } = require("../.test-build/utils/session-validation.js");

const STARTED_AT = 1_800_000_000_000;
const ISSUE_TYPES = new Set([
  "off_route",
  "wrong_direction",
  "checkpoint_missed",
  "checkpoint_uncertain",
]);

function simulateImportedRoute(importedRoute, multiplier) {
  const compiled = compileDrivingRoute(importedRoute);
  let state = createEvaluationState();
  let index = 0;
  let virtualTime = STARTED_AT;
  let observedAt = STARTED_AT;
  let terminated = false;
  const trace = [];
  const events = [];
  const instructions = [];

  function observe(coordinate, speedKmh, heading) {
    const point = {
      observedAt,
      evaluationTime: virtualTime,
      raw: null,
      accepted: true,
      visible: true,
      sample: {
        lng: coordinate[0],
        lat: coordinate[1],
        accuracy: 0,
        timestamp: observedAt,
        speedMps: speedKmh / 3.6,
        heading,
        speedSource: "device",
        headingSource: heading == null ? "unknown" : "device",
        speedConfidence: "high",
        headingConfidence: heading == null ? "unknown" : "high",
      },
    };
    trace.push(point);
    const update = evaluateDrivingPoint(compiled, state, point);
    state = update.state;
    events.push(...update.events);
    instructions.push(...update.instructions);
  }

  observe(compiled.path[0], 0, null);
  // A generous bound catches a stop trap without hanging the test runner.
  for (let count = 0; count < compiled.path.length + 300; count += 1) {
    const step = nextSimulationStep(compiled, state, index);
    if (!step) {
      terminated = true;
      break;
    }
    index = step.index;
    virtualTime += step.elapsed;
    observedAt += Math.max(60, Math.round(step.elapsed / multiplier));
    observe(step.coordinate, step.speedKmh, step.heading);
  }

  return { compiled, state, trace, events, instructions, index, virtualTime, observedAt, terminated };
}

function checkpointIndices(events) {
  return events.filter((event) => event.type === "checkpoint").map((event) => event.checkpointIndex);
}

function sessionFor(importedRoute, playback, multiplier) {
  return {
    clientSessionId: `gori-route-playback-${multiplier}x`,
    routeId: 1,
    routeVersion: 1,
    mode: "simulation",
    assistMode: "practice",
    startedAt: STARTED_AT,
    finishedAt: playback.observedAt,
    durationSeconds: Math.round((playback.virtualTime - STARTED_AT) / 1000),
    distanceMeters: playback.state.distanceMeters,
    maxSpeedKmh: playback.state.maxSpeedKmh,
    speedingEvents: 0,
    offRouteEvents: 0,
    checkpointsCompleted: playback.state.completed.length,
    checkpointsTotal: importedRoute.checkpoints.length,
    events: playback.events,
    trace: playback.trace,
    traceComplete: true,
  };
}

for (const entry of catalog) {
const importedRoute = require(`../data/imports/${entry.source}.json`);
const EXPECTED_MARKERS = importedRoute.checkpoints.map((_, index) => index);
test(`${entry.source} passes every instruction at 1x and 6x without grading warning locations as turns`, () => {
  assert.ok(importedRoute.checkpoints.every((checkpoint) => checkpoint.evaluation?.instructionOnly === true));
  const slow = simulateImportedRoute(importedRoute, 1);
  const fast = simulateImportedRoute(importedRoute, 6);

  for (const playback of [slow, fast]) {
    assert.equal(playback.terminated, true, "playback must terminate rather than get trapped at a checkpoint");
    assert.equal(playback.index, playback.compiled.path.length - 1, "playback must traverse the entire imported geometry");
    assert.deepEqual(playback.instructions, EXPECTED_MARKERS, "each instruction must be announced once in source order");
    assert.deepEqual(playback.state.completed, EXPECTED_MARKERS);
    assert.deepEqual(checkpointIndices(playback.events), EXPECTED_MARKERS);
    assert.deepEqual(playback.events.filter((event) => ISSUE_TYPES.has(event.type)), []);
    assert.deepEqual(playback.state.missed, []);
    assert.deepEqual(playback.state.uncertain, []);
    assert.equal(playback.state.atFinish, true);

    const replay = replayDrivingTrace(playback.compiled, playback.trace, "simulation");
    assert.deepEqual(replay.state.completed, EXPECTED_MARKERS);
    assert.deepEqual(checkpointIndices(replay.events), EXPECTED_MARKERS);
    assert.deepEqual(replay.events.filter((event) => ISSUE_TYPES.has(event.type)), []);
    assert.equal(replay.state.atFinish, true);
    assert.equal(replay.state.distanceMeters, playback.state.distanceMeters);
  }

  assert.equal(fast.virtualTime, slow.virtualTime, "playback acceleration must preserve virtual duration");
  assert.equal(fast.state.distanceMeters, slow.state.distanceMeters);
  assert.ok(fast.observedAt < slow.observedAt, "6x must shorten wall-clock playback");
});

test(`${entry.source} traces survive JSON export, validation and normalization at both speeds`, () => {
  const normalized = [];
  for (const multiplier of [1, 6]) {
    const playback = simulateImportedRoute(importedRoute, multiplier);
    const exported = JSON.parse(JSON.stringify(sessionFor(importedRoute, playback, multiplier)));
    const validated = sessionSchema.safeParse(exported);
    assert.equal(validated.success, true, validated.success ? "" : JSON.stringify(validated.error.issues));

    const result = normalizeDrivingSession(validated.data, importedRoute);
    assert.equal(result.evaluation.status, "replayed");
    assert.equal(result.checkpointsCompleted, EXPECTED_MARKERS.length);
    assert.equal(result.checkpointsTotal, EXPECTED_MARKERS.length);
    assert.equal(result.evaluation.missedCheckpoints, 0);
    assert.equal(result.evaluation.uncertainCheckpoints, 0);
    assert.equal(result.offRouteEvents, 0);
    assert.deepEqual(checkpointIndices(result.events), EXPECTED_MARKERS);
    assert.equal(result.durationSeconds, Math.round((playback.virtualTime - STARTED_AT) / 1000));
    assert.equal(result.distanceMeters, playback.state.distanceMeters);
    normalized.push(result);
  }
  assert.equal(normalized[0].durationSeconds, normalized[1].durationSeconds);
  assert.equal(normalized[0].distanceMeters, normalized[1].distanceMeters);
});

}
