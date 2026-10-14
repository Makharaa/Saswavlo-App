const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const source = path.join(__dirname, '../src/lib/pin-auth.ts');
process.env.AUTH_SECRET = 'integration-test-secret-never-used-in-production-2026';
let tokenHash = '';
const savedCookies = new Map();
let enabled = true;
const mock = {
  'server-only': {},
  'next/headers': { cookies: async () => ({
    get: (name) => savedCookies.get(name),
    set: (name, value, options) => savedCookies.set(name, { value, options }),
  }) },
  '@/lib/db': { pool: {
    query: async (sql, values) => {
      if (sql.includes('INSERT INTO trusted_login_devices')) {
        tokenHash = values[1];
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT 1 FROM trusted_login_devices')) return { rowCount: enabled && values[1] === tokenHash ? 1 : 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  } },
  '@/lib/migrations': { ensureDatabase: async () => {} },
  '@/lib/auth': {
    hashPassword: async (value) => {
      const { scryptSync, randomBytes } = require('crypto');
      const salt = randomBytes(16).toString('hex');
      return `test$${salt}$${scryptSync(value, salt, 32).toString('hex')}`;
    },
    verifyPassword: async (value, encoded) => {
      const { scryptSync, timingSafeEqual } = require('crypto');
      const [, salt, hex] = encoded.split('$');
      const expected = Buffer.from(hex, 'hex');
      return timingSafeEqual(expected, scryptSync(value, salt, expected.length));
    },
  },
};
let api;
const previousLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === source && Object.hasOwn(mock, request)) return mock[request];
  return previousLoad.call(this, request, parent, isMain);
};
try {
  const mod = new Module(source, module);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  api = mod.exports;
} finally { Module._load = previousLoad; }

test('PIN format requires exactly four digits including leading zeros', () => {
  assert.equal(api.validPin('0183'), true);
  assert.equal(api.weakPin('1234'), true);
  assert.equal(api.weakPin('5382'), false);
  for (const candidate of ['123', '12345', 'abc4', '12 4', 1234, '', null]) assert.equal(api.validPin(candidate), false);
});

test('PIN is never stored as four clear-text digits; peppered hashes are salted', async () => {
  const one = await api.hashPin('5382');
  const two = await api.hashPin('5382');
  assert.notEqual(one, two);
  assert.equal(one.includes('5382'), false);
  assert.equal(await api.verifyPin('5382', one), true);
  assert.equal(await api.verifyPin('5383', one), false);
});

test('trusted device stores random token only in HttpOnly cookie; DB stores its hash', async () => {
  savedCookies.clear(); tokenHash = '';
  await api.trustCurrentDevice(77);
  const cookie = savedCookies.get('driveexam_trusted_device');
  assert.ok(cookie?.value.length >= 40);
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.sameSite, 'strict');
  assert.equal(cookie.options.path, '/');
  assert.equal(tokenHash.length, 64);
  assert.notEqual(tokenHash, cookie.value);
  assert.equal(await api.isTrustedDevice(77), true);
  enabled = false;
  assert.equal(await api.isTrustedDevice(77), false);
  enabled = true;
  await api.clearTrustedDeviceCookie();
  assert.equal(savedCookies.get('driveexam_trusted_device').options.maxAge, 0);
  assert.equal(await api.isTrustedDevice(77), false);
});
