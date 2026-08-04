'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { SOURCE_PATH } = require('./load-userscript');

const { stripComments } = require('./strip-comments');

// The comment stripper this scan depends on lives in ./strip-comments.js, so
// tests/code-map.test.js can run the same one instead of a weaker copy. Its
// tests stay here, where they were written.

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

test('a regex literal ending in an escaped slash does not swallow the code after it', () => {
  const inputs = [
    "const RE = /a\\//; document.title = 'x';",
    "const isUrl = /^https?:\\/\\//i; document.title = 'y';",
  ];
  for (const sample of inputs) {
    const stripped = stripComments(sample);
    assert.ok(/\bdocument\b/.test(stripped), `code after the regex literal was swallowed: ${sample}`);
  }
});

test('a regex character class containing a slash does not end the regex early', () => {
  const sample = "const re = /[/]/; document.title = 'z';";
  const stripped = stripComments(sample);
  assert.ok(/\bdocument\b/.test(stripped), 'code after the character class was swallowed');
});

test('division after an identifier is not mistaken for a regex literal', () => {
  const sample = 'const half = total / 2; const other = count / 2;';
  const stripped = stripComments(sample);
  assert.strictEqual(stripped, sample, 'plain division code was altered by the scanner');
});

test('a nested template literal inside a substitution does not end the outer template early', () => {
  const sample = "const s = `outer ${`inner ${1 + 1}` } tail`; document.title = 'nested';";
  const stripped = stripComments(sample);
  assert.ok(/\bdocument\b/.test(stripped), 'code after the nested template was swallowed');
});

test('comment-like sequences inside ordinary string literals are not treated as real comments', () => {
  const sample = [
    "const a = 'http://example.com'; document.title = 'p';",
    'const b = "/* not a comment */"; document.title = \'q\';',
  ].join('\n');
  const stripped = stripComments(sample);
  const matches = stripped.match(/\bdocument\b/g) || [];
  assert.strictEqual(matches.length, 2, 'code after a string containing // or /* was swallowed');
});

// tests/code-map.test.js resolves an anchor by index into the stripped text and
// reports the line it lands on, so a stripper that dropped or added a line
// would make that check report *wrong line numbers* — trusted wrong anchors,
// the one failure the code-map check exists to prevent. The property holds
// today and is relied on by a second test file, so it is asserted rather than
// inferred from those tests passing.
test('stripping comments never changes the number of lines', () => {
  const samples = [
    'const a = 1; // trailing\nconst b = 2;\n',
    '/* a block\n   spanning\n   three lines */\nconst c = 3;\n',
    'const d = 4;\r\n// crlf comment\r\nconst e = 5;\r\n',
    'const re = /a\/*b/;\nfunction alpha() {}\nfunction beta() {}\n',
    'const s = `outer ${`inner`}\nsecond line`;\n',
    '// only a comment\n',
    '',
  ];
  for (const sample of samples) {
    assert.strictEqual(
      stripComments(sample).split('\n').length,
      sample.split('\n').length,
      `line count changed for: ${JSON.stringify(sample.slice(0, 40))}`,
    );
  }

  // And against the real file, which is what the code-map check runs on.
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert.strictEqual(
    stripComments(src).split('\n').length,
    src.split('\n').length,
    'stripping the userscript changed its line count',
  );
});

// The line-for-line correspondence the above implies: a declaration must still
// be findable at the same index after stripping.
test('a declaration keeps its line number through stripping', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const raw = src.split(/\r?\n/);
  const stripped = stripComments(src).split(/\r?\n/);
  const i = raw.findIndex((line) => /^\s*async function init\(\) \{/.test(line));
  assert.ok(i !== -1, 'init() declaration not found in the source');
  assert.match(stripped[i], /async function init\(\) \{/, 'the declaration moved lines during stripping');
});
