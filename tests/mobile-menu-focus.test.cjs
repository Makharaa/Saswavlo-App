const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const header = readFileSync(join(__dirname, '../src/components/app-header.tsx'), 'utf8');

test('mobile drawer moves focus to trigger before hiding', () => {
  const closing = header.match(/function closeMobileMenu\(\)\s*\{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(closing, 'shared close handler exists');
  const focus = closing.indexOf('menuToggleRef.current?.focus({ preventScroll: true })');
  const hide = closing.indexOf('setMenuOpen(false)');
  assert.ok(focus >= 0 && hide > focus, 'focus returns to menu trigger before close');
});

test('closed mobile drawer is inert and hidden from accessibility tree', () => {
  assert.match(header, /<aside\s+[\s\S]*?id="mobile-main-menu"[\s\S]*?aria-hidden=\{!menuOpen\}[\s\S]*?inert=\{!menuOpen\}/);
  assert.match(header, /ref=\{menuToggleRef\}/);
});

test('escape, backdrop, drawer close button, and drawer links use focus-safe close handler', () => {
  assert.match(header, /event\.key === "Escape"\) closeMobileMenu\(\)/);
  assert.match(header, /className=\{`mobile-menu-backdrop[^\n]*\n\s*onClick=\{closeMobileMenu\}/);
  assert.match(header, /<button type="button" onClick=\{closeMobileMenu\} aria-label="მენიუს დახურვა">/);
  assert.match(header, /href=\{targetHref\}\s*onClick=\{closeMobileMenu\}/);
});
