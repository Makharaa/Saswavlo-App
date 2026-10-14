const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const page = readFileSync(join(root, 'src/features/admin/user-manager.tsx'), 'utf8');
const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
const api = readFileSync(join(root, 'src/app/api/admin/users/[id]/route.ts'), 'utf8');

test('admin users lists statistics, search, filters, and incremental loading', () => {
  for (const text of ['სულ მომხმარებლები','მძღოლები','ადმინისტრატორები','მარშრუტებზე წვდომის გარეშე','visibleCount','მეტის ჩვენება']) {
    assert.ok(page.includes(text), text);
  }
});

test('editing sensitive account fields needs explicit save and confirmation', () => {
  assert.ok(page.includes('window.confirm('));
  assert.ok(page.includes('ცვლილებების შენახვა'));
  assert.ok(page.includes('payload.password = editPassword')); // editPassword variables and credential handling
  assert.ok(page.includes('canUseRoutes: nextCanUseRoutes'));
  assert.ok(api.includes('current.role !== "admin"'));
});

test('new user creation uses dialog and existing API without exposing passwords', () => {
  assert.ok(page.includes('<dialog ref={createDialog}'));
  assert.ok(page.includes('type="password"'));
  assert.ok(page.includes('method: "POST"'));
  assert.ok(!page.includes('console.log('));
});

test('admin users responsive styling is isolated to the page', () => {
  assert.ok(css.includes('/* Admin users — V25 account workspace'));
  assert.ok(css.includes('@media(max-width:690px)'));
  assert.ok(css.includes('.users-v25-edit-grid'));
});
