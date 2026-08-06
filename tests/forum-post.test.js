'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROUTE_CODES,
  buildForumPostReport,
  compareRawCatalogue,
  verifyForumPostDraft,
} = require('../scripts/forum-post-data');

test('the shipped guide presets match the editorial route definitions', () => {
  const { exports: scheduler } = require('./load-userscript').loadUserscript();
  const shipped = Object.fromEntries(
    scheduler.GUIDE_PRESETS.map((preset) => [preset.key, [...preset.courseCodes]])
  );
  assert.deepStrictEqual(shipped, ROUTE_CODES);
});

test('the forum routes are followable from a brand-new account and retain their published totals', () => {
  const report = buildForumPostReport();
  const expected = {
    foundation: [28, 3700, 0],
    fighting: [231, 22530, 49],
    crime: [252, 20180, 70],
    trader: [203, 13850, 21],
    undecided: [210, 29950, 28],
  };

  for (const [key, [days, cost, remainingAt182]] of Object.entries(expected)) {
    const route = report.routes[key];
    assert.strictEqual(route.days, days, `${key} days drifted`);
    assert.strictEqual(route.cost, cost, `${key} cost drifted`);
    assert.strictEqual(route.remainingAt182, remainingAt182, `${key} checkpoint drifted`);
    assert.deepStrictEqual(route.problems, [], `${key} is no longer prerequisite-clean`);
    assert.strictEqual(new Set(route.courseIds).size, route.courseIds.length, `${key} contains duplicates`);
  }
});

test('the approved focus taxonomy remains complete and unchanged', () => {
  const report = buildForumPostReport();
  assert.deepStrictEqual(report.taxonomy.health, { stale: 0, unmapped: 0, entries: 120 });
  assert.deepStrictEqual(report.taxonomy.totals, { selections: 75, links: 120, courses: 100 });
  assert.deepStrictEqual(report.taxonomy.categories['Unlocks & Abilities'], {
    selections: 35, links: 36, courses: 23,
  });
  assert.deepStrictEqual(report.taxonomy.categories['Medical Effectiveness'], {
    selections: 2, links: 3, courses: 3,
  });
});

test('internal payload fact checks and later-course totals still match Torn data', () => {
  const report = buildForumPostReport();
  assert.strictEqual(report.factChecks.length, 10);
  assert.ok(report.factChecks.every((check) => check.ok));
  assert.deepStrictEqual(report.categories.Business, { days: 259, cost: 12800 });
  assert.deepStrictEqual(report.categories.Law, { days: 266, cost: 28745 });
  assert.deepStrictEqual(report.reduction, { ratio: 0.6, constant: true });
});

test('the fresh raw catalogue comparator ignores account state but catches catalogue drift', () => {
  const report = buildForumPostReport();
  const raw = JSON.parse(JSON.stringify(report.rawFixture));
  raw.categories[0].courses[0].status = 'completed';
  raw.activeCourse = { id: 999, completedAt: 1999999999 };
  assert.deepStrictEqual(compareRawCatalogue(raw, report.rawFixture), {
    categories: 12,
    courses: 131,
  });

  raw.categories[0].courses[0].originDuration += 1;
  assert.throws(() => compareRawCatalogue(raw, report.rawFixture), /catalogue differs/);
});

test('the paste-ready BBCode contains the verified facts without naming other articles', () => {
  const report = buildForumPostReport();
  const draft = fs.readFileSync(path.join(__dirname, '..', 'docs', 'forum-post.md'), 'utf8');
  assert.doesNotThrow(() => verifyForumPostDraft(draft, report));
});

test('the printed capture recipe carries both Torn request requirements', () => {
  const recipe = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'scrub-fixture.mjs'), 'utf8');
  assert.match(recipe, /rfc_v.*rfc_id/s);
  assert.match(recipe, /educationInitData&rfcv=/);
  assert.match(recipe, /X-Requested-With.*XMLHttpRequest/s);
  assert.match(recipe, /credentials: 'same-origin'/);
});
