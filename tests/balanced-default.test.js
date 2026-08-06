'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { loadUserscript, loadFixture } = require('./load-userscript');
const { makeFakeDocument } = require('./fake-document');

const NOW = 1767225600;

function load() {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  return { x, data };
}

function course(id, options) {
  const o = options || {};
  return {
    id, prefix: `SYN${id}`, name: `Synthetic ${id}`,
    tier: 1, categoryId: 1, parentId: null,
    duration: o.duration || 86400, status: 'available',
    learningOutcomes: o.learningOutcomes || [],
    workingStatsGain: o.workingStatsGain || [],
  };
}

function model(x, data, queue, settings, view) {
  return x.buildPanelModel({
    fetchResult: { ok: true, data },
    plan: { queue, collapsed: false },
    now: NOW,
    view: view || 'schedule',
    settings,
  });
}

function descendants(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.shift();
    out.push(current);
    stack.unshift(...(current.children || []));
  }
  return out;
}

function handlers() {
  return {
    onToggle() {}, onAdd() {}, onRemove() {}, onAddAll() {},
    onPickerChange() {}, onViewChange() {}, onSettingChange() {},
    onToggleDebugReport() {}, onCopyDebugReport() {}, onImportPlan() {},
    onFocusToggle() {}, onFocusPriority() {}, onFocusSectionToggle() {},
    onFocusCompletedToggle() {}, onFocusRankToggle() {},
    onResetArm() {}, onResetConfirm() {},
  };
}

function renderedQueueIds(panel) {
  return descendants(panel)
    .filter((el) => el.className === 'tes-queue-row')
    .map((row) => (row.children || []).find((child) => child.dataset && child.dataset.courseId !== undefined))
    .map((remove) => Number(remove.dataset.courseId));
}

function rowFor(x, id, category, selection) {
  const row = x.FOCUS_TAXONOMY.find((entry) => entry.courseId === id
    && entry.category === category && entry.selection === selection);
  assert.ok(row, `missing taxonomy row for ${id} ${category} / ${selection}`);
  return row;
}

test('rendered fresh-install focus order differs: DEF1700 moves from 108th to 2nd', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const balanced = model(x, data, queue, { orderMode: 'focus', focuses: [] });
  const asListed = model(x, data, queue, { orderMode: 'as-listed', focuses: [] });
  const balancedDoc = makeFakeDocument();
  const listedDoc = makeFakeDocument();
  const balancedIds = renderedQueueIds(x.renderPanel(balancedDoc, balancedDoc.body, balanced, handlers()));
  const listedIds = renderedQueueIds(x.renderPanel(listedDoc, listedDoc.body, asListed, handlers()));

  assert.notDeepStrictEqual(balancedIds, listedIds, 'the rendered queue silently fell back to as-listed');
  assert.strictEqual(data.courses.get(70).prefix, 'DEF1700');
  assert.strictEqual(listedIds.indexOf(70), 107, 'fixture changed: re-measure the named baseline move');
  assert.strictEqual(balancedIds.indexOf(70), 1, 'the named course did not reach the rendered second row');
  // Prerequisite readiness still wins over any score — that is orderQueue's
  // contract, and a scoring feature does not get to override it. Asserted as
  // the invariant over the whole queue rather than on one named course: on
  // this fixture every Sports Science course is already complete, so the
  // obvious named example is not in the queue at all and an indexOf-based
  // check would compare -1 against -1 and pass while proving nothing.
  const position = new Map(balancedIds.map((id, i) => [id, i]));
  for (const id of balancedIds) {
    const parentId = data.courses.get(id).parentId;
    if (parentId === null || !position.has(parentId)) continue;
    assert.ok(position.get(parentId) < position.get(id),
      `${data.courses.get(id).prefix} was placed ahead of its prerequisite ${data.courses.get(parentId).prefix}`);
  }
});

test('grouping puts independent gain multipliers before quantified benefits before unlocks', () => {
  const { x } = load();
  const gain = rowFor(x, 44, 'Gym Gain Bonus', 'Strength');
  const quantified = rowFor(x, 77, 'Combat Bonuses', 'Unarmed Damage');
  const unlock = rowFor(x, 126, 'Unlocks & Abilities', 'Sports Shop Access');
  // Equal-duration, mutually independent courses isolate scoring from the
  // prerequisite rule that intentionally wins in the real Kahn output.
  const courses = new Map([
    [44, course(44, { learningOutcomes: [gain.outcome] })],
    [77, course(77, { learningOutcomes: [quantified.outcome] })],
    [126, course(126, { learningOutcomes: [unlock.outcome] })],
  ]);
  const [groups] = x.balancedScores(courses, new Set(), 'per-day');
  assert.ok(groups.get(44) > groups.get(77), 'the gain multiplier is not in an earlier group');
  assert.ok(groups.get(77) > groups.get(126), 'the unlock is not in the last group');
  // Asserted through orderQueue, not only on the maps: the group is the first
  // element of a lexicographic vector, and 'total' is what the caller must use
  // because balancedScores has already applied the basis itself.
  assert.deepStrictEqual(
    x.orderQueue([126, 77, 44], 'focus', courses, x.balancedScores(courses, new Set(), 'per-day'), 'total'),
    [44, 77, 126],
  );
});

// The defect this exists to catch, and it is not hypothetical — the first
// implementation of this feature had it, and every score-level assertion in
// this file passed while it did.
//
// That version returned ONE number per course: a large per-group offset plus
// the normalised score. orderQueue then divided the whole thing by duration,
// offset included. Across the real catalogue the offset term spanned 238,095
// down to 34,014 while the score spanned 0.3, so the score was one part in a
// million of the signal and the feature was shortest-first in disguise.
//
// So this asserts the thing that actually failed: within one group, a longer
// course with a far better score must still win. Under the offset version the
// shorter course wins, whatever its score.
test('within a group the score decides, not the duration', () => {
  const { x } = load();
  const courses = new Map([
    // Short and nearly worthless.
    [900, course(900, { duration: 86400, workingStatsGain: ['Gain 1 intelligence upon completion'] })],
    // Three times as long, a thousand times the gain.
    [901, course(901, { duration: 3 * 86400, workingStatsGain: ['Gain 1,000 intelligence upon completion'] })],
  ]);
  const [groups, scores] = x.balancedScores(courses, new Set(), 'per-day');
  assert.strictEqual(groups.get(900), groups.get(901), 'the two courses are not in the same group');

  // Independent oracle, from the stated rule rather than the implementation:
  // the type maximum is 1000, so the normalised scores are 0.001 and 1, and
  // per day that is 0.001/1 against 1/3.
  assert.strictEqual(scores.get(900), 0.001 / 1);
  assert.strictEqual(scores.get(901), 1 / 3);

  assert.deepStrictEqual(
    x.orderQueue([900, 901], 'focus', courses, x.balancedScores(courses, new Set(), 'per-day'), 'total'),
    [901, 900],
    'the shorter course won on duration alone — the score is not reaching the comparator',
  );
});

// The basis toggle has to reach the balanced default too, or the Focus view's
// button silently does nothing while no focus is selected.
test('the sorting basis changes the balanced order', () => {
  const { x } = load();
  const courses = new Map([
    [900, course(900, { duration: 86400, workingStatsGain: ['Gain 500 intelligence upon completion'] })],
    [901, course(901, { duration: 10 * 86400, workingStatsGain: ['Gain 1,000 intelligence upon completion'] })],
  ]);
  const perDay = x.orderQueue([900, 901], 'focus', courses, x.balancedScores(courses, new Set(), 'per-day'), 'total');
  const total = x.orderQueue([900, 901], 'focus', courses, x.balancedScores(courses, new Set(), 'total'), 'total');
  // 500 in one day beats 1000 in ten; the bigger single total is the other way.
  assert.deepStrictEqual(perDay, [900, 901]);
  assert.deepStrictEqual(total, [901, 900]);
});

test('education working-stat rewards is a gain multiplier but passive defense is not', () => {
  const { x } = load();
  const education = rowFor(x, 121, 'General Progression Bonuses', 'Education Working Stat Rewards');
  const passive = rowFor(x, 74, 'Passive Stat Bonus', 'Defense');
  const unlock = rowFor(x, 126, 'Unlocks & Abilities', 'Sports Shop Access');
  const courses = new Map([
    [121, course(121, { learningOutcomes: [education.outcome] })],
    [74, course(74, { learningOutcomes: [passive.outcome] })],
    [126, course(126, { learningOutcomes: [unlock.outcome] })],
    [900, course(900, { status: 'completed', workingStatsGain: ['Gain 1,000 intelligence upon completion'] })],
  ]);
  courses.get(900).status = 'completed';
  const [groups] = x.balancedScores(courses, new Set([900]), 'per-day');
  assert.ok(groups.get(121) > groups.get(74), 'the future-gain multiplier did not reach group 0');
  assert.ok(groups.get(74) > groups.get(126), 'the passive bonus was wrongly treated as group 0 or unscored');
});

test('per-type normalisation beats a larger raw number without inventing an exchange rate', () => {
  const { x } = load();
  const unarmed = rowFor(x, 77, 'Combat Bonuses', 'Unarmed Damage');
  const artillery = rowFor(x, 86, 'Combat Bonuses', 'Heavy Artillery Accuracy');
  const courses = new Map([
    // Raw sum 100.
    [77, course(77, { learningOutcomes: [unarmed.outcome] })],
    // Raw sum 51, but two independently-maximal types.
    [86, course(86, {
      learningOutcomes: [artillery.outcome],
      workingStatsGain: ['Gain 50 manual labor upon completion'],
    })],
  ]);
  // 'total', so the equal durations cannot mask the arithmetic being asserted.
  const [, scores] = x.balancedScores(courses, new Set(), 'total');
  // Independent oracle: 77 = 100/100 = 1. 86 = 1/1 + 50/50 = 2.
  assert.strictEqual(scores.get(86) - scores.get(77), 1);
  assert.ok(scores.get(86) > scores.get(77), 'raw magnitude 100 dominated two normalised benefit types');
});

test('an unlock-only course ranks behind every scored course', () => {
  const { x } = load();
  const unlock = rowFor(x, 126, 'Unlocks & Abilities', 'Sports Shop Access');
  const courses = new Map([
    [126, course(126, { learningOutcomes: [unlock.outcome] })],
    [900, course(900, { workingStatsGain: ['Gain 1 intelligence upon completion'] })],
    [901, course(901, { workingStatsGain: ['Gain 1 endurance upon completion'] })],
    [902, course(902, { workingStatsGain: ['Gain 1 manual labor upon completion'] })],
  ]);
  const [groups] = x.balancedScores(courses, new Set(), 'per-day');
  for (const id of [900, 901, 902]) {
    assert.ok(groups.get(id) > groups.get(126), `scored course ${id} fell behind the unlock`);
  }
});

test('selecting any focus uses the selected-focus ranking, not the balanced default', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const focus = { category: 'Working Stats', selection: 'manual labor' };
  const got = model(x, data, queue, { orderMode: 'focus', focuses: [focus] });
  const expected = x.orderQueue(queue, 'focus', data.courses, x.focusScores([focus], data.courses), 'per-day');
  const balanced = x.orderQueue(queue, 'focus', data.courses,
    x.balancedScores(data.courses, data.completedIds, 'per-day'), 'total');
  assert.deepStrictEqual(got.queue.map((item) => item.courseId), expected);
  assert.notDeepStrictEqual(expected, balanced, 'fixture no longer distinguishes selected and balanced ranking');
});

test('the three non-focus Queue orders retain their complete fixture orders', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const hashes = {
    'as-listed': '4526593be2ba0a390110ffab9068ca3a849acc426275150adc0668d19b4253c1',
    'shortest-first': '7ae70a3afc50d31f4180ffeb4edc48d0cfbbd39b2efc3cbfc416db66a2f45cde',
    'unlocks-first': '075e1fbedfa946ec4285bfaa57f0665e6483e66da8245f3336abf97ba1686cdb',
  };
  for (const [modeName, expected] of Object.entries(hashes)) {
    const ids = model(x, data, queue, { orderMode: modeName, focuses: [] }).queue.map((item) => item.courseId);
    const actual = crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
    assert.strictEqual(actual, expected, `${modeName} changed its full 115-course order`);
  }
});

test('finish date and total remain byte-identical across every ordering path', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const cases = [
    { orderMode: 'as-listed', focuses: [] },
    { orderMode: 'shortest-first', focuses: [] },
    { orderMode: 'unlocks-first', focuses: [] },
    { orderMode: 'focus', focuses: [] },
    { orderMode: 'focus', focuses: [{ category: 'Working Stats', selection: 'manual labor' }] },
  ];
  const bytes = cases.map((settings) => {
    const got = model(x, data, queue, settings);
    return JSON.stringify({ finishLabel: got.finishLabel, totalLabel: got.totalLabel });
  });
  for (const value of bytes.slice(1)) assert.strictEqual(value, bytes[0]);
});

test('the balanced-default Focus note appears only when no focus is selected', () => {
  const { x, data } = load();
  const renderText = (focuses) => {
    const doc = makeFakeDocument();
    const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
    const panel = x.renderPanel(doc, doc.body,
      model(x, data, queue, { orderMode: 'focus', focuses }, 'focus'), handlers());
    return descendants(panel).map((el) => el.textContent).join(' ');
  };
  const empty = renderText([]);
  const chosen = renderText([{ category: 'Working Stats', selection: 'intelligence' }]);
  assert.match(empty, /balanced default: gain multipliers first/);
  assert.match(empty, /starting point, not a claim about what is optimal for you/);
  assert.doesNotMatch(chosen, /balanced default: gain multipliers first/);
});
