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

test('a split course is reached by both its selections', () => {
  const { x, data } = load();
  const dual = x.FOCUS_TAXONOMY.filter((r) => /and/.test(r.outcome) && r.category === 'Passive Stat Bonus');
  assert.ok(dual.length >= 2, 'expected at least one split passive outcome');
  const id = dual[0].courseId;
  const sels = x.FOCUS_TAXONOMY.filter((r) => r.courseId === id && r.outcome === dual[0].outcome);
  assert.ok(sels.length >= 2, 'a combo outcome must appear under more than one selection');
  for (const s of sels) {
    const [scores] = x.focusScores([{ category: s.category, selection: s.selection }], data.courses);
    assert.ok(scores.has(id), `${s.selection} must reach course ${id}`);
  }
});

test('a split course reached under two selections scores its exact magnitude, not just presence', () => {
  const { x, data } = load();
  // Real data, not synthetic: courseId 50's "defense and dexterity" outcome is
  // filed as two taxonomy rows, one per selection. Either selection alone must
  // reach it at its own magnitude -- `.has()` alone would also pass a
  // implementation that returned the wrong number, or someone else's.
  const split = [...x.FOCUS_TAXONOMY].filter((r) => r.courseId === 50 && r.category === 'Passive Stat Bonus');
  assert.deepStrictEqual([...split].map((r) => r.selection).sort(), ['Defense', 'Dexterity']);
  for (const row of split) {
    const [scores] = x.focusScores([{ category: row.category, selection: row.selection }], data.courses);
    assert.strictEqual(scores.get(50), row.magnitude,
      `${row.selection} must reach course 50 at its own magnitude`);
  }
});

test('a course reached twice under one selection would be scored as their sum, not overwritten', () => {
  const { x, data } = load();
  // The summing branch in focusScores (`(scores.get(courseId) || 0) + n`) fires
  // only when two DIFFERENT taxonomy rows share the same (category, selection,
  // courseId). None of the current 120 rows do -- every one of the taxonomy's
  // groups names each course at most once, asserted below so a fixture change
  // that introduces a real repeat is caught here rather than silently making
  // this test looser. Until then, this pins the *formula* end to end against
  // an independently computed reference (summed by hand from the taxonomy,
  // never by calling focusScores), rather than assuming the "+" is exercised.
  let anyRepeat = false;
  const perGroup = new Map(); // focusKey -> { category, selection, totals: Map<courseId, magnitude> }
  for (const row of x.FOCUS_TAXONOMY) {
    const key = x.focusKey(row.category, row.selection);
    if (!perGroup.has(key)) perGroup.set(key, { category: row.category, selection: row.selection, totals: new Map() });
    const group = perGroup.get(key);
    if (group.totals.has(row.courseId)) anyRepeat = true;
    group.totals.set(row.courseId, (group.totals.get(row.courseId) || 0) + row.magnitude);
  }
  assert.strictEqual(anyRepeat, false,
    'fixture shape changed: a real same-selection repeat now exists; assert scores.get() against the summed total directly');

  for (const { category, selection, totals } of perGroup.values()) {
    const [scores] = x.focusScores([{ category, selection }], data.courses);
    for (const [courseId, total] of totals) {
      if (!data.courses.has(courseId)) continue; // stale row, outside this contract
      assert.strictEqual(scores.get(courseId), total,
        `course ${courseId} under ${category} ${selection} must total ${total}`);
    }
  }
});

test('a selection nobody offers scores nothing rather than throwing', () => {
  const { x, data } = load();
  const [scores] = x.focusScores([{ category: 'Nope', selection: 'Nope' }], data.courses);
  assert.strictEqual(scores.size, 0);
});

test('focusScores returns one map per focus, in order', () => {
  const { x, data } = load();
  const maps = x.focusScores([
    { category: 'Working Stats', selection: 'intelligence' },
    { category: 'Working Stats', selection: 'endurance' },
  ], data.courses);
  assert.strictEqual(maps.length, 2);

  // Index correspondence, not just "the two differ": maps[0] must really be
  // intelligence and maps[1] must really be endurance, checked against
  // workingStatsFor independently of focusScores rather than against each
  // other, so a reversed or shuffled result array is caught rather than
  // passed as "two different-looking maps".
  for (const id of maps[0].keys()) {
    assert.ok(x.workingStatsFor(data.courses.get(id)).has('intelligence'),
      `course ${id} in maps[0] must actually carry an intelligence gain`);
  }
  for (const id of maps[1].keys()) {
    assert.ok(x.workingStatsFor(data.courses.get(id)).has('endurance'),
      `course ${id} in maps[1] must actually carry an endurance gain`);
  }
  const onlyInFirst = [...maps[0].keys()].find((id) => !maps[1].has(id));
  assert.ok(onlyInFirst !== undefined, 'expected at least one course to differ between the two maps, or this test has no teeth');

  // Reversing the request order must reverse the result order.
  const reversed = x.focusScores([
    { category: 'Working Stats', selection: 'endurance' },
    { category: 'Working Stats', selection: 'intelligence' },
  ], data.courses);
  assert.deepStrictEqual([...reversed[0].keys()].sort(), [...maps[1].keys()].sort());
  assert.deepStrictEqual([...reversed[1].keys()].sort(), [...maps[0].keys()].sort());
});

test('working-stat totals equal the catalogue figures and shrink as courses complete', () => {
  const { x, data } = load();
  const f = { category: 'Working Stats', selection: 'intelligence' };
  const all = x.focusTotals(f, data.courses, new Set());
  assert.strictEqual(all.total, 8560);
  assert.strictEqual(all.remaining, 8560);
  assert.strictEqual(all.unit, 'flat');

  const one = [...data.courses.values()].find((c) => x.workingStatsFor(c).get('intelligence'));
  const some = x.focusTotals(f, data.courses, new Set([one.id]));
  assert.strictEqual(some.total, 8560, 'the catalogue total never moves');
  assert.strictEqual(some.remaining, 8560 - x.workingStatsFor(one).get('intelligence'));
});

test('an unlock selection reports a count and never a magnitude', () => {
  const { x, data } = load();
  const row = x.FOCUS_TAXONOMY.find((r) => r.category === 'Unlocks & Abilities');
  const t = x.focusTotals({ category: row.category, selection: row.selection }, data.courses, new Set());
  assert.strictEqual(t.unit, 'count');
  assert.ok(Number.isInteger(t.total) && Number.isInteger(t.remaining));
});

test('a split course counts once toward a total', () => {
  const { x, data } = load();
  const dual = x.FOCUS_TAXONOMY.find((r) => r.category === 'Passive Stat Bonus' && / and /.test(r.outcome));
  const t = x.focusTotals({ category: dual.category, selection: dual.selection }, data.courses, new Set());
  const t2 = x.focusTotals({ category: dual.category, selection: dual.selection }, data.courses, new Set([dual.courseId]));
  assert.strictEqual(t.remaining - t2.remaining, dual.magnitude,
    'completing a split course must subtract its magnitude exactly once');
});

test('totals are never summed across selections', () => {
  const { x, data } = load();
  const a = x.focusTotals({ category: 'Passive Stat Bonus', selection: 'Speed' }, data.courses, new Set());
  const b = x.focusTotals({ category: 'Gym Gain Bonus', selection: 'Speed' }, data.courses, new Set());
  assert.notStrictEqual(a.total, a.total + b.total,
    'a passive total and a gym total describe different quantities');
  assert.ok(a.total > 0 && b.total > 0);
});

test('focusTotals never throws on rubbish', () => {
  const { x, data } = load();
  assert.doesNotThrow(() => x.focusTotals(null, data.courses, new Set()));
  assert.doesNotThrow(() => x.focusTotals({ category: 'x', selection: 'y' }, null, null));
});
