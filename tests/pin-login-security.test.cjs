const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const source = path.join(__dirname, '../src/app/api/auth/login/route.ts');
let account = null;
let trusted = false;
let blocked = false;
let failedPin = 0;
let sessions = 0;
let trustedIssued = 0;
let pinChecked = 0;
let passwordChecked = 0;
const originalLoad = Module._load;
const mock = {
  'next/server': { NextResponse: { json: (data, options = {}) => Response.json(data, { status: options.status ?? 200, headers: options.headers }) } },
  '@/lib/auth': {
    beginUserSession: async () => { sessions++; return { sessionId: 'valid-session', replacedOtherSession: sessions > 1 }; },
    ensureBootstrapAdmin: async () => {},
    extractClientIp: () => '127.0.0.1',
    setSessionCookie: async () => {},
    verifyPassword: async (value, hash) => hash === `hash:${value}`,
  },
  '@/lib/login-security': {
    checkLoginRateLimit: async () => ({ blocked: false }),
    clearLoginFailures: async () => {},
    recordLoginFailure: async () => ({ blocked: false }),
  },
  '@/lib/users': { findUserForLogin: async (email) => account?.email === email ? account : null },
  '@/lib/audit': { writeAuditLog: async () => {} },
  '@/lib/pin-auth': {
    clearPinFailures: async () => {},
    isTrustedDevice: async () => trusted,
    pinAttemptsBlocked: async () => ({ blocked, retryAfterSeconds: blocked ? 900 : 0 }),
    recordPinFailure: async () => { failedPin++; return { blocked: false }; },
    trustCurrentDevice: async () => { trusted = true; trustedIssued++; },
    validPin: (pin) => typeof pin === 'string' && /^[0-9]{4}$/.test(pin),
    verifyPin: async (pin) => { pinChecked++; return pin === '5382'; },
  },
};
let api;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === source && Object.hasOwn(mock, request)) return mock[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const mod = new Module(source, module);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  api = mod.exports;
} finally { Module._load = originalLoad; }

function reset(role = 'driver', pin = true) {
  account = { id: 27, email: 'driver@example.org', name: 'Driver', role, pin_hash: pin ? 'pin-hash' : null,
    password_hash: 'hash:correct-password', is_active: true, can_use_routes: true };
  trusted = false; blocked = false; failedPin = 0; sessions = 0; trustedIssued = 0; pinChecked = 0; passwordChecked = 0;
}
function login(body) {
  return api.POST(new Request('https://saswavlo.makhara.ge/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ email: 'driver@example.org', ...body }),
  }));
}

test('new device: password alone does not create a session when PIN is enabled', async () => {
  reset();
  const response = await login({ method: 'password', password: 'correct-password' });
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'PIN_REQUIRED');
  assert.equal(sessions, 0);
  assert.equal(trustedIssued, 0);
});

test('new device: correct password + PIN registers exactly one trusted device', async () => {
  reset();
  const response = await login({ method: 'password', password: 'correct-password', pin: '5382' });
  assert.equal(response.status, 200);
  assert.equal(sessions, 1);
  assert.equal(trustedIssued, 1);
  assert.equal(trusted, true);
});

test('known device: 4-digit PIN alone starts session without password', async () => {
  reset(); trusted = true;
  const response = await login({ method: 'pin', pin: '5382' });
  assert.equal(response.status, 200);
  assert.equal(pinChecked, 1);
  assert.equal(sessions, 1);
  assert.equal(trustedIssued, 0);
});

test('new device: PIN alone is rejected, even with the correct digits', async () => {
  reset();
  const response = await login({ method: 'pin', pin: '5382' });
  assert.equal(response.status, 401);
  assert.equal(sessions, 0);
  assert.equal(pinChecked, 0);
});

test('incorrect PIN is counted and does not authenticate', async () => {
  reset(); trusted = true;
  const response = await login({ method: 'pin', pin: '0000' });
  assert.equal(response.status, 401);
  assert.equal(failedPin, 1);
  assert.equal(sessions, 0);
});

test('PIN lock prevents login on a trusted device', async () => {
  reset(); trusted = true; blocked = true;
  const response = await login({ method: 'pin', pin: '5382' });
  assert.equal(response.status, 429);
  assert.equal(sessions, 0);
  assert.equal(pinChecked, 0);
});

test('administrator cannot use PIN-only login', async () => {
  reset('admin', true); trusted = true;
  const response = await login({ method: 'pin', pin: '5382' });
  assert.equal(response.status, 401);
  assert.equal(sessions, 0);
});

test('accounts without PIN still log in with their existing password', async () => {
  reset('driver', false);
  const response = await login({ method: 'password', password: 'correct-password' });
  assert.equal(response.status, 200);
  assert.equal(sessions, 1);
  assert.equal(trustedIssued, 0);
});

test('cross-site login is refused', async () => {
  reset();
  const response = await api.POST(new Request('https://saswavlo.makhara.ge/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ email: 'driver@example.org', method: 'pin', pin: '5382' }),
  }));
  assert.equal(response.status, 403);
  assert.equal(sessions, 0);
});
