const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const Module=require("node:module");
const ts=require("typescript");
const {PGlite}=require("@electric-sql/pglite");
const {schemaMigrations,DB_SCHEMA_VERSION}=require("../.test-build/lib/database-schema.js");
const {normalizeDrivingSession}=require("../.test-build/utils/session-normalizer.js");
const fixture=require("./fixtures/stop-left-real.json");

test("PostgreSQL migrations, versioned routes and durable session history",async()=>{
  const db=new PGlite();
  const query=async(sql,params=[])=>{
    const result=params.length ? await db.query(sql,params) : (await db.exec(sql)).at(-1);
    return {...result,rowCount:result.rows.length||result.affectedRows||0};
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const oldLoad=Module._load; const oldTs=require.extensions[".ts"];
  Module._load=function(request,parent,isMain){
    if(request==="./db" && parent?.filename.startsWith(path.join(__dirname,"../src/lib/")))return {pool};
    if(request.startsWith("@/"))return oldLoad.call(this,path.join(__dirname,"../src",request.slice(2)+".ts"),parent,isMain);
    return oldLoad.call(this,request,parent,isMain);
  };
  require.extensions[".ts"]=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
  try {
    const {ensureDatabase}=require("../src/lib/migrations.ts");
    const repo=require("../src/lib/repository.ts");
    await ensureDatabase();
    assert.equal((await query("SELECT MAX(id) AS version FROM schema_migrations")).rows[0].version,DB_SCHEMA_VERSION);
    await query("INSERT INTO app_users(name,email,password_hash,role) VALUES($1,$2,$3,$4)",["Fixture driver","fixture1@example.test","test-hash","driver"]);
    await query("INSERT INTO app_users(name,email,password_hash,role) VALUES($1,$2,$3,$4)",["Other driver","fixture2@example.test","test-hash","driver"]);
    let route=await repo.createRoute(fixture.route,1);
    assert.equal(route.fieldTestedAt,null);
    const draft={...route,fieldTestedAt:"2026-10-07T00:00:00.000Z",checkpoints:route.checkpoints.map(p=>({...p,evaluation:p.type==="stop"?{stopSeconds:2,stopRadiusMeters:12}:undefined}))};
    // A settings-only semantic no-op still compares equal at its defaults.
    route=await repo.saveRoute(route.id,draft,1,route.version);
    assert.ok(route.fieldTestedAt);
    assert.equal(route.checkpoints[0].evaluation.stopSeconds,2);
    await assert.rejects(()=>repo.saveRoute(route.id,draft,1,1),repo.RouteVersionConflictError);
    const originalVersion=route.version;
    const input=normalizeDrivingSession({clientSessionId:"postgres-fixture-result",routeId:route.id,routeVersion:route.version,mode:"real",assistMode:"exam",
      startedAt:fixture.trace[0].observedAt,finishedAt:fixture.trace.at(-1).observedAt,durationSeconds:0,distanceMeters:0,maxSpeedKmh:0,
      speedingEvents:0,offRouteEvents:0,checkpointsCompleted:0,checkpointsTotal:2,events:[],trace:fixture.trace,traceComplete:true},route);
    const saved=await repo.saveDrivingSession(input,1);
    const duplicate=await repo.saveDrivingSession(input,1);
    assert.equal(saved.id,duplicate.id);assert.equal(duplicate.duplicate,true);
    const detail=await repo.getDrivingSession(saved.id);
    assert.equal(detail.trace.length,fixture.trace.length);assert.equal(detail.checkpointsCompleted,2);
    assert.equal(detail.evaluation.status,"replayed");assert.equal(detail.routeVersion,originalVersion);
    assert.equal(detail.events.filter(e=>e.type==="checkpoint").length,2);
    await repo.saveDrivingSession(input,2);
    assert.equal((await repo.listDrivingSessions(50,1)).length,1);
    assert.equal((await repo.listDrivingSessions(50,2)).length,1);
    assert.equal((await repo.listDrivingSessions(50)).length,2);
    route=await repo.saveRoute(route.id,{...route,coordinates:[...route.coordinates,[44.102,41.982]]},1,route.version);
    assert.equal(route.fieldTestedAt,null);
    const versioned=await repo.getDrivingSession(saved.id);
    assert.deepEqual(versioned.routeSnapshot.coordinates,fixture.route.coordinates);
    assert.equal(await repo.deleteRoute(route.id,route.version),true);
    const archived=await repo.getDrivingSession(saved.id);
    assert.equal(archived.routeId,null);assert.equal(archived.routeOriginId,route.id);
    assert.deepEqual(archived.routeSnapshot.coordinates,fixture.route.coordinates);
    assert.equal(archived.checkpointsCompleted,2);
    assert.equal(await repo.findDrivingSessionId(1,input.clientSessionId),saved.id);
    assert.equal(await repo.findDrivingSessionId(3,input.clientSessionId),null);
    assert.equal((await repo.saveDrivingSession(input,1)).id,saved.id);
  } finally { Module._load=oldLoad; if(oldTs)require.extensions[".ts"]=oldTs;else delete require.extensions[".ts"]; await db.close(); }
});
test("schema 12 upgrades to 13 without destroying an existing route",async()=>{
  const db=new PGlite();
  try {
    for(const migration of schemaMigrations.filter(x=>x.id<=12)){await db.exec(migration.sql);await db.query("INSERT INTO schema_migrations(id) VALUES($1)",[migration.id]);}
    await db.query("INSERT INTO exam_routes(name,city,is_published,coordinates) VALUES($1,$2,$3,$4::jsonb)",["Existing route","გორი",true,JSON.stringify(fixture.route.coordinates)]);
    for(const migration of schemaMigrations.filter(x=>x.id>12)){await db.exec(migration.sql);await db.query("INSERT INTO schema_migrations(id) VALUES($1)",[migration.id]);}
    const rows=(await db.query("SELECT * FROM exam_routes")).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].name,"Existing route");assert.equal(rows[0].field_tested_at,null);
    assert.deepEqual(rows[0].coordinates,fixture.route.coordinates);
  } finally { await db.close(); }
});
