const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = join(__dirname, '..');
const helperPath = join(root, 'src/utils/admin-user-list.ts');
const compiled = ts.transpileModule(readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const instance = new Module(helperPath, module);
instance.filename = helperPath;
instance.paths = Module._nodeModulePaths(dirname(helperPath));
instance._compile(compiled.outputText, helperPath);
const { filterAndSortAdminUsers: filter } = instance.exports;

const users = [
  { id: 3, name: 'ნიკა', email: 'nika@example.com', role: 'driver', isActive: true, canUseRoutes: true, createdAt: '2026-10-09T10:00:00Z' },
  { id: 2, name: 'Dato', email: 'dato@example.com', role: 'driver', isActive: true, canUseRoutes: false, createdAt: '2026-10-01T10:00:00Z' },
  { id: 1, name: 'Admin', email: 'admin@example.com', role: 'admin', isActive: true, canUseRoutes: true, createdAt: '2026-09-01T10:00:00Z' },
  { id: 4, name: 'შეზღუდული', email: 'inactive@example.com', role: 'driver', isActive: false, canUseRoutes: false, createdAt: '2026-10-10T10:00:00Z' },
];
const state = { query: '', role: 'all', status: 'all', sort: 'newest' };
const ids = (overrides) => filter(users, { ...state, ...overrides }).map((user) => user.id);

test('status filter handles active, inactive, and route-restricted independently', () => {
  assert.deepEqual(ids({ status: 'active' }), [3, 2, 1]);
  assert.deepEqual(ids({ status: 'inactive' }), [4]);
  assert.deepEqual(ids({ status: 'no-routes' }), [2]);
  assert.deepEqual(ids({ status: 'all' }), [4, 3, 2, 1]);
});

test('date sorting switches directions, name sorting is alphabetical', () => {
  assert.deepEqual(ids({ sort: 'newest' }), [4, 3, 2, 1]);
  assert.deepEqual(ids({ sort: 'oldest' }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ sort: 'name' }), [...users].sort((a, b) => a.name.localeCompare(b.name, 'ka')).map((user) => user.id));
});

test('search and role filter compose with statuses and sort', () => {
  assert.deepEqual(ids({ query: 'NIKA', role: 'driver' }), [3]);
  assert.deepEqual(ids({ query: 'inactive@', status: 'active' }), []);
  assert.deepEqual(ids({ role: 'admin', status: 'no-routes' }), []);
});

test('sorting does not mutate the source array', () => {
  filter(users, { ...state, sort: 'oldest' });
  assert.deepEqual(users.map((user) => user.id), [3, 2, 1, 4]);
});

test('admin page uses shared AppSelect instead of native selects for all filters and editing', () => {
  const source = readFileSync(join(root, 'src/features/admin/user-manager.tsx'), 'utf8');
  assert.equal((source.match(/<AppSelect</g) || []).length, 5);
  assert.equal((source.match(/<select\b/g) || []).length, 0);
  assert.match(source, /aria-label="მომხმარებლის ძებნა სახელით ან ელფოსტით"/);
  assert.ok(source.includes('filterAndSortAdminUsers'));
});
