'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loadUserscript, loadFixture, SOURCE_PATH } = require('./load-userscript');
const { buildForumPostReport } = require('../scripts/forum-post-data');

function setupFresh() {
  const { exports: x } = loadUserscript();
  const parsed = x.parsePayload(loadFixture());
  const courses = new Map();
  for (const [id, course] of parsed.courses) courses.set(id, { ...course, status: 'notStarted' });
  return { x, courses, completedIds: new Set(), activeCourse: null };
}

function byCode(courses, code) {
  return [...courses.values()].find((course) => course.prefix === code);
}

test('guide preset identity is exact, ordered, non-numeric, and deeply frozen in source', () => {
  const { exports: x } = loadUserscript();
  assert.deepStrictEqual(Array.from(x.GUIDE_PRESETS, (p) => p.label), [
    '0-Start Here', '1-Fighting', '2-Crime', '3-Trader / collector', '4-Undecided',
  ]);
  const values = x.GUIDE_PRESETS.map((p) => p.value);
  assert.strictEqual(new Set(values).size, 5);
  for (const value of values) {
    assert.match(value, /^__preset__:/);
    assert.ok(Number.isNaN(Number(value)));
    assert.notStrictEqual(value, x.ALL_COURSES_OPTION);
  }
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert.match(source, /const GUIDE_PRESETS = Object\.freeze\(\[/);
  assert.strictEqual((source.match(/courseCodes: Object\.freeze\(/g) || []).length, 5);
});

test('guidePresetForValue accepts only the five exact sentinels', () => {
  const { exports: x } = loadUserscript();
  for (const preset of x.GUIDE_PRESETS) assert.strictEqual(x.guidePresetForValue(preset.value).key, preset.key);
  for (const value of ['__preset__:missing', x.ALL_COURSES_OPTION, '', null, 1]) {
    assert.strictEqual(x.guidePresetForValue(value), null);
  }
});

test('every fresh-account preset matches the verified forum route and is followable', () => {
  const { x, courses, completedIds, activeCourse } = setupFresh();
  const report = buildForumPostReport();
  const counts = { foundation: 2, fighting: 12, crime: 15, trader: 10, undecided: 15 };
  const foundationIds = new Set(report.routes.foundation.courseIds);
  for (const preset of x.GUIDE_PRESETS) {
    const result = x.expandGuidePreset(preset.key, completedIds, courses, activeCourse, []);
    assert.strictEqual(result.ok, true, `${preset.key}: ${result.detail || 'failed'}`);
    assert.deepStrictEqual(result.courseIds, report.routes[preset.key].courseIds);
    assert.strictEqual(result.courseIds.length, counts[preset.key]);
    assert.deepStrictEqual(x.validateQueue(result.courseIds, new Set(), courses), []);
    if (preset.key !== 'foundation') {
      for (const id of foundationIds) assert.ok(result.courseIds.includes(id), `${preset.key} omitted foundation ${id}`);
    }
  }
});

test('completed, active, queued, and duplicate prerequisite work is omitted', () => {
  const { x, courses } = setupFresh();
  const bio1340 = byCode(courses, 'BIO1340');
  const bio2127 = byCode(courses, 'BIO2127');
  courses.set(bio1340.id, { ...bio1340, status: 'completed' });
  courses.set(bio2127.id, { ...bio2127, status: 'inProgress' });
  const result = x.expandGuidePreset(
    'fighting', new Set([bio1340.id]), courses,
    { id: bio2127.id, completedAt: 2000000000 }, [bio1340.id]
  );
  assert.strictEqual(result.ok, true);
  assert.ok(!result.courseIds.includes(bio1340.id));
  assert.ok(!result.courseIds.includes(bio2127.id));
  assert.strictEqual(new Set(result.courseIds).size, result.courseIds.length);
});

test('Start Here followed by Fighting equals Fighting once without mutating inputs', () => {
  const { x, courses, completedIds } = setupFresh();
  const queue = [];
  const before = [...courses.entries()].map(([id, course]) => [id, { ...course }]);
  const start = x.expandGuidePreset('foundation', completedIds, courses, null, queue);
  const follow = x.expandGuidePreset('fighting', completedIds, courses, null, start.courseIds);
  const direct = x.expandGuidePreset('fighting', completedIds, courses, null, queue);
  assert.deepStrictEqual(start.courseIds.concat(follow.courseIds), direct.courseIds);
  assert.deepStrictEqual(queue, []);
  assert.deepStrictEqual([...courses.entries()], before);
});

test('unknown and missing preset targets fail without returning a partial route', () => {
  const { x, courses, completedIds } = setupFresh();
  const unknown = x.expandGuidePreset('missing', completedIds, courses, null, []);
  assert.deepStrictEqual(unknown.ok, false);
  assert.strictEqual(unknown.reason, 'unknown-preset');

  const spt = byCode(courses, 'SPT3510');
  courses.delete(spt.id);
  const missing = x.expandGuidePreset('fighting', completedIds, courses, null, []);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'missing-course');
  assert.match(missing.detail, /SPT3510/);
  assert.ok(!Object.prototype.hasOwnProperty.call(missing, 'courseIds'));
});

test('an unavailable in-progress prerequisite fails instead of returning an unfollowable route', () => {
  const { x, courses, completedIds } = setupFresh();
  const bio1340 = byCode(courses, 'BIO1340');
  courses.set(bio1340.id, { ...bio1340, status: 'inProgress' });
  const result = x.expandGuidePreset('foundation', completedIds, courses, null, []);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unfollowable-preset');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'courseIds'));
});
