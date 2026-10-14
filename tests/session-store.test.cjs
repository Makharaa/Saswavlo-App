require("fake-indexeddb/auto");
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {browserSessionStore,saveActiveSnapshot,readActiveSnapshot,removeActiveSnapshot}=require("../.test-build/services/session-store.js");
test("IndexedDB commits independent queued records and removes only one acknowledged key",async()=>{
  await Promise.all([browserSessionStore.put({key:"1:a",userId:1,status:"pending",queuedAt:1,result:{clientSessionId:"a"}}),browserSessionStore.put({key:"1:b",userId:1,status:"pending",queuedAt:2,result:{clientSessionId:"b"}})]);
  assert.equal((await browserSessionStore.list()).length,2);
  await browserSessionStore.remove("1:a");assert.deepEqual((await browserSessionStore.list()).map(x=>x.key),["1:b"]);
});
test("active snapshot writes and deletion remain ordered",async()=>{
  const first=saveActiveSnapshot("active:1:1",{version:1,trace:[1]});
  const second=saveActiveSnapshot("active:1:1",{version:2,trace:[1,2]});
  await Promise.all([first,second]);assert.deepEqual(await readActiveSnapshot("active:1:1"),{version:2,trace:[1,2]});
  const third=saveActiveSnapshot("active:1:1",{version:3});const removed=removeActiveSnapshot("active:1:1");
  await Promise.all([third,removed]);assert.equal(await readActiveSnapshot("active:1:1"),null);
});
