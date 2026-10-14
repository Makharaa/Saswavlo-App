const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendRouteWaypoint, moveRouteWaypoint, removeLastRouteWaypoint,
  prepareEditorGeometry, validWaypointCoordinateIndices, RouteEditQueue,
  manualRouteLeg, pinRouteLeg, routeLegDetour,
} = require("../.test-build/utils/route-editor.js");
const { remapRouteReferences } = require("../.test-build/utils/route-engine.js");

const A = [44.11, 41.98];
const B = [44.111, 41.98];
const left = [44.111, 41.981];
const right = [44.111, 41.979];
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const original = () => ({ waypoints: [A, B], coordinates: [A, midpoint(A, B), B], waypointCoordinateIndices: [0, 2] });
const directRouter = async ([a, b]) => [a, midpoint(a, b), b];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test("first anchor does not ask the router to invent a route", async () => {
  const result = await appendRouteWaypoint({ waypoints: [], coordinates: [] }, A, () => assert.fail("router called"));
  assert.deepEqual(result, { waypoints: [A], coordinates: [A], waypointCoordinateIndices: [0] });
});

for (const [turn, destination] of [["left", left], ["right", right]]) {
  test(`${turn} turn requests only the new leg and preserves every prior vertex`, async () => {
    const route = original();
    const snapshot = structuredClone(route);
    const requests = [];
    const result = await appendRouteWaypoint(route, destination, async (endpoints, options) => {
      requests.push({ endpoints, options });
      return directRouter(endpoints);
    }, "selected-road");
    assert.deepEqual(requests[0].endpoints, [B, destination]);
    assert.equal(requests.length, 1);
    assert.equal("startHeading" in requests[0].options, false, "an approach bearing must not constrain the new turn");
    assert.equal(requests[0].options.targetHint, "selected-road");
    assert.deepEqual(result.coordinates.slice(0, route.coordinates.length), route.coordinates);
    assert.deepEqual(result.waypoints, [A, B, destination]);
    assert.deepEqual(result.waypointCoordinateIndices, [0, 2, 4]);
    assert.deepEqual(route, snapshot, "input route was not mutated");
    assert.ok(validWaypointCoordinateIndices(result));
  });
}

test("extending a long recorded trace preserves all samples and routes from its actual end", async () => {
  const trace = Array.from({ length: 120 }, (_, i) => [44.11 + i * 0.00001, 41.98 + Math.sin(i / 10) * 0.00005]);
  const target = [44.11119, 41.981];
  let request;
  const result = await appendRouteWaypoint({ coordinates: trace, waypoints: [] }, target, async (endpoints) => {
    request = endpoints;
    return directRouter(endpoints);
  });
  assert.deepEqual(request, [trace.at(-1), target]);
  assert.deepEqual(result.coordinates.slice(0, 120), trace);
  assert.deepEqual(result.waypointCoordinateIndices, [0, 119, 121]);
});

test("legacy anchor boundaries and repeated road visits are recovered in travel order", () => {
  const C = [44.112, 41.98];
  const coordinates = [A, midpoint(A, B), B, midpoint(B, A), A, midpoint(A, C), C];
  const result = prepareEditorGeometry({ waypoints: [A, B, A, C], coordinates });
  assert.deepEqual(result.waypointCoordinateIndices, [0, 2, 4, 6]);
  assert.deepEqual(result.coordinates, coordinates);
  const restored = prepareEditorGeometry(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(restored, result, "saved boundaries retain the second visit after reloading");
});

test("dragging a middle anchor reroutes only its two neighboring legs", async () => {
  const points = [A, B, left, [44.112, 41.981], [44.113, 41.981]];
  const coordinates = [points[0], midpoint(points[0], points[1]), points[1], midpoint(points[1], points[2]), points[2], midpoint(points[2], points[3]), points[3], midpoint(points[3], points[4]), points[4]];
  const route = { waypoints: points, coordinates, waypointCoordinateIndices: [0, 2, 4, 6, 8] };
  const target = [44.1112, 41.9811];
  const requests = [];
  const result = await moveRouteWaypoint(route, 2, target, async (endpoints) => {
    requests.push(endpoints);
    return [endpoints[0], midpoint(...endpoints), midpoint(midpoint(...endpoints), endpoints[1]), endpoints[1]];
  });
  assert.deepEqual(requests, [[B, target], [target, points[3]]]);
  assert.deepEqual(result.coordinates.slice(0, 3), coordinates.slice(0, 3));
  assert.deepEqual(result.coordinates.slice(-3), coordinates.slice(-3));
  assert.deepEqual(result.waypointCoordinateIndices, [0, 2, 5, 8, 10]);
  assert.ok(validWaypointCoordinateIndices(result));
});

for (const index of [0, 2]) {
  test(`moving endpoint ${index} retains the other leg`, async () => {
    const route = { waypoints: [A, B, left], coordinates: [A, midpoint(A, B), B, midpoint(B, left), left], waypointCoordinateIndices: [0, 2, 4] };
    const target = index === 0 ? [44.1099, 41.98] : [44.1111, 41.981];
    const requests = [];
    const result = await moveRouteWaypoint(route, index, target, async (endpoints) => { requests.push(endpoints); return directRouter(endpoints); });
    assert.equal(requests.length, 1);
    assert.deepEqual(index === 0 ? result.coordinates.slice(-3) : result.coordinates.slice(0, 3), index === 0 ? route.coordinates.slice(-3) : route.coordinates.slice(0, 3));
    assert.ok(validWaypointCoordinateIndices(result));
  });
}

test("removing the last anchor trims its leg without routing or replacing the retained road", async () => {
  const route = await appendRouteWaypoint(original(), left, directRouter);
  assert.deepEqual(removeLastRouteWaypoint(route), original());
});

test("a route returned on another road is rejected without changing the existing route", async () => {
  const route = original();
  const copy = structuredClone(route);
  await assert.rejects(appendRouteWaypoint(route, left, async () => [[44.112, 41.98], left]), /არ უერთდება/);
  assert.deepEqual(route, copy);
});

test("invalid geometry is rejected while a long route remains a reviewable proposal", async () => {
  await assert.rejects(appendRouteWaypoint(original(), left, async () => [B, [NaN, 41.98], left]), /არასწორი/);
  const leg = [B, [44.13, 41.99], left];
  assert.ok(routeLegDetour([B, left], leg));
  const result = await appendRouteWaypoint(original(), left, async () => leg);
  assert.deepEqual(result.coordinates.slice(0, 3), original().coordinates);
  assert.deepEqual(result.coordinates.slice(3), leg.slice(1));
});

test("a normal turn has no detour warning", async () => {
  assert.equal(routeLegDetour([B, left], await directRouter([B, left])), null);
});

test("manual authoring preserves exact left-branch clicks and never needs a routing service", async () => {
  const exactClick = [44.11012345, 41.98012345];
  const result = await appendRouteWaypoint(original(), exactClick, manualRouteLeg);
  assert.deepEqual(result.coordinates.slice(0, 3), original().coordinates);
  assert.deepEqual(result.waypoints.at(-1), exactClick);
  assert.deepEqual(result.coordinates.at(-1), exactClick);
  assert.ok(validWaypointCoordinateIndices(result));
});

test("manual left then right turns retain earlier turns and stable boundaries after reloading", async () => {
  const first = await appendRouteWaypoint(original(), left, manualRouteLeg);
  const target = [44.112, 41.981];
  const second = await appendRouteWaypoint(JSON.parse(JSON.stringify(first)), target, manualRouteLeg);
  assert.deepEqual(second.coordinates.slice(0, first.coordinates.length), first.coordinates);
  assert.deepEqual(second.waypoints, [A, B, left, target]);
  assert.ok(validWaypointCoordinateIndices(second));
});

test("manual dragging changes the two adjacent legs and retains the rest of the trace", async () => {
  const first = await appendRouteWaypoint(original(), left, manualRouteLeg);
  const end = [44.112, 41.981];
  const route = await appendRouteWaypoint(first, end, manualRouteLeg);
  const target = [44.1112, 41.9811];
  const result = await moveRouteWaypoint(route, 1, target, manualRouteLeg);
  const leftIndex = result.waypointCoordinateIndices[2];
  assert.deepEqual(result.coordinates.slice(leftIndex), route.coordinates.slice(route.waypointCoordinateIndices[2]));
  assert.deepEqual(result.waypoints[1], target);
  assert.ok(validWaypointCoordinateIndices(result));
});

test("small server rounding is pinned to exact boundaries without connecting to another road", () => {
  const rounded = [B, [44.111, 41.9805], [44.1110001, 41.9810001]];
  assert.deepEqual(pinRouteLeg(B, left, rounded).at(-1), left);
  assert.throws(() => pinRouteLeg(B, left, [B, right]), /არ უერთდება/);
});

test("annotation indices on a retained trace stay on the same visit when the route is extended", () => {
  const trace = Array.from({ length: 100 }, (_, i) => [44.11 + i * 0.00001, 41.98]);
  const next = [...trace, ...trace.slice().reverse()];
  const checkpoints = [20, 80].map((index) => ({ lng: trace[index][0], lat: trace[index][1], routeCoordinateIndex: index }));
  const zones = [{ id: "city", startCoordinateIndex: 0, endCoordinateIndex: 40, speedLimit: 50, label: "50" }, { id: "school", startCoordinateIndex: 41, endCoordinateIndex: 99, speedLimit: 30, label: "30" }];
  const result = remapRouteReferences(trace, next, checkpoints, zones);
  assert.deepEqual(result.checkpoints.map((cp) => cp.routeCoordinateIndex), [20, 80]);
  assert.deepEqual(result.speedZones, zones);
});

test("annotation indices on an unchanged suffix shift by the inserted vertex count", () => {
  const trace = [A, midpoint(A, B), B, midpoint(B, left), left];
  const next = [A, [44.1101, 41.9801], [44.1102, 41.9801], [44.1103, 41.9801], ...trace.slice(2)];
  const result = remapRouteReferences(trace, next, [{ lng: left[0], lat: left[1], routeCoordinateIndex: 4 }], [{ id: "end", startCoordinateIndex: 2, endCoordinateIndex: 4, speedLimit: 30, label: "30" }]);
  assert.equal(result.checkpoints[0].routeCoordinateIndex, 6);
  assert.deepEqual([result.speedZones[0].startCoordinateIndex, result.speedZones[0].endCoordinateIndex], [4, 6]);
});

test("rapid map clicks execute in order against the latest completed geometry", async () => {
  const gate = deferred();
  const started = deferred();
  const queue = new RouteEditQueue();
  let geometry = original();
  const calls = [];
  const first = queue.enqueue(async (isCurrent) => {
    const next = await appendRouteWaypoint(geometry, left, async (endpoints) => { calls.push(endpoints); started.resolve(); await gate.promise; return directRouter(endpoints); });
    if (isCurrent()) geometry = next;
  });
  const end = [44.112, 41.981];
  const second = queue.enqueue(async (isCurrent) => {
    const next = await appendRouteWaypoint(geometry, end, async (endpoints) => { calls.push(endpoints); return directRouter(endpoints); });
    if (isCurrent()) geometry = next;
  });
  await started.promise;
  assert.deepEqual(calls, [[B, left]]);
  assert.equal(queue.busy, true);
  gate.resolve();
  await Promise.all([first, second]);
  await Promise.resolve();
  assert.deepEqual(calls, [[B, left], [left, end]]);
  assert.deepEqual(geometry.waypoints, [A, B, left, end]);
  assert.equal(queue.busy, false);
});

test("undo or route switch invalidates delayed responses and queued old edits", async () => {
  const gate = deferred();
  const started = deferred();
  const queue = new RouteEditQueue();
  let geometry = original();
  const first = queue.enqueue(async (isCurrent) => {
    const next = await appendRouteWaypoint(geometry, left, async (endpoints) => { started.resolve(); await gate.promise; return directRouter(endpoints); });
    if (isCurrent()) geometry = next;
  });
  const queued = queue.enqueue(async () => assert.fail("stale queued edit ran"));
  await started.promise;
  queue.invalidate();
  const fresh = queue.enqueue(async (isCurrent) => { const next = await appendRouteWaypoint(geometry, right, directRouter); if (isCurrent()) geometry = next; });
  await fresh;
  gate.resolve();
  await Promise.all([first, queued]);
  assert.deepEqual(geometry.waypoints, [A, B, right]);
  assert.equal(queue.busy, false);
});

test("a failed routing operation does not block the following edit", async () => {
  const queue = new RouteEditQueue();
  const first = queue.enqueue(async () => { throw new Error("routing offline"); });
  let completed = false;
  const next = queue.enqueue(async () => { completed = true; });
  await assert.rejects(first, /offline/);
  await next;
  assert.equal(completed, true);
});

test("invalid, unordered and stale persisted boundaries cannot be accepted", () => {
  const geometry = original();
  assert.equal(validWaypointCoordinateIndices(geometry), true);
  assert.equal(validWaypointCoordinateIndices({ ...geometry, waypointCoordinateIndices: [0, 1] }), false);
  assert.equal(validWaypointCoordinateIndices({ ...geometry, waypointCoordinateIndices: [2, 0] }), false);
  assert.equal(validWaypointCoordinateIndices({ ...geometry, waypointCoordinateIndices: [0, 99] }), false);
});
