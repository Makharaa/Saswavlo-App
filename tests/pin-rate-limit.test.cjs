const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { PGlite } = require('@electric-sql/pglite');
const source = path.join(__dirname, '../src/lib/pin-auth.ts');
process.env.AUTH_SECRET = 'pin-limit-testing-secret-at-least-32-characters';

let clientDb;
const db = { query: async (...args) => clientDb.query(...args), connect: async () => ({
  query: async (...args) => clientDb.query(...args), release() {},
}) };
const mocks = {
  'server-only': {},
  'next/headers': { cookies: async () => ({ get() { return null; }, set() {} }) },
  '@/lib/db': { pool: db },
  '@/lib/migrations': { ensureDatabase: async () => {} },
  '@/lib/auth': { hashPassword: async () => '', verifyPassword: async () => false },
};
let api;
const previous = Module._load;
Module._load = function(name, parent, isMain) {
  if (parent?.filename === source && Object.hasOwn(mocks, name)) return mocks[name];
  return previous.call(this, name, parent, isMain);
};
try {
  const mod = new Module(source, module);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  api = mod.exports;
} finally { Module._load = previous; }

test('PIN locks after 5 mistakes and does not store digits in rate-limit table', async () => {
  clientDb = new PGlite();
  try {
    await clientDb.exec(`CREATE TABLE pin_login_attempts (
      user_id BIGINT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), blocked_until TIMESTAMPTZ NULL);`);
    for (let i = 1; i <= 4; i++) {
      const result = await api.recordPinFailure(11);
      assert.equal(result.blocked, false);
    }
    assert.equal((await api.pinAttemptsBlocked(11)).blocked, false);
    const last = await api.recordPinFailure(11);
    assert.equal(last.blocked, true);
    assert.equal((await api.pinAttemptsBlocked(11)).blocked, true);
    const rows = await clientDb.query('SELECT failures,blocked_until FROM pin_login_attempts WHERE user_id=$1', [11]);
    assert.equal(rows.rows[0].failures, 5);
    assert.ok(rows.rows[0].blocked_until);
    await api.clearPinFailures(11);
    assert.equal((await api.pinAttemptsBlocked(11)).blocked, false);
  } finally { await clientDb.close(); }
});
