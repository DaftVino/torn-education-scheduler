'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

function load() {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const all = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  return { x, data, all };
}

// Independent of workingStatsFor: parses the raw payload lines itself.
function rawWorkingStats(data, ids) {
  const out = {};
  for (const id of ids) {
    for (const line of data.courses.get(id).workingStatsGain || []) {
      const m = /^Gain ([\d,]+) (intelligence|endurance|manual labor) upon completion$/.exec(line);
      if (m) out[m[2]] = (out[m[2]] || 0) + Number(m[1].replace(/,/g, ''));
    }
  }
  return out;
}

function gainFor(g, category, selection) {
  const c = g.categories.find((k) => k.category === category);
  return c && c.gains.find((s) => s.selection === selection);
}

test('pathGains counts the whole all-remaining queue and its degrees', () => {
  const { x, data, all } = load();
  const g = x.pathGains(all, data.courses);
  assert.strictEqual(g.courseCount, 115);
  assert.strictEqual(g.degreeCount, 11);
});

test('pathGains working stats match an independent parse, in WORKING_STATS order', () => {
  const { x, data, all } = load();
  const g = x.pathGains(all, data.courses);
  const ref = rawWorkingStats(data, all);
  assert.deepStrictEqual(Array.from(g.workingStats, (w) => w.stat), ['intelligence', 'endurance', 'manual labor']);
  for (const w of g.workingStats) assert.strictEqual(w.amount, ref[w.stat]);
  // Pinned so a fixture change is noticed rather than silently re-baselined.
  assert.deepStrictEqual(ref, { intelligence: 8080, endurance: 3280, 'manual labor': 2535 });
});

test('the same selection name in two categories stays two figures, never summed', () => {
  const { x, data } = load();
  // Strength: Passive Stat Bonus on 106 (1%), 107 (2%), 49 (2%); Gym Gain Bonus on 44 (1%), 51 (1%).
  const g = x.pathGains([106, 107, 49, 44, 51], data.courses);
  assert.deepStrictEqual({ ...gainFor(g, 'Passive Stat Bonus', 'Strength') }, { selection: 'Strength', unit: 'percent', amount: 5 });
  assert.deepStrictEqual({ ...gainFor(g, 'Gym Gain Bonus', 'Strength') }, { selection: 'Strength', unit: 'percent', amount: 2 });
});

test('every unit is pinned to a real taxonomy row', () => {
  const { x, data } = load();
  // flat: course 86, "Gain a +1.00 accuracy increase with Heavy Artillery"
  assert.deepStrictEqual({ ...gainFor(x.pathGains([86], data.courses), 'Combat Bonuses', 'Heavy Artillery Accuracy') },
    { selection: 'Heavy Artillery Accuracy', unit: 'flat', amount: 1 });
  // ordinary unlock (unit "none"): course 20, Amulet Finding
  assert.deepStrictEqual({ ...gainFor(x.pathGains([20], data.courses), 'Unlocks & Abilities', 'Amulet Finding') },
    { selection: 'Amulet Finding', unit: 'count', amount: 1 });
  // unstatable: successive caps on 128 (30%) and 129 (50%) are a course count, never 80
  assert.deepStrictEqual({ ...gainFor(x.pathGains([128, 129], data.courses), 'Computing Bonuses', 'Rig Overclocking Limit') },
    { selection: 'Rig Overclocking Limit', unit: 'count', amount: 2 });
});

test('within a category, units are grouped and never ranked against each other', () => {
  const { x, data, all } = load();
  const rank = { percent: 0, flat: 1, count: 2 };
  for (const c of x.pathGains(all, data.courses).categories) {
    for (let i = 1; i < c.gains.length; i++) {
      const a = c.gains[i - 1];
      const b = c.gains[i];
      assert.ok(rank[a.unit] <= rank[b.unit], `${c.category}: ${b.unit} item follows ${a.unit} item`);
      if (a.unit !== b.unit) continue;
      if (a.unit === 'count') assert.ok(a.selection < b.selection, `${c.category}: count items not alphabetical`);
      else assert.ok(a.amount > b.amount || (a.amount === b.amount && a.selection < b.selection),
        `${c.category}: ${a.unit} items out of order at ${i}`);
    }
  }
});

test('categories follow FOCUS_CATEGORIES order, exclude Working Stats, and drop empties', () => {
  const { x, data, all } = load();
  assert.deepStrictEqual(Array.from(x.pathGains([106], data.courses).categories, (c) => c.category), ['Passive Stat Bonus']);
  const seen = Array.from(x.pathGains(all, data.courses).categories, (c) => c.category);
  assert.deepStrictEqual(seen, Array.from(x.FOCUS_CATEGORIES).filter((c) => seen.includes(c)));
  assert.ok(!seen.includes('Working Stats'));
});

test('a duplicated queue id counts once', () => {
  const { x, data } = load();
  assert.deepStrictEqual(x.pathGains([106, 106], data.courses), x.pathGains([106], data.courses));
});

test('unmatched counts mismatches on queued courses only', () => {
  const { x, data, all } = load();
  assert.strictEqual(x.pathGains(all, data.courses).unmatched, 0, 'the live fixture matches the taxonomy');

  const courses = new Map(data.courses);
  courses.set(106, Object.assign({}, courses.get(106), { learningOutcomes: ['Something Torn reworded'] }));
  const queued = x.pathGains([106], courses);
  assert.strictEqual(queued.categories.length, 0, 'a stale row contributes nothing');
  // every row for 106 is now stale, and the new string is claimed by none
  assert.strictEqual(queued.unmatched, x.FOCUS_TAXONOMY.filter((r) => r.courseId === 106).length + 1);

  // the same edit, but to a course outside the queue, is not this queue's problem
  assert.strictEqual(x.pathGains([107], courses).unmatched, 0);
});

test('hostile input degrades to an empty result and never throws', () => {
  const { x, data } = load();
  const empty = { courseCount: 0, degreeCount: 0, workingStats: [], categories: [], unmatched: 0 };
  const plain = (g) => JSON.parse(JSON.stringify(g));
  assert.deepStrictEqual(plain(x.pathGains(null, data.courses)), empty);
  assert.deepStrictEqual(plain(x.pathGains([1, 2], null)), empty);
  assert.deepStrictEqual(plain(x.pathGains('34', data.courses)), empty);
  assert.deepStrictEqual(plain(x.pathGains([999999], data.courses)), empty);
});

const NOW = 1767000000;
function modelFor(x, data, queue, extra) {
  return x.buildPanelModel(Object.assign({
    fetchResult: { ok: true, data: data },
    plan: { queue: queue, collapsed: false },
    now: NOW,
    settings: {},
  }, extra || {}));
}

test('pathSummaryModel formats every line exactly, with overflow kept whole', () => {
  const { x } = load();
  const s = x.pathSummaryModel({
    courseCount: 23, degreeCount: 2,
    workingStats: [{ stat: 'intelligence', amount: 8080 }, { stat: 'endurance', amount: 3280 }],
    categories: [
      { category: 'Passive Stat Bonus', gains: [{ selection: 'Strength', unit: 'percent', amount: 5 }] },
      { category: 'Combat Bonuses', gains: [
        { selection: 'A', unit: 'percent', amount: 5 },
        { selection: 'B', unit: 'percent', amount: 0.1 + 0.2 },
        { selection: 'C', unit: 'flat', amount: 3 },
        { selection: 'D', unit: 'flat', amount: 1 },
        { selection: 'E', unit: 'count', amount: 1 },
        { selection: 'F', unit: 'count', amount: 1 },
      ] },
    ],
    unmatched: 1,
  }, { totalLabel: '87 days 4 hrs', finishLabel: '2027-01-04 · 13:00 TCT' });
  assert.strictEqual(s.headline, '23 courses · 2 degrees · 87 days 4 hrs queued');
  assert.strictEqual(s.finish, 'Finishes 2027-01-04 · 13:00 TCT');
  assert.strictEqual(s.workingStats, 'Working stats: +8,080 intelligence · +3,280 endurance');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.categories)), [
    { text: 'Passive Stat Bonus: Strength +5%', fullText: null },
    { text: 'Combat Bonuses: A +5% · B +0.3% · C +3 · D +1 · +2 more',
      fullText: 'Combat Bonuses: A +5% · B +0.3% · C +3 · D +1 · E · F' },
  ]);
  assert.match(s.healthNote, /not counted/);
});

test('pathSummaryModel singularises, drops a zero degree count, and omits empty lines', () => {
  const { x } = load();
  const s = x.pathSummaryModel({ courseCount: 1, degreeCount: 0, workingStats: [], categories: [], unmatched: 0 },
    { totalLabel: '7 days', finishLabel: 'F' });
  assert.strictEqual(s.headline, '1 course · 7 days queued');
  assert.strictEqual(s.finish, 'Finishes F');
  assert.strictEqual(s.workingStats, null);
  assert.strictEqual(s.categories.length, 0);
  assert.strictEqual(s.healthNote, null);
});

test('the summary never carries a Books floor date (spec D9)', () => {
  const { x, data, all } = load();
  const m = modelFor(x, data, all.slice(0, 5), { summaryOpen: true });
  assert.ok(m.consumables && m.consumables.floorFinishLabel, 'the fixture path has a floor to leak');
  assert.ok(!JSON.stringify(m.pathSummary).includes(m.consumables.floorFinishLabel));
  assert.ok(!/floor/i.test(JSON.stringify(m.pathSummary)));
});

test('summaryAvailable is exactly the finish-date gate, with a reason per cause', () => {
  const { x, data, all } = load();
  const ok = modelFor(x, data, all.slice(0, 5));
  assert.ok(ok.finishLabel);
  assert.strictEqual(ok.summaryAvailable, true);
  assert.strictEqual(ok.summaryReason, null);

  const empty = modelFor(x, data, [], { summaryOpen: true });
  assert.strictEqual(empty.summaryAvailable, false);
  assert.strictEqual(empty.summaryReason, x.PATH_SUMMARY_REASONS.empty);
  assert.strictEqual(empty.pathSummary, null);

  // A bachelor with none of its prerequisites queued: problems, so no date.
  const bachelor = all.find((id) => data.courses.get(id).tier === 3);
  const broken = modelFor(x, data, [bachelor], { summaryOpen: true });
  assert.ok(broken.problems.length > 0);
  assert.strictEqual(broken.finishLabel, null);
  assert.strictEqual(broken.summaryAvailable, false);
  assert.strictEqual(broken.summaryReason, x.PATH_SUMMARY_REASONS.prerequisites);
  assert.strictEqual(broken.summaryOpen, false);
  assert.strictEqual(broken.pathSummary, null);
});

test('pathSummary is built only while open, and agrees with the finish line', () => {
  const { x, data, all } = load();
  const closed = modelFor(x, data, all.slice(0, 5));
  assert.strictEqual(closed.summaryOpen, false);
  assert.strictEqual(closed.pathSummary, null, 'a closed summary must cost nothing per draw');

  const open = modelFor(x, data, all.slice(0, 5), { summaryOpen: true });
  assert.strictEqual(open.summaryOpen, true);
  assert.strictEqual(open.pathSummary.finish, `Finishes ${open.finishLabel}`);
  assert.ok(open.pathSummary.headline.endsWith(`${open.totalLabel} queued`));
});

test('failure, error and loading models carry no summary, and say why', () => {
  const { x } = load();
  const failed = x.buildPanelModel({ fetchResult: { ok: false, reason: 'network', detail: 'x' },
    plan: { queue: [], collapsed: false }, now: NOW, summaryOpen: true });
  for (const m of [failed, x.errorModel('boom'), x.loadingModel()]) {
    assert.strictEqual(m.summaryAvailable, false);
    assert.strictEqual(m.summaryOpen, false);
    assert.strictEqual(m.pathSummary, null);
  }
  assert.strictEqual(failed.summaryReason, x.PATH_SUMMARY_REASONS.noData);
});

test('a queue delivering no taxonomy bonus still has headline, finish and working stats', () => {
  const { x, data, all } = load();
  const bare = all.find((id) => (data.courses.get(id).learningOutcomes || []).length === 0
    && data.courses.get(id).parentId == null);
  assert.ok(bare, 'fixture has a root course with no learning outcomes');
  const s = modelFor(x, data, [bare], { summaryOpen: true }).pathSummary;
  assert.ok(s.headline && s.finish && s.workingStats);
  assert.strictEqual(s.categories.length, 0);
  assert.strictEqual(s.healthNote, null);
});
