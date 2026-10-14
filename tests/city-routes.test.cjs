const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cityDir = path.join(root, "data", "imports", "cities");
const catalog = require("../data/imports/cities/catalog.json");
const manifest = require("../data/private/audio/recorded/manifest.json");
const { resolveSelectedCity, selectedCityStorageKey, cityCenter } = require("../.test-build/utils/selected-city.js");
const { validateRoute } = require("../.test-build/utils/route-engine.js");

test("other cities are drafted separately and Gori files stay the licensed four", () => {
  const topLevel = fs.readdirSync(path.join(root, "data", "imports"))
    .filter((name) => name.endsWith(".json") && !name.endsWith("-review.json") && name !== "catalog.json");
  assert.deepEqual(topLevel.sort(), [1, 2, 3, 4].map((n) => `simulatori-gori-route-${n}.json`));
  for (let n = 1; n <= 4; n += 1) {
    const route = require(`../data/imports/simulatori-gori-route-${n}.json`);
    assert.equal(route.city, "გორი");
    assert.match(route.name, /^Simulatori\.ge - Gori /);
  }
  assert.equal(catalog.length, 55);
  assert.equal(new Set(catalog.map((entry) => entry.source)).size, 55);
  assert.ok(catalog.every((entry) => entry.city !== "გორი" && !entry.source.includes("gori") && !entry.file.includes("gori")));
  const cities = [...new Set(catalog.map((entry) => entry.city))].sort();
  assert.deepEqual(cities, ["ახალციხე", "ბათუმი", "ზუგდიდი", "ოზურგეთი", "რუსთავი", "საჩხერე", "თელავი", "ფოთი", "ქუთაისი"].sort((a, b) => a.localeCompare(b, "ka")));
});

test("city drafts keep instructions on the trace and never copy account data", () => {
  const phrases = new Set(Object.keys(manifest.phrases));
  for (const entry of catalog) {
    const file = path.join(cityDir, entry.file);
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("ownerPhone"), false);
    assert.equal(raw.includes("ownerId"), false);
    const route = JSON.parse(raw);
    assert.equal(route.city, entry.city);
    assert.equal(route.isPublished, false);
    assert.equal(route.fieldTestedAt, null);
    assert.deepEqual(route.speedZones, []);
    assert.equal(route.checkpoints.length, entry.instructionCount);
    assert.ok(route.coordinates.length >= 2);
    route.checkpoints.forEach((point, index) => {
      assert.equal(point.orderIndex, index);
      assert.ok(point.title.trim());
      if (point.voice) assert.ok(phrases.has(point.voice));
      const anchor = route.coordinates[point.routeCoordinateIndex];
      assert.ok(anchor);
    });
    const errors = validateRoute({ ...route, version: 1 }).filter((issue) => issue.level === "error" && issue.code !== "no-speed-zones");
    assert.deepEqual(errors.map((issue) => issue.code), [], entry.source);
  }
});

test("selected city survives a later login for the same account and still defaults to Gori", () => {
  assert.equal(selectedCityStorageKey(7), "driveexam-selected-city:7");
  assert.equal(selectedCityStorageKey(null), "driveexam-selected-city");
  assert.equal(resolveSelectedCity(["გორი", "ქუთაისი"], "ქუთაისი"), "ქუთაისი");
  assert.equal(resolveSelectedCity(["გორი"], "ბათუმი"), "ბათუმი");
  assert.equal(resolveSelectedCity(["გორი", "ქუთაისი"], null), "გორი");
  assert.equal(resolveSelectedCity(["ქუთაისი"], null), "ქუთაისი");
  assert.deepEqual(cityCenter("გორი"), [44.11, 41.98]);
  assert.deepEqual(cityCenter("უცნობი"), [44.11, 41.98]);
});
