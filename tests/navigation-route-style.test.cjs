const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { NAVIGATION_STRIPE_OFFSET_PX } = require('../.test-build/utils/navigation-route-offset.js');
const { navigationRouteLineLayers, navigationRouteArrowLayer } = require('../.test-build/utils/navigation-route-style.js');
const { editorCenterlineLayers, setEditorCenterlineVisibility, EDITOR_CENTERLINE_LAYER_IDS } = require('../.test-build/utils/editor-centerline.js');
const root = join(__dirname, '..');

const specs = (source, prefix) => ({
  line: navigationRouteLineLayers(source, prefix),
  arrow: navigationRouteArrowLayer(source, prefix),
});

test('studio and driving preview have identical stripe colors, widths, offset and arrow properties', () => {
  const drive = specs('drive-route', 'drive-route');
  const studio = specs('studio-route', 'studio-route');
  for (const [i, layer] of drive.line.entries()) {
    assert.equal(layer.paint['line-offset'], NAVIGATION_STRIPE_OFFSET_PX);
    assert.deepEqual(layer.paint, studio.line[i].paint);
    assert.deepEqual(layer.layout, studio.line[i].layout);
  }
  assert.equal(drive.line.length, 4);
  assert.deepEqual(drive.arrow.layout, studio.arrow.layout);
  assert.equal(drive.arrow.layout['icon-offset'][1], NAVIGATION_STRIPE_OFFSET_PX / 0.8);
});

test('navigation route rendering uses original coordinates and has a separate optional centerline', () => {
  const editor = readFileSync(join(root, 'src/features/admin/route-studio.tsx'), 'utf8');
  const driving = readFileSync(join(root, 'src/features/driving/driving-experience.tsx'), 'utf8');
  assert.match(editor, /addNavigationRouteLayers\(map, "studio-route", "studio-route"\)/);
  assert.match(driving, /addNavigationRouteLayers\(map, "drive-route", "drive-route"\)/);
  assert.match(editor, /coordinates: currentRoute\.coordinates/);
  assert.match(editor, /editorCenterlineLayers\("studio-route", showEditCenterlineRef\.current\)/);
  assert.match(editor, /setEditorCenterlineVisibility\(mapRef\.current, showEditCenterline\)/);
  assert.deepEqual(EDITOR_CENTERLINE_LAYER_IDS, ["studio-route-edit-centerline-halo", "studio-route-edit-centerline"]);
  assert.match(driving, /const laneDisplayPath = simulationPath/);
});


test('editor centerline is genuinely visible when switched on and remains on original coordinates', () => {
  const layers = editorCenterlineLayers('studio-route', true);
  assert.equal(layers.length, 2);
  for (const layer of layers) {
    assert.equal(layer.source, 'studio-route');
    assert.equal(layer.paint['line-offset'], undefined);
    assert.equal(layer.layout.visibility, 'visible');
  }
  assert.ok(layers[0].paint['line-width'] > layers[1].paint['line-width']);
  assert.ok(layers[1].paint['line-width'] > 2);
  assert.deepEqual(editorCenterlineLayers('studio-route', false).map(x => x.layout.visibility), ['none', 'none']);
});

test('editor centerline state toggles both layers without changing route source', () => {
  const layers = new Set(EDITOR_CENTERLINE_LAYER_IDS);
  const changes = [];
  const map = {
    getLayer: id => layers.has(id) ? { id } : undefined,
    setLayoutProperty: (id, prop, value) => changes.push([id, prop, value]),
  };
  assert.equal(setEditorCenterlineVisibility(map, true), true);
  assert.deepEqual(changes, EDITOR_CENTERLINE_LAYER_IDS.map(id => [id, 'visibility', 'visible']));
  changes.length = 0;
  assert.equal(setEditorCenterlineVisibility(map, false), true);
  assert.deepEqual(changes, EDITOR_CENTERLINE_LAYER_IDS.map(id => [id, 'visibility', 'none']));
  changes.length = 0;
  assert.equal(setEditorCenterlineVisibility({ ...map, getLayer: () => undefined }, true), false);
  assert.equal(changes.length, 0);
});
