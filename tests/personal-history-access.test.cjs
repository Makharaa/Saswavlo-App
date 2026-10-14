const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
let currentUser = { id: 42, role: 'driver' };
const calls = [];
const sessions = [
  { id: 100, userId: 42, routeName: 'N1' },
  { id: 200, userId: 7, routeName: 'N4' },
];
const mocks = {
  'next/server': { NextResponse: { json: (data, opts = {}) => Response.json(data, { status: opts.status ?? 200, headers: opts.headers }) } },
  '@/lib/auth': { getCurrentUser: async () => currentUser },
  '@/lib/history-page-query': { readHistoryOptions: (query, allowDriver) => ({ search:query.get('search') || '', mode:'all',days:'all', driverId:allowDriver?Number(query.get('driver'))||null:null,routeId:null,sort:'newest',size:10,page:1 }) },
  '@/lib/logger': { logOperationError: () => { throw new Error('Unexpected operation error'); } },
  '@/lib/repository': {
    listDrivingSessionsPage: async (filters, size, page, userId) => { calls.push({ kind: 'page', userId, filters, size, page }); const data = sessions.filter(s => userId === undefined || s.userId === userId); return { items:data, total:data.length, page:1, pages:1, size, stats:{real:0,issues:0,completion:0} }; },
    listDrivingSessionFilterOptions: async (userId) => { calls.push({ kind:'filters', userId }); return {drivers:[],routes:[]}; },
    listDrivingSessions: async (limit, userId, offset) => {
      calls.push({ limit, userId, offset });
      return sessions.filter((session) => userId === undefined || session.userId === userId).slice(offset, offset + limit);
    },
    getDrivingSession: async (id) => sessions.find((item) => item.id === id) ?? null,
    findDrivingSessionId: async () => null,
    getRoute: async () => null,
    getRouteVersionSnapshot: async () => null,
    saveDrivingSession: async () => { throw new Error('Not used'); },
  },
  '@/utils/session-normalizer': { normalizeDrivingSession: (v) => v },
  '@/utils/session-validation': { sessionSchema: {} },
};
function loadRoute(relative) {
  const filename = path.join(root, relative);
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(js, filename);
    return mod.exports;
  } finally { Module._load = original; }
}
const listApi = loadRoute('src/app/api/sessions/route.ts');
const detailApi = loadRoute('src/app/api/sessions/[id]/route.ts');
const url = (query = '') => new Request(`https://example.test/api/sessions${query}`);

// One person may only see sessions whose user_id matches the authenticated cookie identity.
test('driver list ignores userId spoofing and always limits to own sessions', async () => {
  currentUser = { id: 42, role: 'driver' }; calls.length = 0;
  const response = await listApi.GET(url('?limit=100&userId=7'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((item) => item.id), [100]);
  assert.equal(calls[0].userId, 42);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});
test('driver pagination maintains ownership and ignores spoofed query params', async () => {
  currentUser = { id: 42, role: 'driver' }; calls.length = 0;
  const response = await listApi.GET(url('?limit=1&offset=1&userId=7'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal(calls[0].userId, 42);
  assert.equal(calls[0].offset, 1);
});
test('admin personal history is limited to own sessions, even with spoofed userId', async () => {
  currentUser = { id: 42, role: 'admin' }; calls.length = 0;
  const response = await listApi.GET(url('?scope=mine&userId=7'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((item) => item.id), [100]);
  assert.equal(calls[0].userId, 42);
});
test('admin regular management history keeps access to all sessions', async () => {
  currentUser = { id: 42, role: 'admin' }; calls.length = 0;
  const response = await listApi.GET(url());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, 2);
  assert.equal(calls[0].userId, undefined);
});
test('unauthenticated list request is rejected', async () => {
  currentUser = null;
  assert.equal((await listApi.GET(url())).status, 401);
});
test('driver may read own detail but cannot read another user detail by changing the URL ID', async () => {
  currentUser = { id: 42, role: 'driver' };
  const context = (id) => ({ params: Promise.resolve({ id: String(id) }) });
  assert.equal((await detailApi.GET(url(), context(100))).status, 200);
  assert.equal((await detailApi.GET(url(), context(200))).status, 403);
});
test('profile history always loads by authenticated user id', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/profile/page.tsx'), 'utf8');
  const ownPage = fs.readFileSync(path.join(root, 'src/app/my-history/page.tsx'), 'utf8');
  assert.match(page, /listDrivingSessions\(5, user\.id\)/);
  assert.match(ownPage, /<HistoryPage mineOnly/);
  const repo = fs.readFileSync(path.join(root, 'src/lib/repository.ts'), 'utf8');
  assert.match(repo, /WHERE ds\.user_id=\$2/);
});

test('new server-side history pagination never exposes another driver records or filter options',async()=>{
  currentUser = { id:42,role:'driver' }; calls.length=0;
  const page = await listApi.GET(url('?view=page&driver=7&userId=7'));
  assert.equal(page.status,200);
  assert.deepEqual((await page.json()).items.map(s=>s.id),[100]);
  assert.equal(calls.at(-1).userId,42);
  const opts=await listApi.GET(url('?view=filters&userId=7'));
  assert.equal(opts.status,200);assert.equal(calls.at(-1).userId,42);
  currentUser = { id:42,role:'admin' };calls.length=0;
  await listApi.GET(url('?view=page&scope=mine&driver=7'));
  assert.equal(calls.at(-1).userId,42);
  await listApi.GET(url('?view=page&driver=7'));
  assert.equal(calls.at(-1).userId,undefined);
});
