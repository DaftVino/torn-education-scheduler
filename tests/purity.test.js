'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { SOURCE_PATH } = require('./load-userscript');

// The design's central claim is that the engine is pure and therefore
// testable. This makes that a checked property rather than a promise.
test('the engine section touches no browser, network, or clock API', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const start = src.indexOf('─── ENGINE START');
  const end = src.indexOf('─── ENGINE END');
  assert.ok(start !== -1 && end !== -1, 'engine section markers not found');
  assert.ok(end > start, 'engine markers are out of order');
  const engine = src.slice(start, end);

  const forbidden = [
    /\bdocument\b/, /\bwindow\b/, /\blocation\b/, /\bGM_\w+/,
    /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bDate\.now\b/, /new Date\s*\(\s*\)/,
    /\bsetTimeout\b/, /\bsetInterval\b/, /\blocalStorage\b/,
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
