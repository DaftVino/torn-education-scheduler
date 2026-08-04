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

test('a course whose parent is not completed reports that parent', () => {
  const { exports, courses, completedIds } = setup();
  // MTH2320 (32) needs MTH2260 (26), which is not completed in the fixture.
  assert.deepStrictEqual(exports.unmetPrerequisites(32, completedIds, courses), [26]);
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
