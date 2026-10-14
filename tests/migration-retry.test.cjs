const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

test('database initialization recovers from a failed connection and coalesces retries', async () => {
  const file = path.resolve(__dirname, '../src/lib/migrations.ts');
  const oldLoad = Module._load;
  const oldTs = require.extensions['.ts'];
  let connections = 0;
  let releases = 0;
  const pool = {
    async connect() {
      if (++connections === 1) throw new Error('temporary connection outage');
      return { query: async () => ({ rows: [] }), release() { releases++; } };
    },
  };
  Module._load = function(request, parent, isMain) {
    if (request === './db' && parent?.filename === file) return { pool };
    return oldLoad.call(this, request, parent, isMain);
  };
  require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  try {
    const { ensureDatabase } = require(file);
    await assert.rejects(ensureDatabase(), /temporary connection outage/);
    await Promise.all([ensureDatabase(), ensureDatabase(), ensureDatabase()]);
    assert.equal(connections, 2);
    assert.equal(releases, 1);
    await ensureDatabase();
    assert.equal(connections, 2, 'an initialized database needs no further migration connection');
  } finally {
    Module._load = oldLoad;
    if (oldTs) require.extensions['.ts'] = oldTs;
    else delete require.extensions['.ts'];
    delete require.cache[file];
  }
});
