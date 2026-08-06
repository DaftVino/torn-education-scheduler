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
    '--tm-accent-text',
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

test('no panel text is black or painted with a background token', () => {
  const outside = outsideTokenBlock(css());
  assert.ok(!/color\s*:\s*black\b/i.test(outside), 'black text is outside the selected dark theme');
  assert.ok(!/color\s*:\s*#0{3,8}\b/i.test(outside), 'black hex text is outside the selected dark theme');
  assert.ok(!/color\s*:\s*var\(--tm-bg(?:-[a-z0-9]+)?\)/i.test(outside),
    'a background token is being used as text');
});

test('selected read-only layouts reflow without card or hover treatment', () => {
  const text = css();
  assert.match(text, /\.tes-degree-list[^}]*repeat\(auto-fit,\s*minmax\(/,
    'the degree list does not collapse from two columns naturally');
  assert.match(text, /\.tes-degree-row[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(text, /\.tes-queue-row[^}]*grid-template-columns:\s*30px minmax\(0,\s*1fr\) auto/);
  assert.match(text, /\.tes-booster-row[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  for (const name of ['tes-degree-row', 'tes-queue-row', 'tes-booster-row']) {
    const bodies = [...text.matchAll(new RegExp(`\\.${name}[^:{]*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]).join('\n');
    assert.ok(!/background\s*:|box-shadow\s*:/.test(bodies), `${name} gained card-like treatment`);
    assert.ok(!new RegExp(`\\.${name}:hover`).test(text), `${name} gained a hover cue despite being read-only`);
  }
});

test('ghost queue controls consume the existing row height without adding a gap', () => {
  const text = css();
  assert.match(text, /\.tes-queue-row[^}]*position:\s*relative/);
  assert.match(text, /\.tes-reorder[^}]*position:\s*absolute[^}]*inset-block:\s*0[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*width:\s*30px/);
  assert.match(text, /\.tes-move[^}]*flex:\s*1 1 50%[^}]*min-height:\s*0[^}]*padding:\s*0/);
  assert.doesNotMatch(text, /\.tes-reorder[^}]*\bgap\s*:/, 'the two ghost buttons gained space at their shared middle edge');

  const moveRules = [...text.matchAll(/\.tes-move[^:{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
  assert.doesNotMatch(moveRules, /tm-good|#0{3,8}\b|\bblack\b/i,
    'the neutral reorder control picked up green or black styling');
  assert.match(text, /\.tes-move:disabled[^}]*cursor:\s*default/);
});

test('overview surfaces, aggregate banner, and Settings bars have clear hierarchy', () => {
  const text = css();
  assert.match(text, /\.tes-overview[^}]*border:[^;]*var\(--tm-good-text\)/,
    'Schedule and Focus overview surfaces need the shared green outline');
  assert.match(text, /\.tes-overview[^}]*background:\s*var\(--tm-bg-3\)/,
    'overview surfaces need a distinct dark fill');
  assert.match(text, /\.tes-focus-rank-toggle[^}]*margin-bottom:/,
    'Focus guidance still crowds its sorting button');
  assert.match(text, /\.tes-all-banner[^}]*display:\s*grid/,
    'the all-remaining banner is not using its horizontal space');
  assert.match(text, /\.tes-all-figures[^}]*display:\s*flex/,
    'the aggregate metadata and finish date should share one wrapping line');
  assert.match(text, /\.tes-all-title[^}]*font-size:\s*var\(--tes-text-lg\)/);
  assert.match(text, /\.tes-all-finish[^}]*font-size:\s*var\(--tes-text-lg\)/);
  assert.match(text, /\.tes-section-header[^}]*background:\s*var\(--tm-good-bg\)/,
    'Settings headers need the selected dark-green bar');
  assert.match(text, /\.tes-section-title[^}]*color:\s*var\(--tm-text\)/,
    'Settings titles must stay light on the green bar');
  assert.match(text, /\.tes-section-role[^}]*color:\s*var\(--tm-text\)/,
    'small Settings role labels need full-contrast light text on the green bar');
});

test('comparable numbers align and Torn-owned text cannot force overflow', () => {
  const text = css();
  for (const name of ['tes-degree-date', 'tes-booster-finish', 'tes-booster-detail']) {
    assert.match(text, new RegExp(`\\.${name}[^}]*font-variant-numeric:\\s*tabular-nums`),
      `${name} does not use tabular figures`);
  }
  assert.match(text, /input\[type="number"\][^}]*font-variant-numeric:\s*tabular-nums/);
  for (const name of ['tes-degree-main', 'tes-queue-main', 'tes-queue-detail']) {
    assert.match(text, new RegExp(`\\.${name}[^}]*min-width:\\s*0[^}]*overflow-wrap:\\s*anywhere`),
      `${name} can be forced wider by Torn-owned text`);
  }
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

test('ratio() agrees with contrast pairs that have a known exact answer', () => {
  // Two anchors, because one grey pair and one chromatic pair catch different
  // failure modes in ratio() — neither substitutes for the other.
  //
  // Black on white is WCAG's own worked example: (1 + 0.05) / (0 + 0.05) = 21,
  // exactly, because lin(0) = 0 and lin(255) = 1 with no rounding in between
  // (0.2126 + 0.7152 + 0.0722 === 1 in IEEE 754 double, so no float slop
  // enters either). This anchors the sRGB piecewise transform, the +0.05
  // offsets, and the hi/lo ordering that picks the lighter colour — a broken
  // transform or a swapped numerator/denominator moves this number.
  //
  // It does NOT anchor the three luminance weights against each other. Black
  // and white are achromatic (R = G = B on both), so permuting which weight
  // multiplies which channel changes nothing when the channels already carry
  // equal values: confirmed by temporarily swapping the 0.2126/0.7152
  // coefficients in this file's lin()/L() and re-running — this assertion
  // still read exactly 21. Pure red against black closes that gap: its
  // luminance depends on the red weight alone (green and blue channels are
  // both 0), so a transposed red/green weight moves it by roughly 3x rather
  // than a rounding nudge — confirmed by the same swap, which moved this
  // second assertion from 5.252 to 15.304 and made it fail. Together the two
  // anchors cover both fault classes: black/white catches a broken formula
  // shape, red/black catches a mis-assigned channel weight.
  assert.strictEqual(ratio('#000000', '#ffffff'), 21);
  assert.strictEqual(Number(ratio('#ff0000', '#000000').toFixed(3)), 5.252);
});

test('every -text token clears WCAG AA against the panel background', () => {
  const block = tokenBlock(css());
  const val = (name) => (new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`).exec(block) || [])[1];
  const bg = val('--tm-bg');
  for (const name of ['--tm-text', '--tm-muted', '--tm-meta', '--tm-good-text', '--tm-bad-text', '--tm-accent-text']) {
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
