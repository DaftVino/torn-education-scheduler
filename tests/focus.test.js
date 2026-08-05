'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

function load() {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  return { x, data };
}

test('every taxonomy row names a course that exists in the catalogue', () => {
  const { x, data } = load();
  for (const row of x.FOCUS_TAXONOMY) {
    assert.ok(data.courses.has(row.courseId),
      `taxonomy names course ${row.courseId} which is not in the catalogue`);
  }
});

test('a registry built from the live catalogue reports no staleness', () => {
  const { x, data } = load();
  const reg = x.focusRegistry(data.courses);
  assert.strictEqual(reg.stale, 0);
  assert.strictEqual(reg.unmapped, 0);
  assert.strictEqual(reg.entries.length, x.FOCUS_TAXONOMY.length);
});

test('an outcome string that no longer matches drops its entry and is counted', () => {
  const { x, data } = load();
  const row = x.FOCUS_TAXONOMY[0];
  const courses = new Map(data.courses);
  const course = Object.assign({}, courses.get(row.courseId));
  course.learningOutcomes = ['Gain something else entirely'];
  courses.set(row.courseId, course);

  const reg = x.focusRegistry(courses);
  assert.ok(reg.stale >= 1, 'a changed outcome string must be counted as stale');
  assert.ok(!reg.entries.some((e) => e.courseId === row.courseId && e.outcome === row.outcome),
    'a stale entry must not survive into the registry');
});

test('a course absent from the payload drops its entries rather than throwing', () => {
  const { x, data } = load();
  const row = x.FOCUS_TAXONOMY[0];
  const courses = new Map(data.courses);
  courses.delete(row.courseId);
  const reg = x.focusRegistry(courses);
  assert.ok(reg.stale >= 1);
});

test('the 31 courses with no learningOutcomes are excluded, not counted as unmapped', () => {
  const { x, data } = load();
  let none = 0;
  for (const c of data.courses.values()) {
    if (!c.learningOutcomes || c.learningOutcomes.length === 0) none += 1;
  }
  assert.strictEqual(none, 31, 'fixture shape changed; re-measure before editing this');
  assert.strictEqual(x.focusRegistry(data.courses).unmapped, 0);
});

test('a payload outcome the taxonomy does not know is counted as unmapped', () => {
  const { x, data } = load();
  const courses = new Map(data.courses);
  const target = [...courses.values()].find((c) => !c.learningOutcomes || !c.learningOutcomes.length);
  courses.set(target.id, Object.assign({}, target, {
    learningOutcomes: ['Gain a 99% bonus to something nobody classified'],
  }));
  assert.strictEqual(x.focusRegistry(courses).unmapped, 1);
});

test('focusRegistry never throws on a hostile catalogue', () => {
  const { x } = load();
  assert.doesNotThrow(() => x.focusRegistry(new Map()));
  assert.doesNotThrow(() => x.focusRegistry(null));
});

test('every working-stat line in the catalogue parses', () => {
  const { x, data } = load();
  let lines = 0;
  for (const c of data.courses.values()) {
    const gains = Array.isArray(c.workingStatsGain) ? c.workingStatsGain : [];
    lines += gains.length;
    assert.strictEqual(x.workingStatsFor(c).size > 0, gains.length > 0);
  }
  assert.strictEqual(lines, 294, 'fixture shape changed; re-measure before editing this');
});

test('catalogue working-stat totals match the measured figures', () => {
  const { x, data } = load();
  const totals = new Map();
  for (const c of data.courses.values()) {
    for (const [stat, n] of x.workingStatsFor(c)) {
      totals.set(stat, (totals.get(stat) || 0) + n);
    }
  }
  assert.strictEqual(totals.get('intelligence'), 8560);
  assert.strictEqual(totals.get('endurance'), 3695);
  assert.strictEqual(totals.get('manual labor'), 3015);
});

test('a malformed working-stat line is dropped, not coerced', () => {
  const { x } = load();
  const got = x.workingStatsFor({ workingStatsGain: ['Gain lots of intelligence', 'Gain 5 endurance upon completion'] });
  assert.strictEqual(got.size, 1);
  assert.strictEqual(got.get('endurance'), 5);
});

test('workingStatsFor never throws on a malformed course', () => {
  const { x } = load();
  assert.doesNotThrow(() => x.workingStatsFor(null));
  assert.doesNotThrow(() => x.workingStatsFor({ workingStatsGain: 'not an array' }));
});
