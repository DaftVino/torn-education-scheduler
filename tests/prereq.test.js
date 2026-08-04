'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

function setup() {
  const { exports } = loadUserscript();
  const parsed = exports.parsePayload(loadFixture());
  return { exports, courses: parsed.courses, completedIds: parsed.completedIds };
}

test('a tier-1 course with no parent is always available', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.unmetPrerequisites(34, completedIds, courses), []);
});

test('a course whose parent is completed has nothing unmet', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.unmetPrerequisites(38, completedIds, courses), []);
});

test('a course reports every uncompleted ancestor, not just its parent', () => {
  const { exports, courses, completedIds } = setup();
  // MTH2320 (32) → MTH2260 (26) → MTH1220 (22). None is completed in the
  // fixture, so all of the gap is reported at once rather than one link per
  // round trip.
  assert.deepStrictEqual(exports.unmetPrerequisites(32, completedIds, courses), [22, 26]);
});

test('a tier-3 bachelor needs every tier-2 course in its category', () => {
  const { exports, courses, completedIds } = setup();
  // BIO3420 (42) has parentId null but gates on Biology tier-2:
  // 35 and 36 are completed, 37 is inProgress, the rest are not started.
  assert.deepStrictEqual(exports.unmetPrerequisites(42, completedIds, courses), [37, 38, 39, 40, 41, 127]);
});

test('an in-progress course does not count as completed for gating', () => {
  const { exports, courses, completedIds } = setup();
  assert.ok(exports.unmetPrerequisites(42, completedIds, courses).includes(37));
});

test('an unknown course id is reported, not silently allowed', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.unmetPrerequisites(999999, completedIds, courses), [-1]);
});

test('the ancestor walk stops at a course already completed', () => {
  const { exports, courses, completedIds } = setup();
  // CMT2129 (129) → CMT2128 (128) → CMT2570 (57) → CMT1520 (52).
  // 52 is completed, so it and anything above it must not be reported —
  // a completed course is not work remaining.
  assert.deepStrictEqual(exports.unmetPrerequisites(129, completedIds, courses), [57, 128]);
});

// MTH1220 (22) → MTH2260 (26) → MTH2320 (32). In the fixture none of the three
// is completed: 22 is 'available', 26 and 32 are 'notMeetRequirement'. So a
// legal queue has to include 22 itself.
test('a complete chain in dependency order validates clean', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.validateQueue([22, 26, 32], completedIds, courses), []);
});

test('earlier queue entries satisfy later ones', () => {
  const { exports, courses, completedIds } = setup();
  // 26 alone would be unmet, but 22 precedes it, so only the queue head reports.
  assert.deepStrictEqual(exports.validateQueue([22, 32], completedIds, courses), [
    { courseId: 32, missing: [26] },
  ]);
});

test('a queue whose head has an unmet prerequisite reports it', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.validateQueue([26, 32], completedIds, courses), [
    { courseId: 26, missing: [22] },
  ]);
});

test('a queue in an illegal order names the offending course', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.validateQueue([22, 32, 26], completedIds, courses), [
    { courseId: 32, missing: [26] },
  ]);
});

test('an empty queue validates clean', () => {
  const { exports, courses, completedIds } = setup();
  assert.deepStrictEqual(exports.validateQueue([], completedIds, courses), []);
});

test('a cyclic prerequisite graph terminates instead of hanging the tab', () => {
  const { exports, courses, completedIds } = setup();
  // Torn's data is acyclic today, but a corrupt or changed payload must not
  // freeze the page. 32 → 26 → 22 is a real chain; point 22 back at 32 to
  // close the loop.
  courses.get(22).parentId = 32;
  assert.deepStrictEqual(exports.unmetPrerequisites(32, completedIds, courses), [22, 26, 32]);
});

// requiredCoursesFor: the full transitive chain a player must actually queue,
// in an order validateQueue accepts, courseId last.

test('a course with no unmet requirements returns just itself', () => {
  const { exports, courses, completedIds } = setup();
  // MTH1220 (22) is tier 1, parentId null, not completed in the fixture.
  assert.deepStrictEqual(exports.requiredCoursesFor(22, completedIds, courses), [22]);
});

test('a tier-2 course with an uncompleted parent chain returns the chain then itself, in that order', () => {
  const { exports, courses, completedIds } = setup();
  // MTH1220 (22) → MTH2260 (26) → MTH2320 (32), none completed.
  assert.deepStrictEqual(exports.requiredCoursesFor(32, completedIds, courses), [22, 26, 32]);
});

test("a tier-3 bachelor returns its category's tier-2 courses and their parents, itself last", () => {
  const { exports, courses, completedIds } = setup();
  // PSY3690 (69) needs all six Psychology tier-2 courses (64,65,66,67,68,132),
  // each of which needs PSY1630 (63) first. 63 must appear exactly once,
  // ahead of all six, with 69 last.
  const result = exports.requiredCoursesFor(69, completedIds, courses);
  assert.deepStrictEqual(result, [63, 64, 65, 66, 67, 68, 132, 69]);
});

test('completed courses never appear in the result', () => {
  const { exports, courses, completedIds } = setup();
  // BIO3420 (42) gates on Biology tier-2: 35 and 36 are completed in the
  // fixture and must be excluded, along with the tier-1 parent (34) they
  // share, which is also completed.
  const result = exports.requiredCoursesFor(42, completedIds, courses);
  assert.deepStrictEqual(result, [37, 38, 39, 40, 41, 127, 42]);
  for (const completed of [34, 35, 36]) {
    assert.ok(!result.includes(completed), `${completed} is completed and must not appear`);
  }
});

test('the result contains no duplicates', () => {
  const { exports, courses, completedIds } = setup();
  const result = exports.requiredCoursesFor(69, completedIds, courses);
  assert.strictEqual(new Set(result).size, result.length);
});

test('a cyclic parentId graph terminates rather than hanging', () => {
  const { exports, courses, completedIds } = setup();
  courses.get(22).parentId = 32;
  const result = exports.requiredCoursesFor(32, completedIds, courses);
  assert.deepStrictEqual(result, [22, 26, 32]);
});

// The property that matters most: for any course in the catalogue, queuing
// requiredCoursesFor(courseId, ...) into an empty queue must produce a queue
// validateQueue accepts. Run over the entire catalogue — every tier-3
// bachelor is in here, since those have the largest chains, but nothing is
// excluded, per the brief's instruction not to narrow the sample.
test('requiredCoursesFor always produces a queue validateQueue accepts, for every course in the catalogue', () => {
  const { exports, courses, completedIds } = setup();
  for (const courseId of courses.keys()) {
    const queue = exports.requiredCoursesFor(courseId, completedIds, courses);
    const problems = exports.validateQueue(queue, completedIds, courses);
    assert.deepStrictEqual(
      problems, [],
      `requiredCoursesFor(${courseId}) produced an unfollowable queue: ${JSON.stringify(queue)} -> ${JSON.stringify(problems)}`
    );
  }
});
