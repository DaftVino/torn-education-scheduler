'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript } = require('./load-userscript');

function css() { return loadUserscript().exports.panelStyleText(); }

function tokenBlock(text) {
  const m = /#tes-panel\s*\{([\s\S]*?)\}/.exec(text);
  return m ? m[1] : '';
}
function outsideTokenBlock(text) {
  return text.replace(/#tes-panel\s*\{[\s\S]*?\}/, '');
}

test('the token block declares every colour, type, spacing and focus token', () => {
  const block = tokenBlock(css());
  for (const name of ['--tm-bg', '--tm-border-2', '--tm-text', '--tm-muted', '--tm-meta',
    '--tm-good-text', '--tm-bad-text', '--tes-text', '--tes-text-sm',
    '--tes-gap', '--tes-gap-lg', '--tes-focus-ring']) {
    assert.ok(block.includes(name), `missing token ${name}`);
  }
});

test('no hex literal survives outside the token block', () => {
  const found = outsideTokenBlock(css()).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const real = found.filter((h) => !/^#tes/.test(h));
  assert.deepStrictEqual(real, [], `hex literals outside the token block: ${real.join(', ')}`);
});

test('every declared token is referenced, and every referenced token is declared', () => {
  const text = css();
  const declared = new Set((tokenBlock(text).match(/--[a-z0-9-]+(?=\s*:)/g) || []));
  const used = new Set((text.match(/var\((--[a-z0-9-]+)\)/g) || []).map((s) => s.slice(4, -1)));
  for (const d of declared) assert.ok(used.has(d), `token ${d} is declared but never used`);
  for (const u of used) assert.ok(declared.has(u), `token ${u} is used but never declared`);
});

test('the token block is scoped to the panel and leaks nothing to :root', () => {
  assert.ok(!/:root/.test(css()), 'the panel must not declare variables on Torn\'s page');
});

test('no font-family is declared anywhere', () => {
  assert.ok(!/font-family/.test(css()),
    'the panel inherits Torn\'s font — this is a decision, not an omission');
});

test('color-mix is not used', () => {
  assert.ok(!/color-mix\(/.test(css()));
});
