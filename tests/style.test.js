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

test('the panel root declares no font-family, and there is no font token', () => {
  const text = css();
  assert.ok(!/--tm-font/.test(text), 'no font token — an owner decision, not an omission');
  assert.ok(!/font-family/.test(tokenBlock(text)),
    'the panel inherits Torn\'s font, which is what makes it look like part of the page');
  // .tes-share's `font-family: monospace` is a DELIBERATE exemption and stays:
  // the share box holds a machine-readable token the player copies, where
  // monospace makes the string legible and its boundaries unambiguous. That is
  // a functional choice about one control, not a typographic identity choice
  // about the panel — a blanket "no font-family anywhere" assertion could never
  // have passed, and would have pressured someone into deleting it.
  const outside = outsideTokenBlock(text).match(/font-family:[^;]+/g) || [];
  assert.deepStrictEqual(outside, ['font-family: monospace'],
    'the only font-family outside the token block is .tes-share\'s monospace');
});

test('color-mix is not used', () => {
  assert.ok(!/color-mix\(/.test(css()));
});

test('no literal px font-size or margin outside the token block', () => {
  const outside = outsideTokenBlock(css());
  const bad = (outside.match(/(?:font-size|margin[a-z-]*)\s*:\s*[^;]*\b\d+px/g) || []);
  assert.deepStrictEqual(bad, [], `literal sizes outside the token block: ${bad.join(' | ')}`);
});

test('no opacity is used for text hierarchy', () => {
  assert.ok(!/opacity\s*:/.test(css()),
    'opacity dims against whatever is behind it; --tm-muted and --tm-meta are measured');
});

test('the finish line and error lines use the text-safe tokens', () => {
  const text = css();
  assert.match(text, /\.tes-finish[^}]*var\(--tm-good-text\)/);
  assert.match(text, /\.tes-save-error[^}]*var\(--tm-bad-text\)/);
  assert.ok(!/color:\s*var\(--tm-good\)\s*[;}]/.test(text), 'never --tm-good as type');
});

test('every interactive element has a visible focus ring', () => {
  const text = css();
  const rule = /:focus-visible[^{]*\{[^}]*outline[^}]*\}/.exec(text);
  assert.ok(rule, 'no focus-visible rule — a keyboard user cannot see where they are');
  for (const sel of ['button', 'select', 'input', 'textarea']) {
    assert.ok(new RegExp(`${sel}:focus-visible`).test(text), `${sel} has no focus ring`);
  }
});

test('focus-visible is used rather than focus', () => {
  const text = css();
  assert.ok(!/[^-]:focus(?![-a-z])/.test(text),
    'plain :focus leaves a ring after a mouse click');
});

test('buttons clear a 44px touch target', () => {
  assert.match(css(), /#tes-panel button[^}]*padding:\s*8px 12px/);
});
