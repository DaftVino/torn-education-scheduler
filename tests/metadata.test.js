'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loadUserscript, SOURCE_PATH } = require('./load-userscript');

test('harness can load the userscript and reach its internals', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(typeof exports.isEducationPage, 'function');
  assert.strictEqual(exports.EDU_ENDPOINT, '/page.php?sid=educationInitData');
});

test('@version matches SCRIPT_VERSION and package.json', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const meta = src.match(/^\/\/ @version\s+(\S+)$/m);
  assert.ok(meta, '@version not found in metadata block');
  const { exports } = loadUserscript();
  assert.strictEqual(meta[1], exports.SCRIPT_VERSION);
  assert.strictEqual(meta[1], require('../package.json').version);
});

test('@match and @grant are exactly the declared security surface', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const matches = [...src.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((m) => m[1]);
  const grants = [...src.matchAll(/^\/\/ @grant\s+(\S+)$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(matches, ['https://www.torn.com/page.php*']);
  assert.deepStrictEqual(grants.sort(), ['GM_getValue', 'GM_setValue']);
  assert.strictEqual(/^\/\/ @connect/m.test(src), false, '@connect must not be present');
});

test('the education page guard accepts only the education page', () => {
  const cases = [
    ['?sid=education', true],
    ['?sid=education&foo=1', true],
    ['?foo=1&sid=education', true],
    ['?sid=educationInitData', false],
    ['?sid=bookie', false],
    ['', false],
  ];
  for (const [search, expected] of cases) {
    const { exports } = loadUserscript({ location: { search } });
    assert.strictEqual(exports.isEducationPage(), expected, `search=${search}`);
  }
});
