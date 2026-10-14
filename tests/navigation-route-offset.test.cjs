const { test }=require('node:test');
const assert=require('node:assert/strict');
const { markerScreenOffsetForStripe, NAVIGATION_STRIPE_OFFSET_PX }=require('../.test-build/utils/navigation-route-offset.js');
const project=p=>({x:p[0],y:p[1]});
test('screen-space right edge: up, right, down, left',()=>{
  const cases=[[[0,10],[0,0]],[[-10,0],[0,0]],[[0,-10],[0,0]],[[10,0],[0,0]]];
  const expected=[[7,0],[0,7],[-7,0],[0,-7]];
  cases.forEach(([a,b],i)=>{const d=markerScreenOffsetForStripe([a,b],0,project);assert.ok(Math.hypot(d[0]-expected[i][0],d[1]-expected[i][1])<1e-6);});
});
test('camera-rotation-aware projection recalculates normal',()=>{
  const path=[[0,10],[0,0]];
  const normal=markerScreenOffsetForStripe(path,0,project);
  const turned=markerScreenOffsetForStripe(path,0,p=>({x:p[1],y:-p[0]}));
  assert.ok(Math.abs(Math.hypot(...normal)-NAVIGATION_STRIPE_OFFSET_PX)<1e-6);
  assert.notDeepEqual(normal,turned);
});
test('degenerate/off-route fallback and near-end segment are safe',()=>{
 assert.deepEqual(markerScreenOffsetForStripe([[1,1]],0,project),[0,0]);
 assert.deepEqual(markerScreenOffsetForStripe([[1,1],[1,1],[1,0]],0,project),[7,0]);
 assert.deepEqual(markerScreenOffsetForStripe([[0,0],[10,0]],999,project),[0,7]);
});
