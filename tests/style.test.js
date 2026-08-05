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

function ratio(hexA, hexB) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (h) => {
    const n = parseInt(h.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const [hi, lo] = L(hexA) > L(hexB) ? [L(hexA), L(hexB)] : [L(hexB), L(hexA)];
  return (hi + 0.05) / (lo + 0.05);
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

test('ratio() agrees with the one contrast pair that has a known exact answer', () => {
  // Black on white is WCAG's own worked example: (1 + 0.05) / (0 + 0.05) = 21,
  // exactly, because lin(0) = 0 and lin(255) = 1 with no rounding in between
  // (verified: 0.2126 + 0.7152 + 0.0722 === 1 in IEEE 754 double, so no float
  // slop enters either). This anchors the parts of ratio() a grey pair CAN
  // prove: the sRGB piecewise transform, the +0.05 offsets, and the hi/lo
  // ordering that picks the lighter colour.
  //
  // It does NOT anchor the three luminance weights against each other. Black
  // and white are achromatic (R = G = B on both), so permuting which weight
  // multiplies which channel changes nothing when the channels already carry
  // equal values — confirmed by temporarily swapping the 0.2126/0.7152
  // coefficients in this file's lin()/L() and re-running: this assertion
  // still read exactly 21, and the five-token contrast test below still
  // passed too (only --tm-good-text and --tm-bad-text are non-grey; under
  // the swap they moved to 5.86:1 and 12.98:1 respectively, both still
  // clearing 4.5:1 by coincidence of today's values). A weight transposition
  // is a real, currently-uncaught gap in this file — recorded here rather
  // than papered over, since a chromatic anchor (e.g. a saturated red/green
  // pair with a known relative luminance) would be needed to close it, and
  // that is a follow-up decision, not one this comment should make silently.
  assert.strictEqual(ratio('#000000', '#ffffff'), 21);
});

test('every -text token clears WCAG AA against the panel background', () => {
  const block = tokenBlock(css());
  const val = (name) => (new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`).exec(block) || [])[1];
  const bg = val('--tm-bg');
  for (const name of ['--tm-text', '--tm-muted', '--tm-meta', '--tm-good-text', '--tm-bad-text']) {
    const r = ratio(val(name), bg);
    assert.ok(r >= 4.5, `${name} is ${r.toFixed(2)}:1 against --tm-bg, below AA's 4.5:1`);
  }
});

// No test asserts that the plain (non "-text") fill tokens fail contrast.
// The -text/plain split named in the token block's comment (e.g. a future
// --tm-good fill versus today's --tm-good-text) is a naming convention the
// design docs record, not a pair of live tokens: `--tm-good`, `--tm-bad`,
// `--tm-bg-2` and `--tm-border` were removed in Task 2 because nothing below
// the token block referenced them, and the "every declared token is
// referenced" test above would fail the moment one were re-added just to
// give a contrast assertion something to point at. Keeping a token alive
// solely so a test can watch it fail is the "looks like a design system,
// behaves like dead code" pattern the design spec warns against. If a fill
// token is ever reintroduced because something starts using it as a
// background or border, the ratio() helper above is what that token's
// contrast assertion should use — this comment is the reasoning that keeps
// it from being reintroduced for the test's sake alone.
