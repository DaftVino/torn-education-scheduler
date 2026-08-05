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

// CLAUDE.md repo-specific constraint 3: "@version, the newest CHANGELOG.md
// heading, and the git tag move together in one commit." The first two thirds
// of that rule were described and not enforced until this release, which is
// how 0.3.0 came to sit in the changelog under a version that was never
// tagged. The tag itself cannot be checked here — it does not exist until the
// merge commit lands — but the pair that ships inside the file can be.
test('the newest CHANGELOG heading is the version being shipped', () => {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', `file://${__dirname}/`), 'utf8');
  // [Unreleased] is a standing heading, not a release, so the newest RELEASE
  // heading is the first one carrying a version number.
  const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(newest, 'no released version heading found in CHANGELOG.md');
  const { exports } = loadUserscript();
  assert.strictEqual(newest[1], exports.SCRIPT_VERSION,
    'the newest CHANGELOG heading and @version disagree — a bumped script ships invisibly');
});

test('@match and @grant are exactly the declared security surface', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const matches = [...src.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((m) => m[1]);
  const grants = [...src.matchAll(/^\/\/ @grant\s+(\S+)$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(matches, ['https://www.torn.com/page.php*']);
  assert.deepStrictEqual(grants.sort(), ['GM_getValue', 'GM_setValue']);
  assert.strictEqual(/^\/\/ @connect/m.test(src), false, '@connect must not be present');
});

test('@downloadURL and @updateURL are absent, and stay that way', () => {
  // There is no deploy target — the release is a tag plus the raw file URL —
  // so neither directive belongs here. Both are correctly absent today; this
  // guards against a future edit adding either silently.
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert.strictEqual(/^\/\/ @downloadURL/m.test(src), false, '@downloadURL must not be present');
  assert.strictEqual(/^\/\/ @updateURL/m.test(src), false, '@updateURL must not be present');
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
