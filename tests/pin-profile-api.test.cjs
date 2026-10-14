const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const source = path.join(__dirname, '../src/app/api/profile/pin/route.ts');
let signedIn = { id: 45, role: 'driver' };
let passwordCorrect = true;
let pinValue = null;
let devicesRevoked = 0;
let issued = 0;
let cookieCleared = 0;
const originalLoad = Module._load;
const mock = {
  'next/server': { NextResponse: { json: (body, opts = {}) => Response.json(body, { status: opts.status || 200, headers: opts.headers }) } },
  '@/lib/auth': {
    getCurrentUser: async () => signedIn,
    verifyPassword: async (value) => passwordCorrect && value === 'correct-password',
  },
  '@/lib/db': { pool: {
    connect: async () => ({
      query: async (sql, params = []) => {
        if (sql.includes('SELECT password_hash')) return { rows: [{ password_hash: 'hash', is_active: true }], rowCount: 1 };
        if (sql.includes('UPDATE app_users SET pin_hash=')) pinValue = params[0];
        if (sql.includes('DELETE FROM trusted_login_devices')) devicesRevoked++;
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
    query: async (sql) => sql.includes('SELECT pin_hash') ? { rows: [{ pin_hash: pinValue }] } : { rows: [] },
  } },
  '@/lib/migrations': { ensureDatabase: async () => {} },
  '@/lib/pin-auth': {
    clearPinFailures: async () => {},
    clearTrustedDeviceCookie: async () => { cookieCleared++; },
    hashPin: async (p) => `hash:${p}`,
    weakPin: (p) => ["1234", "0000"].includes(p),
    trustCurrentDevice: async () => { issued++; },
  },
  '@/lib/audit': { writeAuditLog: async () => {} },
};
let api;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === source && Object.hasOwn(mock, request)) return mock[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const mod = new Module(source, module);
  mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  api = mod.exports;
} finally { Module._load = originalLoad; }
const url = 'https://saswavlo.makhara.ge/api/profile/pin';
function request(method, data, origin = 'https://saswavlo.makhara.ge') {
  return new Request(url, { method, headers: { origin, host: 'saswavlo.makhara.ge', 'content-type': 'application/json' }, body: JSON.stringify(data) });
}
function reset() { signedIn = { id: 45, role: 'driver' }; passwordCorrect = true; pinValue = null; devicesRevoked = 0; issued = 0; cookieCleared = 0; }
test('PIN enrollment blocks outsiders and anonymous users', async () => {
  reset(); signedIn = null;
  assert.equal((await api.POST(request('POST', { currentPassword: 'correct-password', pin: '5382' }))).status, 401);
  signedIn = { id: 45, role: 'admin' };
  assert.equal((await api.POST(request('POST', { currentPassword: 'correct-password', pin: '5382' }))).status, 403);
  signedIn = { id: 45, role: 'driver' };
  assert.equal((await api.POST(request('POST', { currentPassword: 'correct-password', pin: '5382' }, 'https://attacker.test'))).status, 403);
  assert.equal(issued, 0);
});
test('enrollment checks password and valid 4-digit pin before writing', async () => {
  reset();
  assert.equal((await api.POST(request('POST', { currentPassword: 'wrong', pin: '5382' }))).status, 401);
  assert.equal((await api.POST(request('POST', { currentPassword: 'correct-password', pin: '123' }))).status, 400);
  assert.equal(issued, 0);
  const result = await api.POST(request('POST', { currentPassword: 'correct-password', pin: '5382' }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).enabled, true);
  assert.equal(pinValue, 'hash:5382');
  assert.equal(devicesRevoked, 1);
  assert.equal(issued, 1);
});
test('PIN disable revokes trusted devices and clears device cookie', async () => {
  reset(); pinValue = 'hash:5382';
  assert.equal((await api.DELETE(request('DELETE', { currentPassword: 'correct-password' }))).status, 200);
  assert.equal(pinValue, null);
  assert.equal(devicesRevoked, 1);
  assert.equal(cookieCleared, 1);
});
test('GET only reveals whether a PIN is enabled, never the hash', async () => {
  reset(); pinValue = 'hash:5382';
  const response = await api.GET();
  assert.deepEqual(await response.json(), { enabled: true, supported: true });
});
