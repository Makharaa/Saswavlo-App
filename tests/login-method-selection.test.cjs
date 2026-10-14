const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const source = path.join(__dirname, '../src/app/api/auth/login/method/route.ts');
let account = null;
let trusted = false;
let throttled = false;
let queriedEmail = '';
let sessions = 0;
const originalLoad = Module._load;
const mocks = {
  'next/server': { NextResponse: { json: (data, options={}) => Response.json(data, { status: options.status ?? 200, headers: options.headers }) } },
  '@/lib/login-security': { checkLoginRateLimit: async () => ({ blocked: throttled, retryAfterSeconds: throttled ? 60 : 0 }) },
  '@/lib/users': { findUserForLogin: async (email) => { queriedEmail = email; return account?.email === email ? account : null; } },
  '@/lib/pin-auth': { isTrustedDevice: async () => trusted },
};
Module._load = function(req, parent, isMain) {
  if (parent?.filename === source && Object.hasOwn(mocks, req)) return mocks[req];
  return originalLoad.call(this, req, parent, isMain);
};
let api;
try {
  const mod = new Module(source, module);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,source);
  api = mod.exports;
} finally { Module._load = originalLoad; }

function reset(role='driver', pin=true) {
  account = { id: 27, role, email:'driver@example.org', is_active:true, pin_hash:pin?'hashed':null };
  trusted = false; throttled = false; queriedEmail = '';
}
function request(email='driver@example.org', site='same-origin') {
  return api.POST(new Request('https://saswavlo.makhara.ge/api/auth/login/method', {
    method: 'POST', headers: { 'content-type':'application/json', 'sec-fetch-site':site }, body: JSON.stringify({email}),
  }));
}

test('trusted driver with PIN: only PIN is offered and account details are not disclosed', async () => {
  reset(); trusted = true;
  const response = await request('Driver@Example.ORG');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(), { method:'pin' });
  assert.equal(queriedEmail,'driver@example.org');
});
test('driver with PIN on a new device starts with password', async () => {
  reset();
  assert.deepEqual(await (await request()).json(), {method:'password'});
});
test('driver without PIN starts with password even on a remembered browser', async () => {
  reset('driver', false); trusted = true;
  assert.deepEqual(await (await request()).json(), {method:'password'});
});
test('administrator never sees a PIN offer', async () => {
  reset('admin', true); trusted = true;
  assert.deepEqual(await (await request()).json(), {method:'password'});
});
test('disabled account never sees a PIN offer', async () => {
  reset(); account.is_active = false; trusted = true;
  assert.deepEqual(await (await request()).json(), {method:'password'});
});
test('unknown email has same response as any new device; no existence leak', async () => {
  reset(); trusted = true;
  assert.deepEqual(await (await request('nobody@example.org')).json(), {method:'password'});
});
test('throttled email returns 429 with no account details', async () => {
  reset(); throttled = true;
  const response = await request();
  assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'60');
  assert.equal(JSON.stringify(await response.json()).includes('driver'), false);
});
test('cross-site POST is blocked', async () => {
  reset();
  const response = await request('driver@example.org','cross-site');
  assert.equal(response.status,403);
});
test('login UI requires email step and lets server select the next step', () => {
  const ui = fs.readFileSync(path.join(__dirname,'../src/app/login/page.tsx'),'utf8');
  assert.match(ui, /"email" \| "password" \| "pin" \| "password-pin"/);
  assert.match(ui, /fetch\("\/api\/auth\/login\/method"/);
  assert.match(ui, /body\.method === "pin" \? "pin" : "password"/);
  assert.match(ui, /body\?\.code === "PIN_REQUIRED"/);
  assert.doesNotMatch(ui, /switchMode\("pin"\)/);
});
