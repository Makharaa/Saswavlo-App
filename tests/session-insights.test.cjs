const {test}=require("node:test");
const assert=require("node:assert/strict");
const {drivingProgress}=require("../.test-build/utils/session-insights.js");
const base={userId:1,routeId:1,routeVersion:2,assistMode:"practice",mode:"real",checkpointsTotal:10,checkpointsCompleted:5,finishedAt:1,distanceMeters:1000,speedingEvents:1,offRouteEvents:0,evaluation:{version:1,status:"replayed",wrongDirectionEvents:0,missedCheckpoints:0}};
test("progress comparisons keep simulation, other versions, accounts and modes separate",()=>{
  const progress=drivingProgress([base,{...base,finishedAt:2,checkpointsCompleted:8},{...base,mode:"simulation",finishedAt:3},{...base,routeVersion:3},{...base,userId:2},{...base,assistMode:"exam"},{...base,evaluation:{...base.evaluation,status:"legacy"}}]);
  assert.equal(progress.length,4);const comparable=progress.find(x=>x.attempts===2);
  assert.equal(comparable.completionChange,30);assert.equal(comparable.issuesPerKm,1);
});
