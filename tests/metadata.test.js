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

// § K1. The two URL constants are placeholders until the script is published,
// and they resolve at different moments — the Greasy Fork listing exists before
// the forum post is written — so this is a two-pass resolution, not one.
//
// The failure being prevented is shipping a literal placeholder to users. That
// happens at publication, and the observable signal for "published" is
// @downloadURL/@updateURL: those only get added once a Greasy Fork listing
// exists to point at. So the two halves of § K1 are tied together here — adding
// auto-update without resolving the URLs fails the build.
test('an unresolved URL placeholder cannot ship alongside auto-update', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const hasPlaceholder = /REPLACE_BEFORE_LAUNCH/.test(src);
  const publishes = /^\/\/ @(downloadURL|updateURL)/m.test(src);
  assert.ok(
    !(hasPlaceholder && publishes),
    'the script declares auto-update while a URL is still REPLACE_BEFORE_LAUNCH — '
    + 'resolve GREASY_FORK_URL and FORUM_POST_URL before adding @downloadURL/@updateURL',
  );
});

// A half-edited URL is the state the guard above cannot see: replacing the
// domain but leaving the token, or vice versa, produces something that looks
// resolved to a reader and is not. Each constant is therefore either wholly a
// placeholder or wholly real, and isResolvedUrl is what every consumer tests.
test('each launch URL is wholly a placeholder or wholly resolved', () => {
  const { exports } = loadUserscript();
  for (const [name, url] of [['GREASY_FORK_URL', exports.GREASY_FORK_URL], ['FORUM_POST_URL', exports.FORUM_POST_URL]]) {
    assert.strictEqual(typeof url, 'string', `${name} is no longer a string`);
    const token = url.includes('REPLACE_BEFORE_LAUNCH');
    assert.strictEqual(exports.isResolvedUrl(url), !token, `${name} half-resolved`);
    if (!token) assert.match(url, /^https:\/\//, `${name} resolved to a non-https URL`);
  }
});

// The behaviour the placeholders must not change. They are non-empty strings,
// so a bare truthiness test would have started rendering links to a dead URL
// the moment null was replaced.
test('an unresolved placeholder renders no link anywhere', () => {
  const { exports } = loadUserscript();
  assert.strictEqual(exports.isResolvedUrl('https://greasyfork.org/scripts/REPLACE_BEFORE_LAUNCH'), false);
  assert.strictEqual(exports.isResolvedUrl('https://greasyfork.org/scripts/12345-tes'), true);
  assert.strictEqual(exports.isResolvedUrl(null), false);
  assert.strictEqual(exports.isResolvedUrl(''), false);
});

// Three places state this project's licence: the metadata block, package.json,
// and the LICENSE file. Only the first one ships — a player installs the raw
// .user.js and gets no repository with it — so the metadata block is the copy
// that has to be right, and the other two are what it must not contradict.
//
// Asserted rather than described because a licence mismatch is invisible until
// it matters, and by then the wrong terms are on somebody else's disk.
test('@license agrees with package.json and the LICENSE file', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const declared = src.match(/^\/\/ @license\s+(\S+)$/m);
  assert.ok(declared, '@license is missing from the metadata block — an installed copy would state no terms');
  assert.strictEqual(declared[1], require('../package.json').license);

  // The LICENSE file's own first line, not a second hardcoded string: this
  // fails if the file is swapped for a different licence without the metadata
  // block following it.
  const licenseFile = fs.readFileSync(new URL('../LICENSE', `file://${__dirname}/`), 'utf8');
  assert.match(licenseFile.split('\n')[0].trim(), new RegExp(`^${declared[1]}\\b`, 'i'),
    'the LICENSE file does not name the licence the script declares');
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
