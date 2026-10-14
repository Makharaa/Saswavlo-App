"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateRoute}=require('../.test-build/utils/route-engine.js');
const {routeLengthMeters}=require('../.test-build/utils/geo.js');
const {compileDrivingRoute, createEvaluationState, evaluateDrivingPoint}=require('../.test-build/utils/driving-evaluator.js');
const {nextSimulationStep}=require('../.test-build/utils/driving-simulation.js');
for(let n=1;n<=4;n++){
  const source=`simulatori-gori-route-${n}`;
  const draft=require(`../data/imports/${source}.json`);
  const audit=require(`../data/imports/${source}-review.json`);
  test(`${source} is an unpublished validated draft with route-indexed speech`,()=>{
    const errors=validateRoute({...draft,version:1}).filter(x=>x.level==='error'&&x.code!=='no-speed-zones');
    assert.deepEqual(errors,[]);
    assert.equal(draft.isPublished,false);assert.equal(draft.fieldTestedAt,null);
    assert.deepEqual(draft.speedZones,[]);assert.ok(!JSON.stringify(draft).includes('ownerPhone'));
    assert.ok(Math.abs(routeLengthMeters(draft.coordinates)-audit.distanceMeters)<10);
    assert.equal(draft.checkpoints.length,audit.voiceCheckpointCount);
    assert.ok(audit.maxAnchorOffsetMeters<7);
    assert.deepEqual(audit.missingAudio,[]);
    let lastIndex=0;
    for(const c of draft.checkpoints){
      assert.equal(c.evaluation.instructionOnly,true);
      assert.ok(c.routeCoordinateIndex>=lastIndex);
      assert.ok(c.routeCoordinateIndex<draft.coordinates.length);
      assert.equal(c.triggerMeters,30);
      lastIndex=c.routeCoordinateIndex;
    }
    const compiled=compileDrivingRoute(draft);
    assert.equal(compiled.checkpoints.length,draft.checkpoints.length);
    assert.ok(Math.abs(compiled.total-audit.distanceMeters)<10);
    for(let i=1;i<compiled.checkpoints.length;i++)
      assert.ok(compiled.checkpoints[i].distance>=compiled.checkpoints[i-1].distance);
  });
  test(`${source} full-path simulation delivers every checkpoint in travel order`,()=>{
    const compiled=compileDrivingRoute(draft);
    let state=createEvaluationState();let index=0,now=1830000000000;
    const delivered=[];const observe=(coordinate,heading,speed=10)=>{
      now+=1000;
      const sample={lat:coordinate[1],lng:coordinate[0],timestamp:now,accuracy:0,speedMps:speed,heading,
        speedSource:'device',headingSource:heading==null?'unknown':'device',speedConfidence:'high',headingConfidence:heading==null?'unknown':'high'};
      const update=evaluateDrivingPoint(compiled,state,{raw:sample,sample,accepted:true,visible:true,observedAt:now,evaluationTime:now});
      state=update.state; delivered.push(...update.instructions);
    };
    observe(compiled.path[0],null,0);
    let ended=false;
    for(let j=0;j<compiled.path.length+300;j++){
      const step=nextSimulationStep(compiled,state,index);
      if(!step){ended=true;break;}
      index=step.index;now+=Math.max(0,Math.round(step.elapsed)-1000);
      observe(step.coordinate,step.heading,step.speedKmh/3.6);
    }
    assert.equal(ended,true);
    assert.equal(index,compiled.path.length-1);
    assert.deepEqual(delivered,draft.checkpoints.map((_,i)=>i));
    assert.deepEqual(state.completed,draft.checkpoints.map((_,i)=>i));
  });
}
