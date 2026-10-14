const {test}=require("node:test");
const assert=require("node:assert/strict");
const {createSessionQueue,SessionApiError}=require("../.test-build/services/session-queue.js");
const result=id=>({clientSessionId:id,routeId:1,mode:"real",assistMode:"practice",startedAt:1,finishedAt:2,durationSeconds:0,distanceMeters:0,maxSpeedKmh:0,speedingEvents:0,offRouteEvents:0,checkpointsCompleted:0,checkpointsTotal:0,events:[]});
function memory(){const data=new Map();return {data,list:async()=>[...data.values()],put:async x=>{data.set(x.key,structuredClone(x));},remove:async key=>{data.delete(key);}};}
test("a result is durably queued before any remote request",async()=>{
  const store=memory();const q=createSessionQueue(store,()=>1,async()=>{assert.equal(store.data.size,1);throw Error("offline");});
  const saved=await q.saveOrQueue(result("durable-result"));assert.equal(saved.pending,true);assert.equal(store.data.size,1);
});
test("401 and permanent 4xx remain visible rather than being discarded",async()=>{
  for(const status of [401,403,409,422]) {
    const store=memory();const q=createSessionQueue(store,()=>1,async()=>{throw new SessionApiError("გაგზავნა ვერ მოხერხდა",status);});
    await q.saveOrQueue(result("blocked-result"));await q.flushPending();
    assert.equal(store.data.size,1);assert.ok((await q.listPending())[0].lastError);
  }
});
test("storage failure never claims an unsuccessful result is safely queued",async()=>{
  const store=memory();store.put=async()=>{throw Error("disk full");};
  const q=createSessionQueue(store,()=>1,async()=>{throw Error("offline");});
  const saved=await q.saveOrQueue(result("storage-fail"));assert.equal(saved.pending,false);assert.match(saved.error,/disk full/);
});
test("flushes coalesce and cannot drop a newly queued session",async()=>{
  const store=memory();let online=false,release;const gate=new Promise(r=>{release=r});
  const q=createSessionQueue(store,()=>1,async r=>{if(!online)throw Error("offline");if(r.clientSessionId==="first-result")await gate;return {id:1};});
  await q.saveOrQueue(result("first-result"));online=true;
  const a=q.flushPending();const b=q.flushPending();assert.equal(a,b);
  await new Promise(r=>setImmediate(r));online=false;await q.saveOrQueue(result("second-result"));online=true;release();await a;
  assert.equal(store.data.size,1);assert.equal((await q.listPending())[0].result.clientSessionId,"second-result");
});
test("retries reuse clientSessionId and remove only confirmed successes",async()=>{
  const store=memory();let online=false,calls=[];
  const q=createSessionQueue(store,()=>1,async r=>{calls.push(r.clientSessionId);if(!online)throw Error("offline");return {id:23};});
  await q.saveOrQueue(result("idempotent-result"));online=true;const flushed=await q.flushPending();
  assert.equal(flushed.saved,1);assert.equal(store.data.size,0);assert.deepEqual(calls,["idempotent-result","idempotent-result"]);
});
test("queues are isolated by account and have no twenty-result truncation",async()=>{
  const store=memory();let user=1,online=false;
  const q=createSessionQueue(store,()=>user,async()=>{if(!online)throw Error("offline");return {id:1};});
  for(let i=0;i<25;i++)await q.saveOrQueue(result(`session-number-${i}`));
  user=2;assert.equal((await q.listPending()).length,0);online=true;await q.flushPending();assert.equal(store.data.size,25);
});
