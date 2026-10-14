const { test } = require("node:test");
const assert = require("node:assert/strict");
const { featureFilter } = require("@maplibre/maplibre-gl-style-spec");
const { prepareNavigationMapStyle } = require("../.test-build/utils/navigation-map-clarity.js");
const { installNavigationMapStyle, installMissingStyleImageFallback } = require("../.test-build/utils/maplibre-style-guard.js");

// Representative transportation_name filters for the three reported layers.
// These are fixtures, not a downloaded snapshot of the entire upstream style.
const lineGeometry = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const shieldFilters = [
  ["highway-shield-non-us", ["match", ["get", "network"], ["us-highway", "us-interstate", "us-state"], false, true]],
  ["highway-shield-us-interstate", ["match", ["get", "network"], ["us-interstate"], true, false]],
  ["road_shield_us", ["match", ["get", "network"], ["us-highway", "us-state"], true, false]],
];
const basemap = () => ({
  version: 8,
  glyphs: "https://example.test/fonts/{fontstack}/{range}.pbf",
  sprite: "https://example.test/sprite",
  sources: { openmaptiles: { type: "vector", tiles: ["https://example.test/{z}/{x}/{y}.pbf"] } },
  layers: shieldFilters.map(([id, network]) => ({
    id, type: "symbol", source: "openmaptiles", "source-layer": "transportation_name",
    filter: ["all", ["<=", ["get", "ref_length"], 6], lineGeometry, network],
    layout: { "text-field": ["get", "ref"], "icon-image": ["concat", "road_", ["get", "ref_length"]] },
  })),
});
function captureWarnings(action) {
  const warnings = [];
  const old = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { action(); } finally { console.warn = old; }
  return warnings;
}
const run = (filter, properties, type = 2) => filter.filter({ zoom: 14 }, { type, properties });

test("the reported numeric filter warning is reproduced with a missing shield reference", () => {
  const warnings = captureWarnings(() => {
    for (const layer of basemap().layers) {
      const filter = featureFilter(layer.filter, `layers[${layer.id}].filter`);
      assert.equal(run(filter, {}), false);
    }
  });
  assert.equal(warnings.length, 3);
  assert.equal(warnings.every(w => /Expected value to be of type number, but found null/.test(w)), true);
});

test("missing, null and nonnumeric shield references are skipped without runtime warnings", () => {
  const warnings = captureWarnings(() => {
    for (const layer of prepareNavigationMapStyle(basemap()).layers) {
      const filter = featureFilter(layer.filter, `layers[${layer.id}].filter`);
      for (const properties of [{}, { ref_length: null }, { ref_length: "3" }, { ref_length: false }, { ref_length: [] }]) {
        assert.equal(run(filter, properties), false);
      }
    }
  });
  assert.deepEqual(warnings, []);
});

test("numeric shield references retain the original length, network and geometry conditions", () => {
  const original = basemap();
  const prepared = prepareNavigationMapStyle(original);
  for (let i = 0; i < original.layers.length; i++) {
    const before = featureFilter(original.layers[i].filter, "fixture.original");
    const after = featureFilter(prepared.layers[i].filter, "fixture.prepared");
    for (const ref_length of [1, 3, 6, 7, 10]) {
      for (const network of [undefined, "ge-road", "us-interstate", "us-highway", "us-state"]) {
        for (const geometry of [1, 2, 3]) {
          const properties = { ref_length, network };
          assert.equal(run(after, properties, geometry), run(before, properties, geometry));
        }
      }
    }
  }
});

test("navigation clarity is applied before load without mutating the source or road and place labels", () => {
  const original = basemap();
  original.layers.push(
    { id: "poi_r1", type: "symbol", source: "openmaptiles", layout: { "icon-image": "atm" } },
    { id: "building_3d", type: "fill-extrusion", source: "openmaptiles" },
    { id: "building", type: "fill", source: "openmaptiles", paint: { "fill-color": "#aaaaaa" } },
    { id: "admin_boundary", type: "line", source: "openmaptiles", paint: { "line-color": "#666666" } },
    { id: "highway-name-major", type: "symbol", source: "openmaptiles", layout: { "text-field": ["get", "name"] } },
    { id: "label_city", type: "symbol", source: "openmaptiles", layout: { "text-field": ["get", "name"] } },
  );
  const snapshot = structuredClone(original);
  const prepared = prepareNavigationMapStyle(original);
  const layers = Object.fromEntries(prepared.layers.map(l => [l.id, l]));
  assert.equal(layers.poi_r1.layout.visibility, "none");
  assert.equal(layers.building_3d.layout.visibility, "none");
  assert.equal(layers.building.paint["fill-opacity"], 0.22);
  assert.equal(layers.admin_boundary.paint["line-opacity"], 0.22);
  for (const id of ["highway-name-major", "label_city"]) {
    assert.deepEqual(layers[id], original.layers.find(l => l.id === id));
  }
  assert.deepEqual(prepared.sources, original.sources);
  assert.equal(prepared.glyphs, original.glyphs);
  assert.equal(prepared.sprite, original.sprite);
  assert.deepEqual(original, snapshot);
});

test("the resolver is installed before fetching a style and the transform handles each theme load", () => {
  for (const theme of ["liberty", "dark"]) {
    let resolver, transformer;
    const map = {
      setMissingStyleImageResolver(callback) { resolver = callback; },
      setStyle(url, options) {
        assert.equal(typeof resolver, "function");
        assert.equal(url, `https://tiles.openfreemap.org/styles/${theme}`);
        transformer = options.transformStyle;
      },
    };
    const dispose = installNavigationMapStyle(map, `https://tiles.openfreemap.org/styles/${theme}`);
    for (const previous of [undefined, basemap()]) {
      const incoming = basemap();
      const result = transformer(previous, incoming);
      const filter = featureFilter(result.layers[0].filter, "fixture.theme");
      const warnings = captureWarnings(() => assert.equal(run(filter, {}), false));
      assert.deepEqual(warnings, []);
      assert.notStrictEqual(result, incoming);
    }
    dispose();
    assert.equal(resolver, null);
  }
});

test("optional sprite placeholders resolve the current request and stop on disposal", async () => {
  let resolver;
  const existing = { width: 2, height: 2, data: new Uint8Array(16).fill(255) };
  const images = new Map([["road_3", existing]]);
  let added = 0;
  const map = {
    setMissingStyleImageResolver(callback) { resolver = callback; },
    hasImage: id => images.has(id),
    addImage(id, image) { assert.equal(images.has(id), false); added++; images.set(id, image); },
  };
  const dispose = installMissingStyleImageFallback(map);
  const ids = ["atm", "office", "brownfield", "gate", "swimming_pool", "sports_centre"];
  // MapLibre 6 awaits the resolver before reading the current response's images.
  await Promise.allSettled([...ids, "road_3", "atm"].map(id => resolver(id)));
  assert.equal(added, ids.length);
  for (const id of ids) {
    assert.ok(images.has(id));
    assert.deepEqual([...images.get(id).data], [0, 0, 0, 0]);
  }
  assert.strictEqual(images.get("road_3"), existing);
  const pendingResolver = resolver;
  dispose();
  assert.equal(resolver, null);
  await pendingResolver("after-map-removal");
  assert.equal(images.has("after-map-removal"), false);
});
