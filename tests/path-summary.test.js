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
