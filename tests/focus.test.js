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

test('an unlock course scores one rather than a zero-valued map entry', () => {
  const { x, data } = load();
  const row = x.FOCUS_TAXONOMY.find((r) => r.category === 'Unlocks & Abilities' && r.selection === 'Sports Shop Access');
  assert.ok(row, 'Sports Shop Access must remain a real unlock taxonomy selection');
  const [scores] = x.focusScores([{ category: row.category, selection: row.selection }], data.courses);
  assert.strictEqual(scores.get(row.courseId), 1);
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
    const value = (row.unit === 'none' || !Number.isFinite(row.magnitude)) ? 1 : row.magnitude;
    group.totals.set(row.courseId, (group.totals.get(row.courseId) || 0) + value);
  }
  assert.strictEqual(anyRepeat, false,
    'fixture shape changed: a real same-selection repeat now exists; assert scores.get() against the summed total directly');

  for (const { category, selection, totals } of perGroup.values()) {
    const [scores] = x.focusScores([{ category, selection }], data.courses);
    for (const [courseId, total] of totals) {
      if (!data.courses.has(courseId)) continue; // stale row, outside this contract
      let expected = total;
      for (const [downstreamId, downstreamScore] of totals) {
        if (x.upstreamOf(downstreamId, data.courses, new Map()).has(courseId)) {
          expected = Math.max(expected, downstreamScore);
        }
      }
      assert.strictEqual(scores.get(courseId), expected,
        `course ${courseId} under ${category} ${selection} must keep its summed score or its largest routed descendant score`);
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

  // A map also carries inherited routing scores for prerequisites. A tier-3
  // target has no descendants, though, so it still pins each map's direct
  // selection and result-array correspondence exactly.
  const intelligenceTarget = [...data.courses.values()].find((c) => c.tier === 3 && x.workingStatsFor(c).get('intelligence'));
  const enduranceTarget = [...data.courses.values()].find((c) => c.tier === 3 && x.workingStatsFor(c).get('endurance'));
  assert.ok(intelligenceTarget && enduranceTarget, 'need terminal targets for both stats');
  assert.strictEqual(maps[0].get(intelligenceTarget.id), x.workingStatsFor(intelligenceTarget).get('intelligence'));
  assert.strictEqual(maps[1].get(enduranceTarget.id), x.workingStatsFor(enduranceTarget).get('endurance'));
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
  // Every Unlocks & Abilities row carries magnitude: null, so a regression
  // that totals magnitude instead of forcing 1 per course would still total
  // an integer (0) for a single-course selection -- picking one that spans
  // more than one course is what makes the wrong number visibly wrong.
  const grouped = new Map();
  for (const r of x.FOCUS_TAXONOMY) {
    if (r.category !== 'Unlocks & Abilities') continue;
    if (!grouped.has(r.selection)) grouped.set(r.selection, new Set());
    grouped.get(r.selection).add(r.courseId);
  }
  const multi = [...grouped.entries()].find(([, ids]) => ids.size > 1);
  assert.ok(multi, 'expected at least one Unlocks & Abilities selection spanning more than one course, or this test has no teeth');
  const [selection, courseIds] = multi;

  const t = x.focusTotals({ category: 'Unlocks & Abilities', selection }, data.courses, new Set());
  assert.strictEqual(t.unit, 'count');
  assert.strictEqual(t.total, courseIds.size,
    'total must equal the distinct-course count, not a summed magnitude (null on every row here)');
  assert.strictEqual(t.remaining, courseIds.size);
});

test("completing a course subtracts its own selection's magnitude, not the whole split outcome", () => {
  const { x, data } = load();
  // Not a dedupe test: this course's outcome splits across two selections
  // ("... to speed and strength" is two taxonomy rows sharing one courseId),
  // but each (category, selection) pair still names the course exactly once,
  // so this exercises magnitude subtraction, not focusTotals' by-course
  // dedupe -- see the coverage test below for why that branch has no real
  // data to exercise it at all.
  const dual = x.FOCUS_TAXONOMY.find((r) => r.category === 'Passive Stat Bonus' && / and /.test(r.outcome));
  const t = x.focusTotals({ category: dual.category, selection: dual.selection }, data.courses, new Set());
  const t2 = x.focusTotals({ category: dual.category, selection: dual.selection }, data.courses, new Set([dual.courseId]));
  assert.strictEqual(t.remaining - t2.remaining, dual.magnitude,
    'completing the course must subtract its magnitude exactly once from remaining');
});

test('focusTotals sums an independently-computed reference for every real selection, and no duplicate triple exists yet to exercise its by-course dedupe', () => {
  const { x, data } = load();

  // FOCUS_TAXONOMY is frozen and not injectable through focusTotals' public
  // signature (courses/completedIds are the only parameters besides focus),
  // so a test cannot manufacture a duplicate (category, selection, courseId)
  // triple the way it can manufacture a duplicate completed course id.
  // Confirmed across the whole taxonomy: none exists today, so focusTotals'
  // by-course summing step is never exercised with more than one row per
  // course, by any test -- including this one. The summing code is kept as
  // defensive for future taxonomy growth, the same call made for
  // focusScores' identical gap in Task 3. This assertion is the canary: the
  // day a real duplicate triple is added to the taxonomy, it fails and says
  // the dedupe branch finally has real data to write a direct test against.
  const seen = new Set();
  const dupes = [];
  for (const row of x.FOCUS_TAXONOMY) {
    const key = `${row.category} ${row.selection} ${row.courseId}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  assert.deepStrictEqual(dupes, [],
    'a real duplicate triple now exists in the taxonomy -- write a test asserting focusTotals sums it rather than double-counting or overwriting it');

  // Independently-computed reference: sum magnitudes by course id, by hand,
  // for every real (category, selection) group, and check focusTotals agrees.
  // This is also what makes "totals are never summed across selections"
  // meaningful rather than tautological: the passive-strength and gym-gain
  // reference figures for the same stat name are computed and asserted
  // separately below, so a future implementation that merged them would fail
  // this even though `a.total !== a.total + b.total` cannot.
  const groups = new Map();
  for (const row of x.FOCUS_TAXONOMY) {
    const k = x.focusKey(row.category, row.selection);
    if (!groups.has(k)) groups.set(k, { category: row.category, selection: row.selection, byCourse: new Map() });
    const g = groups.get(k);
    const value = (row.unit === 'none' || !Number.isFinite(row.magnitude)) ? 1 : row.magnitude;
    g.byCourse.set(row.courseId, (g.byCourse.get(row.courseId) || 0) + value);
  }
  let checked = 0;
  for (const { category, selection, byCourse } of groups.values()) {
    const t = x.focusTotals({ category, selection }, data.courses, new Set());
    let reference = 0;
    for (const v of byCourse.values()) reference += (t.unit === 'count') ? 1 : v;
    assert.strictEqual(t.total, reference, `${category} / ${selection} total must match its independently summed reference`);
    checked++;
  }
  assert.ok(checked > 0, 'expected at least one magnitude-bearing selection to check, or this test has no teeth');
});

test('totals are never summed across selections', () => {
  const { x, data } = load();
  // The passive-strength and gym-gain totals for the same stat name are
  // independently correct, not merely different: `a.total !== a.total +
  // b.total` is true for any nonzero b.total regardless of what the
  // implementation does, so each figure is checked against its own reference
  // computed straight from the taxonomy rather than against the other.
  function referenceTotal(category, selection) {
    const byCourse = new Map();
    for (const row of x.FOCUS_TAXONOMY) {
      if (row.category !== category || row.selection !== selection) continue;
      const value = (row.unit === 'none' || !Number.isFinite(row.magnitude)) ? 1 : row.magnitude;
      byCourse.set(row.courseId, (byCourse.get(row.courseId) || 0) + value);
    }
    let total = 0;
    for (const v of byCourse.values()) total += v;
    return total;
  }

  const a = x.focusTotals({ category: 'Passive Stat Bonus', selection: 'Speed' }, data.courses, new Set());
  const b = x.focusTotals({ category: 'Gym Gain Bonus', selection: 'Speed' }, data.courses, new Set());
  assert.strictEqual(a.total, referenceTotal('Passive Stat Bonus', 'Speed'),
    'the passive-strength total must match its own catalogue figure, not a merge with gym gain');
  assert.strictEqual(b.total, referenceTotal('Gym Gain Bonus', 'Speed'),
    'the gym-gain total must match its own catalogue figure, not a merge with passive strength');
  assert.notStrictEqual(a.total, b.total,
    'the two reference figures must actually differ, or this test cannot tell a merge from a coincidence');
});

test('focusTotals never throws on rubbish', () => {
  const { x, data } = load();
  assert.doesNotThrow(() => x.focusTotals(null, data.courses, new Set()));
  assert.doesNotThrow(() => x.focusTotals({ category: 'x', selection: 'y' }, null, null));
});

test('rig overclocking limit is unstatable: its rows are successive caps, not additive bonuses', () => {
  const { x, data } = load();
  // Course 128 unlocks overclocking up to 30%, course 129 up to 50%. Summed as
  // if additive that is 80%, a ceiling nobody actually reaches -- the real
  // limit is whichever course was completed last. FOCUS_UNSTATABLE exists so
  // focusTotals falls back to a count instead of printing that invented sum.
  const t = x.focusTotals(
    { category: 'Computing Bonuses', selection: 'Rig Overclocking Limit' },
    data.courses,
    new Set(),
  );
  assert.strictEqual(t.statable, false, 'rig overclocking limit must not be reported as statable');
  assert.strictEqual(t.unit, 'count', 'an unstatable selection must fall back to a count, never a percent');
});

test('every taxonomy selection phrased as a successive limit ("up to N%") is in FOCUS_UNSTATABLE', () => {
  const { x } = load();
  // Generalises the guard above: rather than pinning one selection name, scan
  // every taxonomy row's outcome text for Torn's own "up to N%" phrasing --
  // the wording that marks a value as a ceiling, not an additive bonus -- and
  // require every selection that uses it to be in FOCUS_UNSTATABLE. Catches
  // the next one Torn adds, not just the one already found.
  const upToPattern = /\bup to \d+%/i;
  const offenders = new Set();
  for (const row of x.FOCUS_TAXONOMY) {
    if (upToPattern.test(row.outcome) && x.FOCUS_UNSTATABLE.indexOf(row.selection) === -1) {
      offenders.add(row.selection);
    }
  }
  assert.deepStrictEqual([...offenders], [],
    'selection(s) phrased as a successive limit are missing from FOCUS_UNSTATABLE');

  // And the test has teeth: today's taxonomy really does contain at least one
  // "up to N%" row, so the pattern above is not vacuously passing.
  const anyUpTo = x.FOCUS_TAXONOMY.some((row) => upToPattern.test(row.outcome));
  assert.ok(anyUpTo, 'expected at least one "up to N%" row in the taxonomy, or this test has no teeth');
});
