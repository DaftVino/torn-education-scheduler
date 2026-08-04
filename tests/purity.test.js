'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { SOURCE_PATH } = require('./load-userscript');

// The scan reads source as text, so `window` in an English comment used to
// fail it. Strip comments first — but with a scanner, not a regex: a naive
// //-to-end-of-line rule eats the rest of any string containing "http://".
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | single | double | template
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // keep line numbers honest
      i += 1; continue;
    }
    // inside a string literal
    if (c === '\\') { out += c + (next || ''); i += 2; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code';
    }
    out += c; i += 1; continue;
  }
  return out;
}

// The design's central claim is that the engine is pure and therefore
// testable. This makes that a checked property rather than a promise.
test('the engine section touches no browser, network, or clock API', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const start = src.indexOf('─── ENGINE START');
  const end = src.indexOf('─── ENGINE END');
  assert.ok(start !== -1 && end !== -1, 'engine section markers not found');
  assert.ok(end > start, 'engine markers are out of order');
  const engine = stripComments(src.slice(start, end));

  const forbidden = [
    /\bdocument\b/, /\bwindow\b/, /\blocation\b/, /\bGM_\w+/,
    /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bDate\.now\b/, /new Date\s*\(\s*\)/,
    /\bsetTimeout\b/, /\bsetInterval\b/, /\blocalStorage\b/, /\bMath\.random\b/,
  ];
  for (const pattern of forbidden) {
    assert.strictEqual(pattern.test(engine), false, `engine section must not use ${pattern}`);
  }
});

test('the engine section is not empty', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const engine = src.slice(src.indexOf('─── ENGINE START'), src.indexOf('─── ENGINE END'));
  assert.ok(engine.length > 500, 'engine section looks empty — markers may have moved');
});

test('the purity scan ignores forbidden words inside comments', () => {
  const sample = [
    '// a comment mentioning window, location and document freely',
    '/* a block comment mentioning fetch( and Date.now too */',
    'const legitimate = "a string is not a comment";',
    'function pure(a) { return a + 1; }',
  ].join('\n');
  const stripped = stripComments(sample);
  assert.ok(!/\bwindow\b/.test(stripped), 'line comment survived stripping');
  assert.ok(!/\bDate\.now\b/.test(stripped), 'block comment survived stripping');
  assert.ok(/a string is not a comment/.test(stripped), 'string literal was destroyed');
  assert.ok(/function pure/.test(stripped), 'code was destroyed');
});

test('the purity scan still catches a real violation in engine code', () => {
  const sample = 'function bad() { return document.querySelector("x"); }';
  assert.ok(/\bdocument\b/.test(stripComments(sample)), 'a real violation was masked');
});
