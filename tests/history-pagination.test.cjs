const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
const {PGlite}=require('@electric-sql/pglite');
const root=path.resolve(__dirname,'..');
const helpersFile=path.join(root,'src/lib/history-page-query.ts');
const js=ts.transpileModule(fs.readFileSync(helpersFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tmp=new Module(helpersFile,module);tmp._compile(js,helpersFile);
const {readHistoryOptions,historyWhere,historyOrder,historyPageNumbers}=tmp.exports;
const defaults={search:'',mode:'all',days:'all',driverId:null,routeId:null,sort:'newest'};

test('page and filters reject invalid size, unsafe sort, and untrusted driver scope',()=>{
  const options=readHistoryOptions(new URLSearchParams('page=-90&size=999&sort=DROP%20TABLE&driver=7&route=28&mode=real'),false);
  assert.equal(options.page,1);assert.equal(options.size,10);assert.equal(options.sort,'newest');assert.equal(options.driverId,null);assert.equal(options.routeId,28);
  const {where,params}=historyWhere({...defaults,search:"' OR true --",driverId:7,routeId:28},42);
  assert.deepEqual(params,[42,7,28,"' OR true --"]);
  assert.doesNotMatch(where,/OR true --/);
  assert.equal(historyOrder('oldest'),'ORDER BY ds.created_at ASC, ds.id ASC');
  assert.deepEqual(historyPageNumbers(7,12),[5,6,7,8,9]);
});

test('PostgreSQL history paging searches all rows, counts full results, and isolates owners',async()=>{
  const db=new PGlite();
  const query=async(sql,params=[])=>{const result=params.length?await db.query(sql,params):(await db.exec(sql)).at(-1); return {...result,rowCount:result.rows?.length||result.affectedRows||0};};
  const pool={query,connect:async()=>({query,release(){}})};
  const oldLoad=Module._load,oldTs=require.extensions['.ts'];
  Module._load=function(request,parent,isMain){
    if(request==='./db' && parent?.filename.startsWith(path.join(root,'src/lib/')))return {pool};
    if(request.startsWith('@/'))return oldLoad.call(this,path.join(root,'src',request.slice(2)+'.ts'),parent,isMain);
    return oldLoad.call(this,request,parent,isMain);
  };
  require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
  try {
    const repo=require('../src/lib/repository.ts');
    const {ensureDatabase}=require('../src/lib/migrations.ts');
    await ensureDatabase();
    await query("INSERT INTO app_users(id,name,email,password_hash,role) VALUES(11,'Driver one','one@demo.test','x','driver'),(12,'Driver two','two@demo.test','x','driver')");
    await query("INSERT INTO exam_routes(id,name,city,coordinates) VALUES (8,'Gori N1','გორი','[]'::jsonb),(9,'Gori N4','გორი','[]'::jsonb)");
    for(let i=1;i<=27;i++){
      const owner=i===4?12:11;
      await query(`INSERT INTO driving_sessions(user_id,route_id,drive_mode,assist_mode,started_at,finished_at,checkpoints_completed,checkpoints_total,off_route_events,route_name_snapshot,route_city_snapshot,created_at)
        VALUES($1,$2,$3,$4,NOW(),NOW(),$5,10,$6,$7,'გორი',NOW()-($8::int * INTERVAL '1 day'))`,
        [owner,i%2?8:9,i%3?'real':'simulation',i%2?'practice':'exam',i%10,i===10?1:0,i%2?'Gori N1':'Gori N4',i]);
    }
    const own=await repo.listDrivingSessionsPage(defaults,10,1,11);
    assert.equal(own.total,26);assert.equal(own.items.length,10);assert.equal(own.pages,3);
    assert.ok(own.items.every(r=>r.userId===11));
    const last=await repo.listDrivingSessionsPage(defaults,10,3,11);
    assert.equal(last.items.length,6);assert.ok(last.items.every(r=>r.userId===11));
    assert.equal(new Set([...own.items,...(await repo.listDrivingSessionsPage(defaults,10,2,11)).items,...last.items].map(i=>i.id)).size,26);
    const filt=await repo.listDrivingSessionsPage({...defaults,search:'N4',mode:'exam'},10,1,11);
    assert.ok(filt.total>0);assert.ok(filt.items.every(r=>r.routeName==='Gori N4'&&r.assistMode==='exam'&&r.userId===11));
    const issue=await repo.listDrivingSessionsPage({...defaults,mode:'issues'},10,1,11);
    assert.ok(issue.items.every(r=>r.checkpointsCompleted<r.checkpointsTotal||r.offRouteEvents>0));
    const opts=await repo.listDrivingSessionFilterOptions(11);
    assert.deepEqual(opts.drivers.map(d=>d.value),['11']);assert.equal(opts.routes.length,2);
    const admin=await repo.listDrivingSessionsPage(defaults,10,1);
    assert.equal(admin.total,27);
    const reverse=await repo.listDrivingSessionsPage({...defaults,sort:'oldest'},10,1,11);
    assert.ok(new Date(reverse.items[0].createdAt).getTime() <= new Date(reverse.items.at(-1).createdAt).getTime());
  }finally{
    Module._load=oldLoad;
    if(oldTs)require.extensions['.ts']=oldTs;else delete require.extensions['.ts'];
    await db.close();
  }
});
