const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  compileDrivingRoute,
  createEvaluationState,
  evaluateDrivingPoint,
  replayDrivingTrace,
} = require("../.test-build/utils/driving-evaluator.js");
const {
  checkpointSpeechInWindow,
  checkpointSpeechToResume,
  resumedCheckpointSpeechDecision,
} = require("../.test-build/utils/checkpoint-speech-policy.js");

const STARTED_AT = 1_800_000_000_000;
const coordinate = (east) => [44.1 + east / (111195 * Math.cos(41.98 * Math.PI / 180)), 41.98];

function route(options = {}) {
  const coordinates = [0, 60, 100, 160, 240].map(coordinate);
  return compileDrivingRoute({
    name: "Speech resume regression", city: "გორი", description: "", isPublished: false,
    coordinates, waypoints: [coordinates[0], coordinates.at(-1)], speedZones: [],
    checkpoints: [{
      orderIndex: 0, lng: coordinates[2][0], lat: coordinates[2][1], routeCoordinateIndex: 2,
      type: "straight", title: "მინიშნება", voice: "იმოძრავეთ პირდაპირ",
      ttsVoice: "ka-GE-GiorgiNeural", speedLimit: null, triggerMeters: 40,
      evaluation: { instructionOnly: true }, ...options,
    }],
  });
}

function point(east, seconds, heading = 90, accuracy = 5) {
  const at = coordinate(east);
  const raw = {
    lng: at[0], lat: at[1], accuracy, timestamp: STARTED_AT + seconds * 1000,
    speedMps: 10, heading, speedConfidence: "high", headingConfidence: heading == null ? "unknown" : "high",
  };
  return { observedAt: raw.timestamp, raw, sample: raw, accepted: true, visible: true };
}

function paused(seconds) {
  return { observedAt: STARTED_AT + seconds * 1000, raw: null, sample: null, accepted: false, visible: true, reason: "paused" };
}

function advance(compiled, state, next) {
  return evaluateDrivingPoint(compiled, state, next);
}

function replayRequested(compiled) {
  // Replaying actual raw fixes proves that the cue was requested; there is
  // intentionally no successful audio playback event in this GPS evidence.
  return replayDrivingTrace(compiled, [point(65, 0), point(70, 1)], "real").state;
}

test("replayed request history resumes an undelivered current cue after two reliable recovery fixes", () => {
  const compiled = route();
  const replayed = replayRequested(compiled);
  assert.deepEqual(replayed.announced, [0]);
  assert.deepEqual(replayed.completed, []);
  assert.equal(checkpointSpeechToResume(replayed), 0);

  const suspended = advance(compiled, replayed, paused(2)).state;
  assert.equal(suspended.gap, true);
  const first = advance(compiled, suspended, point(75, 3));
  assert.equal(first.state.quality, "usable");
  assert.equal(resumedCheckpointSpeechDecision(compiled, suspended, first.state, 0), "wait");
  assert.deepEqual(first.instructions, [], "the evaluator does not re-emit historical requests");

  const second = advance(compiled, first.state, point(80, 4));
  assert.equal(resumedCheckpointSpeechDecision(compiled, first.state, second.state, 0), "retry");
  assert.equal(checkpointSpeechToResume(second.state), 0);
  assert.deepEqual(second.instructions, [], "the speech policy must recover the undelivered cue independently");
});

test("a cue already behind the recovered car is discarded even while it remains the active checkpoint", () => {
  const compiled = route();
  const suspended = advance(compiled, replayRequested(compiled), paused(2)).state;
  const recovered = advance(compiled, suspended, point(120, 20)).state;
  assert.equal(recovered.activeCheckpointIndex, 0);
  assert.deepEqual(recovered.completed, []);
  assert.equal(resumedCheckpointSpeechDecision(compiled, suspended, recovered, 0), "discard");
  assert.equal(checkpointSpeechInWindow(compiled, recovered, 0), false, "manual repeat must also reject a passed cue");
});

test("GPS-gap retirement bans replaying a cue and clears the active resume candidate", () => {
  const compiled = route();
  const suspended = advance(compiled, replayRequested(compiled), paused(2)).state;
  const recovered = advance(compiled, suspended, point(150, 20)).state;
  assert.deepEqual(recovered.uncertain, [0]);
  assert.equal(recovered.activeCheckpointIndex, 1);
  assert.equal(checkpointSpeechToResume(recovered), null);
  assert.equal(resumedCheckpointSpeechDecision(compiled, suspended, recovered, 0), "discard");
  assert.equal(checkpointSpeechInWindow(compiled, recovered, 0), false);
});

test("a reliably missed stop is banned from restored speech", () => {
  const compiled = route({ type: "stop", evaluation: undefined });
  let state = createEvaluationState();
  const snapshots = [];
  for (const next of [point(65, 0), point(90, 1), point(110, 2), point(140, 3)]) {
    state = advance(compiled, state, next).state;
    snapshots.push(state);
  }
  assert.deepEqual(state.missed, [0]);
  assert.deepEqual(state.announced, [0]);
  assert.equal(checkpointSpeechToResume(state), null);
  assert.equal(resumedCheckpointSpeechDecision(compiled, snapshots[2], state, 0), "discard");
  assert.equal(checkpointSpeechInWindow(compiled, state, 0), false);
});

test("fresh speech remains valid when the same frame completes its marker and advances the active index", () => {
  const compiled = route({ triggerMeters: 10 });
  const before = createEvaluationState();
  const update = advance(compiled, before, point(100, 0));
  assert.deepEqual(update.instructions, [0]);
  assert.deepEqual(update.state.completed, [0]);
  assert.equal(update.state.activeCheckpointIndex, 1);
  assert.equal(checkpointSpeechInWindow(compiled, update.state, 0), true,
    "the queued timely cue must be allowed to start despite completion on the request frame");
  assert.equal(checkpointSpeechToResume(update.state), null, "completed cues are not resurrected on restore");
  assert.equal(resumedCheckpointSpeechDecision(compiled, before, update.state, 0), "discard");
});

test("reverse, uncertain and paused evaluator states keep a pending resumed cue waiting", () => {
  const compiled = route();
  const previous = replayRequested(compiled);
  for (const [label, next] of [
    ["reverse", point(75, 2, 270)],
    ["uncertain heading", point(75, 2, null)],
    ["poor accuracy", point(75, 2, 90, 30)],
    ["paused", paused(2)],
  ]) {
    const current = advance(compiled, previous, next).state;
    assert.equal(current.activeCheckpointIndex, 0, label);
    assert.equal(resumedCheckpointSpeechDecision(compiled, previous, current, 0), "wait", label);
  }
});

test("manual repeat is unavailable before the voice window and becomes available inside it", () => {
  const compiled = route();
  const far = advance(compiled, createEvaluationState(), point(40, 0)).state;
  assert.equal(checkpointSpeechInWindow(compiled, far, 0), false);
  const nearby = advance(compiled, far, point(65, 2)).state;
  assert.deepEqual(nearby.announced, [0]);
  assert.equal(checkpointSpeechInWindow(compiled, nearby, 0), true);
});
