'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

function load() {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  return { x, data };
}

// A hand-built catalogue, for the regimes the 115-course fixture never visits:
// an empty queue, one course, courses with no relationship at all, and a queue
// where every course ties on the sort key. Ties are exactly where a topological
// sort quietly stops being deterministic, and the fixture — 115 courses with
// dozens of distinct durations — cannot produce one.
function makeCourses(specs) {
  const courses = new Map();
  for (const s of specs) {
    courses.set(s.id, {
      id: s.id,
      prefix: `SYN${s.id}`,
      name: `Synthetic ${s.id}`,
      tier: s.tier === undefined ? 1 : s.tier,
      categoryId: s.categoryId === undefined ? 1 : s.categoryId,
      parentId: s.parentId === undefined ? null : s.parentId,
      duration: s.duration === undefined ? 3600 : s.duration,
      status: 'available',
    });
  }
  return courses;
}

const MODES = ['as-listed', 'shortest-first', 'unlocks-first'];

test('every mode returns a queue that validateQueue accepts', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  for (const mode of x.ORDER_MODE_LABELS.map((m) => m.id)) {
    const ordered = x.orderQueue(queue, mode, data.courses);
    assert.strictEqual(ordered.length, queue.length, `${mode} changed the queue length`);
    assert.deepStrictEqual(
      new Set(ordered), new Set(queue),
      `${mode} changed the queue contents`
    );
    assert.deepStrictEqual(
      // plannedCompletions, not completedIds — see Task 7. The course now in
      // progress finishes before anything queued starts, so gating on today's
      // completions reports a phantom missing prerequisite.
      x.validateQueue(ordered, x.plannedCompletions(data.completedIds, data.courses, data.activeCourse), data.courses), [],
      `${mode} produced an order that cannot be followed`
    );
  }
});

test('ordering never changes the finish date', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const now = 1767225600;
  const baseline = x.schedule({ courses: data.courses, activeCourse: data.activeCourse, queue, now });
  for (const mode of x.ORDER_MODE_LABELS.map((m) => m.id)) {
    const ordered = x.orderQueue(queue, mode, data.courses);
    const result = x.schedule({ courses: data.courses, activeCourse: data.activeCourse, queue: ordered, now });
    assert.strictEqual(result.finishesAt, baseline.finishesAt, `${mode} moved the finish date`);
    assert.strictEqual(result.totalSeconds, baseline.totalSeconds, `${mode} moved the total`);
  }
});

test('as-listed preserves the given order exactly', () => {
  const { x, data } = load();
  const queue = x.requiredCoursesFor(42, data.completedIds, data.courses);
  assert.deepStrictEqual(x.orderQueue(queue, 'as-listed', data.courses), queue);
});

test('orderQueue does not mutate its input', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const copy = queue.slice();
  x.orderQueue(queue, 'shortest-first', data.courses);
  assert.deepStrictEqual(queue, copy, 'the input queue was mutated');
});

test('shortest-first takes the shortest available course at each step', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const ordered = x.orderQueue(queue, 'shortest-first', data.courses);
  // Among the courses with no unqueued prerequisite at the start, the first
  // pick must be the shortest.
  const readyAtStart = queue.filter((id) => {
    const c = data.courses.get(id);
    return c.parentId === null || !queue.includes(c.parentId);
  });
  const shortest = readyAtStart.reduce((best, id) =>
    data.courses.get(id).duration < data.courses.get(best).duration ? id : best, readyAtStart[0]);
  assert.strictEqual(
    data.courses.get(ordered[0]).duration,
    data.courses.get(shortest).duration,
    'the first pick was not the shortest ready course'
  );
});

test('dependentCount counts the whole downstream chain', () => {
  const { x, data } = load();
  // BIO1340 (34) is the tier-1 root that BIO2380 (38) and BIO2390 (39) hang off.
  assert.ok(x.dependentCount(34, data.courses) >= 2, 'a tier-1 root has no dependents');
  // A tier-3 bachelor unlocks nothing further inside the catalogue.
  assert.strictEqual(x.dependentCount(42, data.courses), 0);
});

test('unlocks-first leads with a course that unlocks more than the last one does', () => {
  const { x, data } = load();
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  const ordered = x.orderQueue(queue, 'unlocks-first', data.courses);
  const first = x.dependentCount(ordered[0], data.courses);
  const last = x.dependentCount(ordered[ordered.length - 1], data.courses);
  assert.ok(first > last, `first unlocks ${first}, last unlocks ${last}`);
});

test('an unknown mode falls back to as-listed rather than throwing', () => {
  const { x, data } = load();
  const queue = x.requiredCoursesFor(42, data.completedIds, data.courses);
  assert.deepStrictEqual(x.orderQueue(queue, 'days-per-bonus', data.courses), queue);
  assert.deepStrictEqual(x.orderQueue(queue, undefined, data.courses), queue);
});

test('the shipped mode list is exactly the three, and days-per-bonus is not among them', () => {
  const { x } = load();
  // days-per-bonus is parked (v0.2.0-scope § H2): the payload offers two
  // incompatible definitions of "bonus", and they sort the catalogue
  // differently. A mode that means one of two things is worse than no mode.
  // Array.from, because a non-function export is handed back with the vm
  // realm's Array prototype and deepStrictEqual compares prototypes.
  assert.deepStrictEqual(Array.from(x.ORDER_MODE_LABELS, (m) => m.id), MODES);
  for (const mode of x.ORDER_MODE_LABELS) {
    assert.strictEqual(typeof mode.label, 'string');
    assert.ok(mode.label.length > 0, `${mode.id} has no label`);
  }
});

// ── The small and degenerate regimes ────────────────────────────────────────

test('an empty queue orders to an empty queue in every mode', () => {
  const { x } = load();
  const courses = makeCourses([{ id: 1 }, { id: 2, parentId: 1 }]);
  for (const mode of MODES) {
    assert.deepStrictEqual(x.orderQueue([], mode, courses), [], `${mode} invented a course`);
  }
});

test('a one-course queue is that course in every mode', () => {
  const { x } = load();
  const courses = makeCourses([{ id: 1, duration: 7200 }, { id: 2, parentId: 1 }]);
  for (const mode of MODES) {
    assert.deepStrictEqual(x.orderQueue([1], mode, courses), [1], `${mode} disturbed a one-course queue`);
  }
});

test('with no prerequisite between any two courses, shortest-first is a plain ascending sort', () => {
  const { x } = load();
  // Nothing constrains the topological step, so every course is ready at every
  // step and the tiebreak is the only thing choosing.
  const courses = makeCourses([
    { id: 1, duration: 300 },
    { id: 2, duration: 100 },
    { id: 3, duration: 200 },
  ]);
  assert.deepStrictEqual(x.orderQueue([1, 2, 3], 'shortest-first', courses), [2, 3, 1]);
  assert.deepStrictEqual(x.orderQueue([1, 2, 3], 'as-listed', courses), [1, 2, 3]);
});

test('a tie on the sort key falls back to the given order rather than an arbitrary one', () => {
  const { x } = load();
  // Every course the same length and unrelated: shortest-first has nothing to
  // separate them. A topological sort with no second key is free to return any
  // permutation here, and would do so differently on a different engine.
  const courses = makeCourses([
    { id: 7, duration: 3600 },
    { id: 3, duration: 3600 },
    { id: 5, duration: 3600 },
  ]);
  assert.deepStrictEqual(x.orderQueue([7, 3, 5], 'shortest-first', courses), [7, 3, 5]);
  // And the same for unlocks-first, where all three unlock nothing.
  assert.deepStrictEqual(x.orderQueue([7, 3, 5], 'unlocks-first', courses), [7, 3, 5]);
});

test('a prerequisite in the queue always precedes what depends on it, tiebreak or not', () => {
  const { x } = load();
  // The chain is long and the shortest course is at the far end of it: the
  // tiebreak wants it first and the graph forbids that.
  const courses = makeCourses([
    { id: 1, duration: 9000 },
    { id: 2, parentId: 1, duration: 8000 },
    { id: 3, parentId: 2, duration: 10 },
  ]);
  assert.deepStrictEqual(x.orderQueue([3, 2, 1], 'shortest-first', courses), [1, 2, 3]);
});

test('a prerequisite outside the queue does not constrain the order', () => {
  const { x } = load();
  // Course 1 is already done and not queued, so 2 is ready from the start.
  const courses = makeCourses([
    { id: 1, duration: 9000 },
    { id: 2, parentId: 1, duration: 8000 },
    { id: 3, duration: 10 },
  ]);
  assert.deepStrictEqual(x.orderQueue([2, 3], 'shortest-first', courses), [3, 2]);
});

test('unlocks-first leads with the root of the deepest chain, not the longest course', () => {
  const { x } = load();
  const courses = makeCourses([
    { id: 1, duration: 9999 },            // unlocks 2 and 3
    { id: 2, parentId: 1, duration: 10 }, // unlocks 3
    { id: 3, parentId: 2, duration: 10 },
    { id: 4, duration: 10 },              // unlocks nothing
  ]);
  assert.strictEqual(x.dependentCount(1, courses), 2);
  assert.strictEqual(x.dependentCount(2, courses), 1);
  assert.strictEqual(x.dependentCount(4, courses), 0);
  assert.deepStrictEqual(x.orderQueue([4, 3, 2, 1], 'unlocks-first', courses), [1, 2, 4, 3]);
});

test('a tier-3 bachelor counts its category tier-2 courses as upstream', () => {
  const { x } = load();
  // The one rule the payload does not carry in parentId, and the same rule
  // unmetPrerequisites applies: a bachelor gates on every tier-2 course in its
  // own category — and on nothing in anyone else's.
  const courses = makeCourses([
    { id: 1, tier: 2, categoryId: 5, duration: 100 },
    { id: 2, tier: 2, categoryId: 5, duration: 50 },
    { id: 3, tier: 3, categoryId: 5, duration: 10 },
    { id: 4, tier: 2, categoryId: 6, duration: 10 },
  ]);
  assert.strictEqual(x.dependentCount(1, courses), 1, 'a tier-2 course must unlock its bachelor');
  assert.strictEqual(x.dependentCount(4, courses), 0, 'a bachelor gated on another category');
  assert.deepStrictEqual(x.orderQueue([3, 1, 2], 'shortest-first', courses), [2, 1, 3]);
});

test('dependentCount is zero for an unknown id and for an isolated course', () => {
  const { x } = load();
  const courses = makeCourses([{ id: 1 }, { id: 2 }]);
  assert.strictEqual(x.dependentCount(1, courses), 0);
  assert.strictEqual(x.dependentCount(999, courses), 0);
});

test('a cyclic prerequisite graph terminates and keeps every queued course', () => {
  const { x } = load();
  // Corrupt data, not a plan: 1 → 2 → 1. Nothing is ever ready, so the
  // remainder is appended in the order given rather than spun on, and
  // validateQueue is left to report the real problem.
  const courses = makeCourses([
    { id: 1, parentId: 2, duration: 100 },
    { id: 2, parentId: 1, duration: 50 },
    { id: 3, duration: 10 },
  ]);
  const ordered = x.orderQueue([1, 2, 3], 'shortest-first', courses);
  assert.strictEqual(ordered.length, 3);
  assert.deepStrictEqual(new Set(ordered), new Set([1, 2, 3]));
  assert.strictEqual(ordered[0], 3, 'the course that was ready should still be taken first');
});

test('a queued id missing from the catalogue is carried through rather than throwing', () => {
  const { x } = load();
  const courses = makeCourses([{ id: 1, duration: 100 }]);
  for (const mode of MODES) {
    const ordered = x.orderQueue([1, 404], mode, courses);
    assert.strictEqual(ordered.length, 2, `${mode} dropped a course it could not read`);
    assert.deepStrictEqual(new Set(ordered), new Set([1, 404]));
  }
});
