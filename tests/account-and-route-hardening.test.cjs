const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(relative, mocks) {
  const filename = path.join(root, relative);
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(js, filename);
    return loaded.exports;
  } finally { Module._load = original; }
}
function mockResponse() { return { json: (obj, init={}) => Response.json(obj, {status:init.status??200,headers:init.headers}) }; }
const fakeRoute = {
  id: 11, name: 'Gori N1', city: 'გორი', description: 'Test', version: 4,
  isPublished: true, coordinates: [[44.1,42.0],[44.2,42.1]], waypoints: [[44.1,42.0]],
  checkpoints: [{orderIndex:0, voice:'turn left'}], speedZones: [],
};
let user = {id:3,role:'driver',canUseRoutes:true};
let quota = true;
const routeMocks = {
  'next/server': {NextResponse:mockResponse()},
  'zod': require('zod'),
  '@/lib/logger': { logOperationError: () => {} },
  '@/lib/repository': {listRoutes: async () => [fakeRoute], getRoute: async () => fakeRoute},
  '@/lib/auth': {getCurrentUser: async () => user},
  '@/lib/api-rate-limit': {checkRouteReadQuota: async () => quota},
  '@/utils/route-engine': {normalizeSpeedZones:()=>[], validateRoute:()=>[]},
  '@/utils/geo': {downsampleCoordinates:()=>[]},
  '@/utils/route-editor': {validWaypointCoordinateIndices:()=>true},
  '@/lib/audit': {writeAuditLog: async()=>{}},
};
const listApi = load('src/app/api/routes/route.ts',routeMocks);
const detailApi = load('src/app/api/routes/[id]/route.ts',routeMocks);
test('driver route catalog does not leak checkpoints or the full geometry', async()=>{
  user={id:3,role:'driver',canUseRoutes:true};quota=true;
  const r=await listApi.GET(new Request('https://example.test/api/routes?published=1'));
  assert.equal(r.status,200);
  assert.match(r.headers.get('Cache-Control'),/no-store/);
  const [item]=await r.json();
  assert.equal(item.checkpointCount,1);
  assert.equal(item.id,11);
  assert.equal(item.coordinates,undefined);
  assert.equal(item.checkpoints,undefined);
  assert.equal(item.waypoints,undefined);
});
test('admin editor still receives complete route data',async()=>{
  user={id:4,role:'admin',canUseRoutes:true};
  const r=await listApi.GET(new Request('https://example.test/api/routes'));
  assert.deepEqual((await r.json())[0].coordinates,fakeRoute.coordinates);
});
test('driver detail is authorized but uncached; quotas deny bursts',async()=>{
  user={id:3,role:'driver',canUseRoutes:true};quota=true;
  const r=await detailApi.GET(new Request('https://example.test/api/routes/11'), {params:Promise.resolve({id:'11'})});
  assert.equal(r.status,200);
  assert.match(r.headers.get('Cache-Control'),/no-store/);
  assert.deepEqual((await r.json()).coordinates, fakeRoute.coordinates);
  quota=false;
  const denied=await detailApi.GET(new Request('https://example.test/api/routes/11'), {params:Promise.resolve({id:'11'})});
  assert.equal(denied.status,429);
  assert.equal(denied.headers.get('Retry-After'),'60');
  quota=true;
});
test('disallowed driver cannot read any route details',async()=>{
  user={id:3,role:'driver',canUseRoutes:false};
  const r=await detailApi.GET(new Request('https://example.test/api/routes/11'), {params:Promise.resolve({id:'11'})});
  assert.equal(r.status,403);
});
const sessionRows = {active_session_id:null, active_session_ip_hash:null, name:'driver', email:'user@test.local', role:'driver',is_active:true,can_use_routes:true,id:3};
let cookieToken = null;
const client = {
  query: async (sql, params=[]) => {
    if (/SELECT active_session_id,active_session_ip_hash/.test(sql)) return {rowCount:1,rows:[sessionRows]};
    if (/UPDATE app_users/.test(sql) && params.length===3){ sessionRows.active_session_id=params[0]; sessionRows.active_session_ip_hash=params[1]; return {rowCount:1,rows:[]}; }
    return {rowCount:0,rows:[]};
  },
  release: ()=>{},
};
const pool = {
  connect:async()=>client,
  query:async(sql)=>{
    if (/SELECT\s+id,name,email,role,is_active/.test(sql)) return {rowCount:1,rows:[sessionRows]};
    return {rowCount:0,rows:[]};
  },
};
process.env.AUTH_SECRET = 'unit-test-long-32-character-secret-key-2026';
const auth=load('src/lib/auth.ts', {
  'server-only':{},
  'next/headers':{cookies:async()=>({get:()=>({value:cookieToken})})},
  'next/navigation': {redirect:()=>{}},
  '@/lib/db':{pool},
  '@/lib/migrations':{ensureDatabase:async()=>{}},
});
test('each successful login revokes prior login even from same IP',async()=>{
  const first=await auth.beginUserSession(3,'192.0.2.10');
  const token1=auth.createSessionToken({id:3,role:'driver'},first.sessionId);
  cookieToken=token1;
  assert.equal((await auth.getCurrentSessionState()).user.id,3);
  const second=await auth.beginUserSession(3,'192.0.2.10');
  assert.notEqual(first.sessionId,second.sessionId);
  assert.equal(second.replacedOtherSession,true);
  assert.equal((await auth.getCurrentSessionState()).reason,'session_replaced');
  cookieToken=auth.createSessionToken({id:3,role:'driver'},second.sessionId);
  assert.equal((await auth.getCurrentSessionState()).user.id,3);
});
test('legacy cookies without a server-issued session are rejected',async()=>{
  cookieToken=auth.createSessionToken({id:3,role:'driver'});
  assert.equal((await auth.getCurrentSessionState()).reason,'session_replaced');
});
test('original recordings are not in the public web root',()=>{
  assert.equal(fs.existsSync(path.join(root,'public/audio/ka/recorded/manifest.json')),false);
  assert.equal(fs.existsSync(path.join(root,'data/private/audio/recorded/manifest.json')),true);
  assert.equal(fs.readdirSync(path.join(root,'data/private/audio/recorded')).filter(x=>x.endsWith('.mp3')).length,13);
});
