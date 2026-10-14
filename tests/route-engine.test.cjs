const test = require("node:test");
const assert = require("node:assert/strict");
const { remapRouteReferences, validateRoute } = require("../.test-build/utils/route-engine.js");

const oldCoordinates = [
  [44, 41],
  [44.001, 41],
  [44.002, 41],
  [44.003, 41],
];
const nextCoordinates = [
  [44, 41],
  [44.0005, 41],
  [44.001, 41],
  [44.0015, 41],
  [44.002, 41],
  [44.0025, 41],
  [44.003, 41],
];

function checkpoint(lng, routeCoordinateIndex, orderIndex) {
  return {
    lng,
    lat: 41,
    routeCoordinateIndex,
    orderIndex,
    type: "straight",
    title: "გააგრძელეთ პირდაპირ",
    voice: "გააგრძელეთ პირდაპირ",
    ttsVoice: "ka-GE-EkaNeural",
    speedLimit: null,
    triggerMeters: 120,
  };
}

test("route annotations are projected to the edited geometry in travel order", () => {
  const result = remapRouteReferences(
    oldCoordinates,
    nextCoordinates,
    [checkpoint(44.001, 1, 0), checkpoint(44.0025, 3, 1)],
    [{ id: "a", startCoordinateIndex: 0, endCoordinateIndex: 1, speedLimit: 50, label: "ქალაქი" },
     { id: "b", startCoordinateIndex: 2, endCoordinateIndex: 3, speedLimit: 30, label: "სკოლა" }]
  );

  assert.ok(result.checkpoints[0].routeCoordinateIndex < result.checkpoints[1].routeCoordinateIndex);
  assert.ok(result.checkpoints.every((item) => item.routeCoordinateIndex >= 0 && item.routeCoordinateIndex < nextCoordinates.length));
  assert.ok(result.speedZones[0].endCoordinateIndex < result.speedZones[1].startCoordinateIndex);
  assert.ok(result.speedZones[1].endCoordinateIndex <= nextCoordinates.length - 1);
});

test("annotations with no previous route geometry use the supplied new-route indexes", () => {
  const result = remapRouteReferences(
    [],
    nextCoordinates,
    [checkpoint(44.002, 4, 0)],
    [{ id: "a", startCoordinateIndex: 1, endCoordinateIndex: 5, speedLimit: 50, label: "ქალაქი" }]
  );

  assert.equal(result.checkpoints[0].routeCoordinateIndex, 4);
  assert.equal(result.speedZones[0].startCoordinateIndex, 1);
  assert.equal(result.speedZones[0].endCoordinateIndex, 5);
});

test("published route validation rejects uncovered speed limits and out-of-order checkpoints", () => {
  const route = {
    id: 1,
    name: "სატესტო გზა",
    city: "გორი",
    description: "",
    isPublished: true,
    waypoints: [],
    coordinates: oldCoordinates,
    speedZones: [{ id: "a", startCoordinateIndex: 0, endCoordinateIndex: 3, speedLimit: 50, label: "ქალაქი" }],
    checkpoints: [checkpoint(44.003, 3, 0), checkpoint(44.001, 1, 1)],
    version: 1,
  };

  const codes = validateRoute(route).map((issue) => issue.code);
  assert.ok(codes.includes("checkpoint-order-1"));

  route.speedZones = [];
  assert.ok(validateRoute(route).some((issue) => issue.code === "no-speed-zones" && issue.level === "error"));
});

test("validation catches checkpoint indexes that still point at old geometry", () => {
  const route = {
    id: 2,
    name: "მარშრუტი",
    city: "გორი",
    description: "",
    isPublished: true,
    waypoints: [],
    coordinates: oldCoordinates,
    speedZones: [{ id: "all", startCoordinateIndex: 0, endCoordinateIndex: 3, speedLimit: 50, label: "50" }],
    checkpoints: [checkpoint(44.003, 0, 0)],
    version: 1,
  };

  assert.ok(validateRoute(route).some((issue) => issue.code === "checkpoint-index-0"));
});
