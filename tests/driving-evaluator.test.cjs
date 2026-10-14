const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compileDrivingRoute, createEvaluationState, evaluateDrivingPoint, replayDrivingTrace } = require("../.test-build/utils/driving-evaluator.js");
const { normalizeDrivingSession } = require("../.test-build/utils/session-normalizer.js");
const { filterGpsSample, createGpsFilterState } = require("../.test-build/utils/gps-filter.js");
const { carryFieldTest } = require("../.test-build/utils/route-readiness.js");
const fixture = require("./fixtures/stop-left-real.json");

const t0 = 1800000000000;
const coord = (x,y=0) => [44.1 + x / (111195 * Math.cos(41.98 * Math.PI/180)), 41.98 + y / 111195];
const route = (type="straight") => ({ name:"ტესტი",city:"გორი",description:"",isPublished:false,
  coordinates:[0,50,100,150,200].map(x=>coord(x)),waypoints:[coord(0),coord(200)],
  speedZones:[{id:"all",startCoordinateIndex:0,endCoordinateIndex:4,speedLimit:40,label:"40"}],
  checkpoints:[{orderIndex:0,lng:coord(100)[0],lat:coord(100)[1],routeCoordinateIndex:2,type,title:"დავალება",voice:"პირდაპირ",ttsVoice:"ka-GE-EkaNeural",speedLimit:null,triggerMeters:70}] });
function point(x,second,speed=10,heading=90,extras={}) {
  const [lng,lat]=coord(x);
  const sample={lng,lat,accuracy:3,timestamp:t0+second*1000,speedMps:speed,heading,speedConfidence:"high",headingConfidence:heading==null?"unknown":"high",...extras};
  return {observedAt:sample.timestamp,raw:sample,sample,accepted:true,visible:true};
}
function drive(source,points) {
  const compiled=compileDrivingRoute(source);
  let state=createEvaluationState(),events=[],instructions=[];
  for(const p of points) { const next=evaluateDrivingPoint(compiled,state,p);state=next.state;events.push(...next.events);instructions.push(...next.instructions); }
  return {state,events,instructions};
}
test("stop requires continuous stationary samples, never merely passing",()=>{
  const result=drive(route("stop"),[point(70,0),point(90,1),point(100,2,0,null),point(100,3,0,null)]);
  assert.equal(result.state.completed.length,0);
  const stopped=drive(route("stop"),[point(70,0),point(90,1),point(100,2,0,null),point(100,3,0,null),point(100,4,0,null)]);
  assert.deepEqual(stopped.state.completed,[0]);
  assert.deepEqual(stopped.instructions,[0]);
  const passed=drive(route("stop"),[point(70,0),point(90,1),point(110,2),point(140,3)]);
  assert.equal(passed.state.completed.length,0);
  assert.equal(passed.events.filter(e=>e.type==="checkpoint_missed").length,1);
});
test("a rejected fix or a time gap resets stop dwell and penalty timers",()=>{
  const rejected={observedAt:t0+3000,raw:null,sample:null,accepted:false,reason:"poor_accuracy",visible:true};
  const result=drive(route("stop"),[point(80,0),point(100,1,0,null),point(100,2,0,null),rejected,point(100,4,0,null),point(100,5,0,null)]);
  assert.equal(result.state.completed.length,0);
  const gap=drive(route("stop"),[point(80,0),point(100,1,0,null),point(100,8,0,null)]);
  assert.equal(gap.state.completed.length,0);
});
test("uncertain speed cannot certify a stop; poor GPS is not a failed maneuver",()=>{
  const result=drive(route("stop"),[point(70,0),point(100,1,0,null,{speedConfidence:"low"}),point(100,4,0,null,{speedConfidence:"low"}),point(140,5,10,90,{accuracy:30})]);
  assert.equal(result.state.completed.length,0);
  assert.equal(result.state.missed.length,0);
  assert.deepEqual(result.state.uncertain,[0]);
});
test("turn completes after an observed approach and correct exit",()=>{
  const source=route("left");source.coordinates=[coord(0),coord(50),coord(100),coord(100,50),coord(100,100)];
  source.waypoints=[source.coordinates[0],source.coordinates.at(-1)];
  const make=(x,y,sec,heading)=>{const p=point(x,sec,10,heading);p.sample.lat=coord(x,y)[1];p.raw=p.sample;return p;};
  const approached=drive(source,[make(60,0,0,90),make(90,0,1,90),make(100,0,2,90)]);
  assert.equal(approached.state.completed.length,0);
  const finished=drive(source,[make(60,0,0,90),make(90,0,1,90),make(100,0,2,90),make(100,20,3,0)]);
  assert.deepEqual(finished.state.completed,[0]);
  const wrong=drive(source,[make(60,0,0,90),make(90,0,1,90),make(100,0,2,90),make(100,20,3,180)]);
  assert.equal(wrong.state.completed.length,0);
});
test("advance direction instructions are markers at their source position, not turn maneuvers",()=>{
  for (const type of ["left", "right"]) {
    const source=route(type);
    source.checkpoints[0].voice="300 მეტრში მოუხვიეთ";
    source.checkpoints[0].triggerMeters=30;
    source.checkpoints[0].evaluation={instructionOnly:true,departureMeters:40};
    const compiled=compileDrivingRoute(source);
    assert.equal(compiled.checkpoints[0].checkpoint.type,type,"direction icon/type is retained");
    assert.equal(drive(source,[point(60,0)]).instructions.length,0,"lead distance in text is not applied a second time");
    const approached=drive(source,[point(60,0),point(75,1)]);
    assert.deepEqual(approached.instructions,[0]);
    assert.equal(approached.state.completed.length,0);
    const passed=drive(source,[point(60,0),point(75,1),point(100,2)]);
    assert.deepEqual(passed.state.completed,[0],"straight road passage completes a warning before the turn's departure distance");
    assert.equal(passed.events.filter(e=>e.type==="checkpoint_missed").length,0);
    assert.deepEqual(drive(source,[point(100,0)]).state.completed,[0],"a marker does not require a turn approach");
  }
});
test("stale or resumed marker samples do not fabricate completion or a failed turn",()=>{
  const source=route("left");source.checkpoints[0].triggerMeters=30;
  source.checkpoints[0].evaluation={instructionOnly:true};
  const stale=point(100,1);stale.observedAt+=10000;
  const paused=drive(source,[point(75,0),stale]);
  assert.equal(paused.state.completed.length,0);
  assert.equal(paused.state.quality,"paused");
  const hidden={...point(90,1),visible:false};
  const resumed=drive(source,[point(75,0),hidden,point(110,2)]);
  assert.equal(resumed.state.completed.length,0,"the first fix after a gap does not certify passage");
  const skipped=drive(source,[point(75,0),hidden,point(110,2),point(145,3)]);
  assert.deepEqual(skipped.state.uncertain,[0]);
  assert.deepEqual(skipped.state.missed,[]);
  assert.equal(skipped.events.filter(e=>e.type==="checkpoint_missed").length,0);
  // Even a continuous, reliable trace can miss an announcement point without
  // providing evidence that the later advertised maneuver was performed badly.
  const unobserved=drive(source,[point(50,0),point(85,1),point(130,2),point(145,3)]);
  assert.deepEqual(unobserved.state.uncertain,[0]);
  assert.deepEqual(unobserved.state.missed,[]);
});
test("an overlapping out-and-back route stays on the chronological direction",()=>{
  const source=route();source.checkpoints=[];source.coordinates=[coord(0),coord(50),coord(100),coord(150),coord(200),coord(150),coord(100),coord(50),coord(0)];
  source.speedZones[0].endCoordinateIndex=8;
  const result=drive(source,[point(0,0),point(40,1),point(80,2),point(120,3),point(160,4),point(190,5),point(200,6),point(190,7,10,270),point(170,8,10,270)]);
  assert.ok(result.state.progressMeters>220,`progress ${result.state.progressMeters}`);
  assert.equal(result.state.direction,"forward");
  const early=drive(source,[point(0,0),point(20,1),point(20,2,10,270)]);
  assert.ok(early.state.progressMeters<50);
});
test("opposite direction cannot advance a checkpoint and has sustained detection",()=>{
  const result=drive(route(),[point(70,0),point(100,1,10,270),point(100,2,10,270),point(100,3,10,270)]);
  assert.equal(result.state.completed.length,0);
  assert.equal(result.events.filter(e=>e.type==="wrong_direction").length,1);
});
test("hidden page and stale samples suspend all grading",()=>{
  const hidden=point(100,3,20);hidden.visible=false;
  const stale=point(100,4,20);stale.observedAt+=10000;
  const result=drive(route(),[point(70,0,20),point(80,1,20),hidden,stale]);
  assert.equal(result.state.quality,"paused");assert.equal(result.events.length,0);
});
test("speed violation needs continuous evidence and an authored speed zone",()=>{
  const points=[point(20,0,15),point(40,1,15),point(60,2,15),point(80,3,15),point(90,4,15)];
  const result=drive(route(),points);
  assert.equal(result.events.filter(e=>e.type==="speeding").length,1);
  const unknown=route();unknown.speedZones=[];
  assert.equal(drive(unknown,points).events.filter(e=>e.type==="speeding").length,0);
  const paused=drive(route(),[...points.slice(0,2),{...point(60,2),accepted:false,sample:null,reason:"poor_accuracy"},point(80,5,15)]);
  assert.equal(paused.events.filter(e=>e.type==="speeding").length,0);
});
test("synthetic real-mode GPS fixture replays stop and left turn, ignores forged counters",()=>{
  const replay=replayDrivingTrace(compileDrivingRoute(fixture.route),fixture.trace,"real");
  assert.deepEqual(replay.state.completed,[0,1]);
  const input={clientSessionId:"fixture-session",routeId:1,routeVersion:2,mode:"real",assistMode:"exam",startedAt:fixture.trace[0].observedAt,
    finishedAt:fixture.trace.at(-1).observedAt,durationSeconds:0,distanceMeters:999999,maxSpeedKmh:250,speedingEvents:999,offRouteEvents:999,
    checkpointsCompleted:999,checkpointsTotal:999,events:[{type:"checkpoint",timestamp:fixture.trace[0].observedAt,checkpointIndex:0}],trace:fixture.trace,traceComplete:true};
  const normalized=normalizeDrivingSession(input,fixture.route);
  assert.equal(normalized.checkpointsCompleted,2);assert.equal(normalized.checkpointsTotal,2);assert.equal(normalized.speedingEvents,0);
  assert.equal(normalized.evaluation.status,"replayed");assert.ok(normalized.distanceMeters<300);
});
test("server re-filters raw fixes instead of trusting client acceptance",()=>{
  const p=point(100,0);p.raw={...p.raw,accuracy:500};p.sample={...p.sample,accuracy:0};
  const result=replayDrivingTrace(compileDrivingRoute(route()),[p],"real");
  assert.equal(result.state.completed.length,0);assert.equal(result.state.rejectedSamples,1);
  const empty=normalizeDrivingSession({clientSessionId:"empty-trace",routeId:1,mode:"real",assistMode:"exam",startedAt:t0,finishedAt:t0+1000,durationSeconds:1,distanceMeters:0,maxSpeedKmh:0,speedingEvents:0,offRouteEvents:0,checkpointsCompleted:1,checkpointsTotal:1,events:[],trace:[],traceComplete:true},route());
  assert.equal(empty.checkpointsCompleted,0);assert.equal(empty.evaluation.status,"incomplete");
});
test("GPS filter rejects stale, out-of-order and impossible jumps",()=>{
  const p=point(0,0).raw;let state=createGpsFilterState();
  state=filterGpsSample(state,p,p.timestamp).state;
  assert.equal(filterGpsSample(state,p,p.timestamp).reason,"duplicate");
  assert.equal(filterGpsSample(state,{...p,timestamp:p.timestamp-1},p.timestamp).reason,"out_of_order");
  assert.equal(filterGpsSample(state,point(500,1).raw,t0+1000).reason,"impossible_jump");
  assert.equal(filterGpsSample(state,point(0,1).raw,t0+15000).reason,"stale");
});
test("stationary GPS drift does not produce a reliable speed or heading",()=>{
  let state=createGpsFilterState(),last;
  for(let sec=0;sec<6;sec++) { const raw=point(sec%2?2:0,sec,0,null,{speedMps:null,accuracy:8}).raw;
    last=filterGpsSample(state,raw,raw.timestamp);state=last.state; }
  assert.notEqual(last.sample.speedConfidence,"high");assert.equal(last.sample.heading,null);
});
test("changing geometry, instructions or limits clears field verification",()=>{
  const original={...route(),fieldTestedAt:"2026-10-07T00:00:00.000Z"};
  assert.equal(carryFieldTest(original,{...original,name:"ახალი სახელი"}),original.fieldTestedAt);
  assert.equal(carryFieldTest(original,{...original,coordinates:[coord(0),coord(250)]}),null);
  assert.equal(carryFieldTest(original,{...original,checkpoints:original.checkpoints.map(p=>({...p,type:"stop"}))}),null);
  assert.equal(carryFieldTest(original,{...original,checkpoints:original.checkpoints.map(p=>({...p,evaluation:{instructionOnly:true}}))}),null);
  assert.equal(carryFieldTest(original,{...original,checkpoints:original.checkpoints.map(p=>({...p,evaluation:{instructionOnly:false}}))}),original.fieldTestedAt);
});
