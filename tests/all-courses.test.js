'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

test('allRemainingCourses returns every unfinished course, dependency-ordered', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);

  assert.strictEqual(queue.length, 115, 'wrong number of remaining courses');
  assert.strictEqual(new Set(queue).size, queue.length, 'the queue contains duplicates');
  for (const id of queue) {
    const course = data.courses.get(id);
    assert.notStrictEqual(course.status, 'completed', `${course.prefix} is already completed`);
    assert.notStrictEqual(course.status, 'inProgress', `${course.prefix} is in progress`);
  }
  // Judged against what the player will have finished when the queue starts:
  // the course being served now ends before anything queued can begin, which is
  // the same assumption schedule() makes when it starts the queue at
  // activeCourse.completedAt. buildPanelModel judges the queue the same way.
  assert.deepStrictEqual(
    x.validateQueue(queue, x.plannedCompletions(data.completedIds, data.courses, data.activeCourse), data.courses),
    [],
    'the all-courses queue is not a followable order'
  );
});

// The distinction above is load-bearing, so it is pinned rather than left to
// the helper both sides use. Against today's completions exactly one entry
// looks unfollowable — BIO3420, gated on BIO2370, the course in progress — and
// it is emitted after every other Biology prerequisite, so the only thing
// standing between the player and it is time already being served.
test('the only course the all-courses queue defers to the active course is the one gated on it', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);

  const today = x.validateQueue(queue, data.completedIds, data.courses);
  assert.deepStrictEqual(today.map((p) => p.courseId), [42]);
  assert.deepStrictEqual(today[0].missing, [37]);
  assert.strictEqual(data.courses.get(37).status, 'inProgress');
  assert.strictEqual(data.activeCourse.id, 37);
  for (const id of [38, 39, 40, 41, 127]) {
    assert.ok(queue.indexOf(id) < queue.indexOf(42), `${id} must precede the bachelor it gates`);
  }
});

test('the in-progress course counts as done for planning but not for starting today', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const planned = x.plannedCompletions(data.completedIds, data.courses, data.activeCourse);

  assert.ok(planned.has(37), 'the active course must count as done for a plan');
  assert.ok(!data.completedIds.has(37), 'parsePayload must not report it completed');
  // The other question, unchanged: can this be started right now? No.
  assert.ok(x.unmetPrerequisites(42, data.completedIds, data.courses).includes(37));
  for (const id of data.completedIds) assert.ok(planned.has(id), `${id} lost from the planned set`);
});

test('allRemainingCourses is empty when everything is done', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const allIds = new Set([...data.courses.keys()]);
  assert.deepStrictEqual(x.allRemainingCourses(allIds, data.courses, data.activeCourse), []);
});

test('bachelor courses are marked in the addable list', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const model = x.buildPanelModel({
    fetchResult: { ok: true, data },
    plan: { queue: [], collapsed: false },
    settings: x.freshSettings(),
    now: 1767225600,
  });
  // Twelve tier-3 degrees exist, one per category, but SPT3510 is completed in
  // the fixture and addable never offers a completed course — so eleven are
  // markable here. The catalogue-wide count is asserted separately below, so a
  // marker that silently stopped matching tier 3 cannot hide behind this.
  const bachelors = model.addable.filter((a) => a.isBachelor);
  assert.strictEqual(bachelors.length, 11, 'expected every takeable bachelor to be marked');
  const tierThree = [...data.courses.values()].filter((c) => c.tier === 3);
  assert.strictEqual(tierThree.length, 12);
  assert.strictEqual(tierThree.filter((c) => c.status === 'completed').length, 1);
  for (const b of bachelors) {
    assert.ok(b.label.indexOf('[bachelor] ') === 0, `${b.prefix} is not marked in its label`);
  }
  const ordinary = model.addable.find((a) => a.prefix === 'BIO2380');
  assert.strictEqual(ordinary.isBachelor, false);
  assert.ok(ordinary.label.indexOf('[bachelor]') === -1);
});

// `status` and `activeCourse` come from independent parts of the payload, so a
// course can in principle read inProgress with no completion time anywhere.
// schedule() bills none of its remaining weeks, so promoting it would print a
// finish date short by a whole course — here 16.8 days. Withholding the date is
// the state the panel was in before any of this existed, and the trade this
// codebase makes every time: no date beats a wrong one.
test('an in-progress course Torn does not name as active is never promoted', () => {
  const { exports: x } = loadUserscript();
  const raw = loadFixture();
  raw.activeCourse = null;
  const data = x.parsePayload(raw);
  assert.strictEqual(data.activeCourse, null);
  assert.strictEqual(data.courses.get(37).status, 'inProgress');

  const planned = x.plannedCompletions(data.completedIds, data.courses, data.activeCourse);
  assert.ok(!planned.has(37), 'a course with no completion time was counted as done');

  const queue = x.allRemainingCourses(data.completedIds, data.courses, data.activeCourse);
  assert.ok(queue.indexOf(37) === -1, 'the in-progress course reached the queue');
  const model = x.buildPanelModel({
    fetchResult: { ok: true, data },
    plan: { queue: queue, collapsed: false },
    settings: x.freshSettings(),
    now: 1767225600,
  });
  assert.ok(model.problems.some((p) => p.prefix === 'BIO3420'), 'the gated degree was passed as followable');
  assert.strictEqual(model.finishLabel, null, 'a finish date was printed short by the unbilled course');
  assert.strictEqual(model.totalLabel, null);
});

test('a course in progress that is not the active one is left alone', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  // The real active course still promotes; a second inProgress course Torn
  // never named would not, because only activeCourse carries a completedAt.
  const planned = x.plannedCompletions(data.completedIds, data.courses, { id: 999999 });
  assert.ok(!planned.has(37), 'promotion must match on activeCourse.id, not on status alone');
  assert.strictEqual(planned.size, data.completedIds.size);
});

test('the all-courses sentinel is a string that cannot collide with a course id', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(typeof x.ALL_COURSES_OPTION, 'string');
  assert.ok(Number.isNaN(Number(x.ALL_COURSES_OPTION)), 'the sentinel parses as a number');
});

// The sentinel travels through selectedCourseId, a field that otherwise holds
// integers. If buildPanelModel coerced or dropped it, the picker would silently
// reset to the top of a 115-entry list on every redraw.
test('the sentinel survives a round trip through selectedCourseId', () => {
  const { exports: x } = loadUserscript();
  const data = x.parsePayload(loadFixture());
  const model = x.buildPanelModel({
    fetchResult: { ok: true, data },
    plan: { queue: [], collapsed: false },
    settings: x.freshSettings(),
    selectedCourseId: x.ALL_COURSES_OPTION,
    now: 1767225600,
  });
  assert.strictEqual(model.selectedCourseId, x.ALL_COURSES_OPTION);
});
