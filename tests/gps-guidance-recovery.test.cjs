const { test } = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../data/imports/catalog.json");
const {
  compileDrivingRoute,
  createEvaluationState,
  evaluateDrivingPoint,
  replayDrivingTrace,
} = require("../.test-build/utils/driving-evaluator.js");
const { createGpsFilterState, filterGpsSample } = require("../.test-build/utils/gps-filter.js");
const { bearingDegrees } = require("../.test-build/utils/geo.js");

const STARTED_AT = 1_800_000_000_000;
const ORIGIN = [44.1, 41.98];
const coordinate = (east, north = 0, origin = ORIGIN) => [
  origin[0] + east / (111195 * Math.cos(origin[1] * Math.PI / 180)),
  origin[1] + north / 111195,
];

function rawPoint(at, seconds, speedMps = 10, heading = 90, accuracy = 5) {
  const raw = { lng: at[0], lat: at[1], accuracy, timestamp: STARTED_AT + seconds * 1000, speedMps, heading };
  return { observedAt: raw.timestamp, raw, sample: raw, accepted: true, visible: true };
}

function unavailable(seconds) {
  return {
    observedAt: STARTED_AT + seconds * 1000,
    raw: null,
    sample: null,
    accepted: false,
    reason: "unavailable",
    visible: true,
  };
}

function checkpoint(at, coordinateIndex, orderIndex, triggerMeters = 30) {
  return {
    orderIndex, lng: at[0], lat: at[1], routeCoordinateIndex: coordinateIndex,
    type: "straight", title: `მინიშნება ${orderIndex + 1}`, voice: "იმოძრავეთ პირდაპირ",
    ttsVoice: "ka-GE-GiorgiNeural", speedLimit: null, triggerMeters,
    evaluation: { instructionOnly: true },
  };
}

function source(coordinates, checkpoints = []) {
  return {
    name: "GPS recovery regression", city: "გორი", description: "", isPublished: false,
    coordinates, waypoints: [coordinates[0], coordinates.at(-1)], speedZones: [], checkpoints,
  };
}

// Recreate the live filter/evaluator chain, then independently re-filter the
// same raw trace on the server. Both must make the same guidance decisions.
function driveReal(routeSource, trace) {
  const compiled = compileDrivingRoute(routeSource);
  let filter = createGpsFilterState();
  let state = createEvaluationState();
  const instructions = [];
  const events = [];
  const frames = [];
  for (const original of trace) {
    let point = original;
    if (original.raw) {
      const filtered = filterGpsSample(filter, original.raw, original.observedAt);
      filter = filtered.state;
      point = { ...original, sample: filtered.sample, accepted: filtered.sample != null, reason: filtered.reason };
    }
    const update = evaluateDrivingPoint(compiled, state, point);
    state = update.state;
    instructions.push(...update.instructions);
    events.push(...update.events);
    frames.push({ point, state, instructions: update.instructions, events: update.events });
  }
  const replay = replayDrivingTrace(compiled, trace, "real");
  assert.deepEqual(replay.state, state, "live filtering and raw server replay must agree");
  return { compiled, state, instructions, events, frames, replay };
}

for (const entry of catalog) {
  const imported = require(`../data/imports/${entry.source}.json`);
  test(`${entry.source}: stationary startup noise cannot attach to a later route visit`, () => {
    // Gori start and finish share nearby streets. The former unconstrained
    // nearest-point match sent (-8,+4) at route 1's start to distance 13094 m.
    for (const [east, north] of [[-8, 4], [0, 8], [8, 0], [8, 8], [-8, -8], [0, 0]]) {
      const trace = [0, 1, 2, 3].map((seconds) => rawPoint(
        coordinate(east + (seconds % 2 ? 1 : -1), north, imported.coordinates[0]),
        seconds, 0, null, 8,
      ));
      const result = driveReal(imported, trace);
      assert.ok(result.state.progressMeters < 35,
        `startup (${east},${north}) advanced to ${result.state.progressMeters.toFixed(1)} m`);
      assert.equal(result.state.atFinish, false);
      assert.deepEqual(result.instructions.filter(index => index > 0), []);
      assert.deepEqual(result.state.completed.filter(index => index > 0), []);
      assert.deepEqual(result.state.missed, []);
      assert.deepEqual(result.state.uncertain, []);
    }
  });

  test(`${entry.source}: eighteen-to-twenty-metre stationary startup error cannot speak a future cue`, () => {
    const cases = [[15.588, 9, 18], [12.85575, 15.32089, 20]];
    for (const radius of [18, 20]) {
      for (let degrees = 0; degrees < 360; degrees += 60) {
        const radians = degrees * Math.PI / 180;
        cases.push([radius * Math.cos(radians), radius * Math.sin(radians), radius]);
      }
    }
    for (const [east, north, accuracy] of cases) {
      const at = coordinate(east, north, imported.coordinates[0]);
      const result = driveReal(imported, [0, 1, 2].map((second) => rawPoint(at, second, 0, null, accuracy)));
      assert.ok(result.state.progressMeters < 45,
        `${accuracy} m accuracy at (${east.toFixed(2)},${north.toFixed(2)}) selected future distance ${result.state.progressMeters.toFixed(1)} m`);
      assert.deepEqual(result.instructions.filter(index => index > 0), [], "ordinary GPS error while parked at the start must not activate a later warning");
      assert.deepEqual(result.state.completed.filter(index => index > 0), []);
      assert.deepEqual(result.state.uncertain, []);
      assert.deepEqual(result.state.missed, []);
      assert.equal(result.state.atFinish, false);
    }
  });

  test(`${entry.source}: a poor first GPS fix cannot become the anchor for the next accurate parked fix`, () => {
    for (const [east, north] of [[0, 0], [15.588, 9], [12.85575, 15.32089]]) {
      const at = coordinate(east, north, imported.coordinates[0]);
      const result = driveReal(imported, [
        rawPoint(at, 0, 0, null, 35), rawPoint(at, 1, 0, null, 8), rawPoint(at, 2, 0, null, 8),
      ]);
      const first = result.frames[0];
      assert.equal(first.state.quality, "uncertain");
      assert.equal(first.state.matchingAnchor, null, "the uncertain initial match must not establish trusted chronology");
      assert.equal(first.state.progressMeters, 0, "poor spatial quality cannot establish route progress");
      assert.deepEqual(first.instructions, []);
      assert.ok(result.state.progressMeters < 35,
        `the accurate startup inherited the bad first match at ${result.state.progressMeters.toFixed(1)} m`);
      assert.deepEqual(result.instructions.filter(index => index > 0), []);
      assert.deepEqual(result.state.completed.filter(index => index > 0), []);
      assert.deepEqual(result.state.uncertain, []);
      assert.deepEqual(result.state.missed, []);
    }
  });

  test(`${entry.source}: a complete mildly noisy real GPS drive speaks every imported instruction in order`, () => {
    const compiled = compileDrivingRoute(imported);
    const trace = [];
    let segment = 0;
    // Every 250 ms at 36 km/h, with independent two-metre lateral/longitudinal
    // error. Device headings are also smoothed by the actual live GPS filter.
    for (let travelled = 0, tick = 0; travelled <= compiled.total + 2.5; travelled += 2.5, tick += 1) {
      const distance = Math.min(compiled.total, travelled);
      while (segment < compiled.path.length - 2 && compiled.cumulative[segment + 1] < distance) segment += 1;
      const a = compiled.path[segment];
      const b = compiled.path[segment + 1];
      const t = (distance - compiled.cumulative[segment]) / (compiled.cumulative[segment + 1] - compiled.cumulative[segment]);
      const at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const noisy = coordinate(Math.sin(tick * 0.4) * 2, Math.cos(tick * 0.7) * 2, at);
      const heading = bearingDegrees({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
      trace.push(rawPoint(noisy, tick * 0.25, 10, heading, 5));
    }
    const result = driveReal(imported, trace);
    const expected = imported.checkpoints.map((_, index) => index);
    assert.deepEqual(result.instructions, expected, "every instruction must occur exactly once, in original order");
    assert.deepEqual(result.state.completed, expected);
    assert.deepEqual(result.state.missed, []);
    assert.deepEqual(result.state.uncertain, []);
    assert.equal(result.state.atFinish, true);
    assert.equal(result.events.filter((event) => event.type === "wrong_direction").length, 0);
    assert.equal(result.events.filter((event) => event.type === "off_route").length, 0);
  });
}

test("a noisy moving startup with contradictory device heading cannot select route 2's later instruction visit", () => {
  const imported = require("../data/imports/simulatori-gori-route-2.json");
  const result = driveReal(imported, [
    rawPoint(coordinate(-8, 8, imported.coordinates[0]), 0, 10, 0, 8),
  ]);
  // At this physical start the first route leg points approximately 97.6°.
  // A reported northbound heading previously selected the future 85.9 m
  // visit, immediately speaking and completing the first imported marker.
  assert.ok(result.state.progressMeters < 40,
    `the initial heading jumped to ${result.state.progressMeters.toFixed(1)} m`);
  assert.deepEqual(result.instructions.filter(index => index > 0), []);
  assert.deepEqual(result.state.completed.filter(index => index > 0), []);
  assert.deepEqual(result.state.uncertain, []);
  assert.deepEqual(result.state.missed, []);
  assert.equal(result.state.atFinish, false);
});

test("initial heading on an overlapping road cannot establish that its future return visit already happened", () => {
  const coordinates = [0, 80, 160, 200, 160, 80, 0].map((meters) => coordinate(meters));
  for (const [east, returnCoordinateIndex] of [[80, 5], [160, 4]]) {
    const route = source(coordinates, [checkpoint(coordinates[returnCoordinateIndex], returnCoordinateIndex, 0)]);
    const result = driveReal(route, [rawPoint(coordinate(east), 0, 10, 270, 5)]);
    // This may be an explicit midway start, but there is no prior position
    // proving the turnaround. Heading alone cannot certify a later visit.
    assert.ok(result.state.progressMeters < 40,
      `startup at x=${east} selected future distance ${result.state.progressMeters.toFixed(1)} m`);
    assert.notEqual(result.state.direction, "forward");
    assert.deepEqual(result.instructions, []);
    assert.deepEqual(result.state.completed, []);
    assert.deepEqual(result.state.uncertain, []);
    assert.deepEqual(result.state.missed, []);
  }
});

test("GPS recovery after an explicit outage reacquires a unique road without grading the unseen interval", () => {
  const coordinates = [0, 100, 180, 280, 800].map((meters) => coordinate(meters));
  const route = source(coordinates, [
    checkpoint(coordinates[1], 1, 0),
    checkpoint(coordinates[2], 2, 1),
    checkpoint(coordinates[3], 3, 2),
  ]);
  const result = driveReal(route, [
    rawPoint(coordinate(0), 0), rawPoint(coordinate(10), 1), unavailable(2),
    rawPoint(coordinate(210), 21), rawPoint(coordinate(220), 22), rawPoint(coordinate(230), 23),
    rawPoint(coordinate(250), 25), rawPoint(coordinate(270), 27),
  ]);
  const reacquired = result.frames[5].state;
  assert.ok(reacquired.progressMeters >= 200 && reacquired.progressMeters < 240,
    `recovery remained at ${reacquired.progressMeters.toFixed(1)} m rather than the observed 230 m road position`);
  assert.ok(reacquired.match.distance < 10, "a recovered fix must no longer be attached to the edge of an obsolete 45 m window");
  assert.equal(reacquired.direction, "forward");
  assert.deepEqual(result.state.missed, [], "the unseen interval is not evidence of failed maneuvers");
  assert.deepEqual(result.state.uncertain, [0, 1]);
  assert.deepEqual(result.instructions, [2], "only an upcoming marker can be announced after recovery");
  assert.ok(!result.state.completed.includes(0) && !result.state.completed.includes(1));
  assert.equal(result.events.filter((event) => event.type === "off_route").length, 0);
});

test("a time gap without a rejected sample also marks skipped instructions as unobserved", () => {
  const coordinates = [0, 100, 500].map((meters) => coordinate(meters));
  const result = driveReal(source(coordinates, [checkpoint(coordinates[1], 1, 0)]), [
    rawPoint(coordinate(0), 0), rawPoint(coordinate(10), 1),
    rawPoint(coordinate(210), 21), rawPoint(coordinate(220), 22),
  ]);
  assert.ok(result.state.progressMeters > 200);
  assert.deepEqual(result.state.completed, []);
  assert.deepEqual(result.state.missed, []);
  assert.deepEqual(result.state.uncertain, [0]);
  assert.deepEqual(result.instructions, []);
});

test("a car that stops during a GPS gap can still recover its actual road position", () => {
  const route = source([coordinate(0), coordinate(800)]);
  for (const explicitPause of [false, true]) {
    const trace = [rawPoint(coordinate(0), 0), rawPoint(coordinate(10), 1)];
    if (explicitPause) trace.push(unavailable(2));
    trace.push(rawPoint(coordinate(210), 21, 0, null), rawPoint(coordinate(210), 22, 0, null));
    const result = driveReal(route, trace);
    assert.ok(result.state.progressMeters >= 200 && result.state.progressMeters < 220,
      `${explicitPause ? "explicit outage" : "silent gap"}: stopped recovery remained at ${result.state.progressMeters.toFixed(1)} m`);
    assert.ok(result.state.match.distance < 10);
    assert.equal(result.state.direction, "stationary");
    assert.ok(result.state.distanceMeters < 20, "missing GPS travel must not be invented as measured distance");
    assert.deepEqual(result.instructions, []);
  }
});

test("stopped recovery retires every crossed instruction and keeps the next upcoming marker", () => {
  const coordinates = [0, 100, 180, 280, 800].map((meters) => coordinate(meters));
  const route = source(coordinates, [
    checkpoint(coordinates[1], 1, 0),
    checkpoint(coordinates[2], 2, 1),
    checkpoint(coordinates[3], 3, 2),
  ]);
  const result = driveReal(route, [
    rawPoint(coordinate(0), 0), rawPoint(coordinate(10), 1), unavailable(2),
    rawPoint(coordinate(230), 23, 0, null), rawPoint(coordinate(230), 24, 0, null),
    rawPoint(coordinate(240), 25), rawPoint(coordinate(250), 26), rawPoint(coordinate(260), 27),
  ]);
  for (const index of [3, 4]) {
    const frame = result.frames[index];
    assert.equal(frame.state.direction, "stationary");
    assert.ok(frame.state.progressMeters >= 220 && frame.state.progressMeters < 240);
    assert.deepEqual(frame.state.uncertain, [0, 1], "every marker crossed without GPS must retire immediately, even while stopped");
    assert.equal(frame.state.activeCheckpointIndex, 2, "the 280 m upcoming marker remains active");
    assert.deepEqual(frame.state.completed, []);
    assert.deepEqual(frame.state.missed, []);
    assert.deepEqual(frame.instructions, [], "stopped recovery must never replay a crossed cue");
  }
  assert.deepEqual(result.events.filter((event) => event.type === "checkpoint_uncertain").map((event) => event.checkpointIndex), [0, 1]);
  assert.deepEqual(result.instructions, [2], "guidance resumes only for the next upcoming instruction when driving resumes");
  assert.deepEqual(result.state.missed, []);
  assert.ok(!result.state.completed.includes(0) && !result.state.completed.includes(1));
});

test("a continuous noisy out-and-back trace speaks each chronological visit once", () => {
  const coordinates = [0, 100, 200, 100, 0].map((meters) => coordinate(meters));
  const route = source(coordinates, [checkpoint(coordinates[1], 1, 0), checkpoint(coordinates[3], 3, 1)]);
  const trace = [];
  // 0.25-second fixes exercise smoothing and heading changes at the shared
  // turnaround, rather than supplying already-filtered perfect simulation.
  for (let tick = 0; tick <= 160; tick += 1) {
    const travelled = tick * 2.5;
    const returning = travelled > 200;
    const east = returning ? 400 - travelled : travelled;
    trace.push(rawPoint(coordinate(east, Math.sin(tick * 0.7) * 2), tick * 0.25, 10, returning ? 270 : 90, 5));
  }
  const result = driveReal(route, trace);
  assert.deepEqual(result.instructions, [0, 1]);
  assert.deepEqual(result.state.completed, [0, 1]);
  assert.deepEqual(result.state.missed, []);
  assert.deepEqual(result.state.uncertain, []);
  assert.ok(result.state.progressMeters > 385);
  assert.equal(result.events.filter((event) => event.type === "wrong_direction").length, 0);
  assert.equal(result.events.filter((event) => event.type === "off_route").length, 0);
});

test("premature reverse motion on an overlapping road cannot jump to its scheduled return visit", () => {
  const coordinates = [0, 100, 200, 100, 0].map((meters) => coordinate(meters));
  const route = source(coordinates, [checkpoint(coordinates[1], 1, 0), checkpoint(coordinates[3], 3, 1)]);
  const result = driveReal(route, [
    rawPoint(coordinate(0), 0), rawPoint(coordinate(10), 1), rawPoint(coordinate(20), 2),
    rawPoint(coordinate(15), 3, 5, 270), rawPoint(coordinate(10), 4, 5, 270),
    rawPoint(coordinate(5), 5, 5, 270), rawPoint(coordinate(0), 6, 5, 270),
  ]);
  assert.ok(result.state.progressMeters < 50);
  assert.equal(result.state.direction, "reverse");
  assert.deepEqual(result.instructions, []);
  assert.deepEqual(result.state.completed, []);
  assert.deepEqual(result.state.uncertain, []);
});

test("opposite heading after a GPS gap cannot prove that an overlapping return visit was reached", () => {
  const coordinates = [0, 100, 150, 200, 150, 100, 0].map((meters) => coordinate(meters));
  const route = source(coordinates, [checkpoint(coordinates[4], 4, 0, 40)]);
  const trace = [0, 20, 40, 60, 80].map((meters, index) => rawPoint(coordinate(meters), index * 2));
  trace.push(unavailable(9), rawPoint(coordinate(150), 28, 10, 270),
    rawPoint(coordinate(140), 29, 10, 270), rawPoint(coordinate(130), 30, 10, 270));
  const result = driveReal(route, trace);
  // The car could have completed the 200 m turnaround during the 20-second
  // outage, or it could now be reversing illegally on its outbound visit.
  // Identical positions with opposite route tangents do not settle this.
  assert.ok(result.state.progressMeters < 100,
    `a westbound heading alone selected the scheduled return at ${result.state.progressMeters.toFixed(1)} m`);
  assert.equal(result.state.quality, "uncertain");
  assert.equal(result.state.direction, "uncertain");
  assert.deepEqual(result.instructions, []);
  assert.deepEqual(result.state.completed, []);
  assert.deepEqual(result.state.uncertain, []);
  assert.deepEqual(result.state.missed, []);
});

test("a long gap cannot choose a later identical-heading lap from position alone", () => {
  const coordinates = [coordinate(0), coordinate(300), coordinate(300, 100), coordinate(0, 100), coordinate(0), coordinate(100), coordinate(300)];
  const route = source(coordinates, [checkpoint(coordinates[5], 5, 0, 40)]);
  const result = driveReal(route, [
    rawPoint(coordinate(0), 0), rawPoint(coordinate(20), 2), rawPoint(coordinate(40), 4),
    rawPoint(coordinate(60), 6), rawPoint(coordinate(80), 8), unavailable(9),
    rawPoint(coordinate(120), 128), rawPoint(coordinate(130), 129), rawPoint(coordinate(140), 130),
  ]);
  // Both 120 m and 920 m positions have the same coordinates and heading;
  // elapsed time permits both. The safe result keeps the early visit or pauses.
  assert.ok(result.state.progressMeters < 200,
    `ambiguous recovery selected later lap at ${result.state.progressMeters.toFixed(1)} m`);
  assert.deepEqual(result.instructions, []);
  assert.deepEqual(result.state.completed, []);
  assert.deepEqual(result.state.missed, []);
  assert.equal(result.state.atFinish, false);
});

test("poor accuracy, unknown direction and opposite travel cannot speak upcoming instructions", () => {
  const coordinates = [0, 100, 200].map((meters) => coordinate(meters));
  const route = source(coordinates, [checkpoint(coordinates[1], 1, 0, 40)]);
  const cases = [
    { label: "poor accuracy", point: rawPoint(coordinate(70), 0, 10, 90, 30) },
    { label: "unknown heading", point: rawPoint(coordinate(70), 0, 10, null, 5) },
    { label: "opposite direction", point: rawPoint(coordinate(70), 0, 10, 270, 5) },
    { label: "off route", point: rawPoint(coordinate(70, 60), 0, 10, 90, 5) },
  ];
  for (const { label, point } of cases) {
    const result = driveReal(route, [point]);
    assert.deepEqual(result.instructions, [], label);
    assert.deepEqual(result.state.completed, [], label);
  }
});

test("a plausible 4-second GPS cadence still delivers a forward warning without treating every fix as an outage", () => {
  const coords = [0, 40, 80, 120, 180].map(x => coordinate(x));
  const route = source(coords, [checkpoint(coords[3], 3, 0)]);
  const result = driveReal(route, [0, 4, 8, 12, 16, 18].map(t => rawPoint(coordinate(t * 10), t)));
  assert.deepEqual(result.instructions, [0]);
  assert.deepEqual(result.state.missed, []);
  // Sparse observations may conservatively leave execution unverified.
});

test("21-35m reported accuracy requires repeated coherent forward fixes before a voice can start", () => {
  const coords = [0, 40, 100, 160].map(x => coordinate(x));
  const route = source(coords, [checkpoint(coords[1], 1, 0)]);
  const inputs = [0, 10, 20, 30, 40, 50].map(t => rawPoint(coordinate(t), t / 10, 10, 90, 30));
  const result = driveReal(route, inputs);
  assert.equal(result.frames[0].state.quality, "uncertain");
  assert.equal(result.frames[1].state.quality, "uncertain");
  assert.ok(result.frames[2].state.weakFixStreak >= 3);
  assert.deepEqual(result.instructions, [0]);
});

test("weak GPS fixes never overcome an opposite device heading to speak an unsafe warning", () => {
  const coords = [0, 40, 100, 160].map(x => coordinate(x));
  const route = source(coords, [checkpoint(coords[1], 1, 0)]);
  const result = driveReal(route, [0, 10, 20, 30].map(t => rawPoint(coordinate(t), t / 10, 10, 270, 30)));
  assert.deepEqual(result.instructions, []);
  assert.equal(result.state.quality, "uncertain");
});
