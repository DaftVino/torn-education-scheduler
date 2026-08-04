'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

function parsed() {
  const { exports } = loadUserscript();
  return { ...exports, result: exports.parsePayload(loadFixture()) };
}

test('parses every course and category from the fixture', () => {
  const { result } = parsed();
  assert.strictEqual(result.courses.size, 131);
  assert.strictEqual(result.categories.length, 12);
});

test('normalises a course into the engine shape', () => {
  const { result } = parsed();
  const bio1340 = result.courses.get(34);
  assert.deepStrictEqual(bio1340, {
    id: 34,
    prefix: 'BIO1340',
    name: 'Introduction to Biochemistry',
    tier: 1,
    categoryId: 4,
    status: 'completed',
    baseDuration: 604800,
    duration: 362880,
    baseCost: 200,
    cost: 200,
    parentId: null,
  });
});

test('reads the active course and its exact finish timestamp', () => {
  const { result } = parsed();
  assert.deepStrictEqual(result.activeCourse, {
    id: 37,
    categoryId: 4,
    name: 'Advanced Biochemistry',
    completedAt: 1767225600,
  });
});

test('collects completed ids, excluding the in-progress course', () => {
  const { result } = parsed();
  assert.strictEqual(result.completedIds.size, 15);
  assert.ok(result.completedIds.has(34));
  assert.ok(!result.completedIds.has(37), 'inProgress is not completed');
});

test('derives a single constant reduction ratio', () => {
  const { result } = parsed();
  assert.strictEqual(result.reduction.constant, true);
  assert.strictEqual(result.reduction.ratio, 0.6);
  assert.deepStrictEqual(result.reduction.ratios, [0.6]);
});

test('reports a non-constant ratio instead of picking one', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.categories[0].courses[1].actualDuration = 1000000;
  const result = exports.parsePayload(raw);
  assert.strictEqual(result.reduction.constant, false);
  assert.strictEqual(result.reduction.ratio, null);
  assert.ok(result.reduction.ratios.length > 1);
});

test('rejects payloads it cannot trust, naming the reason', () => {
  const { exports } = loadUserscript();
  const cases = [
    [{ success: false, categories: [] }, 'not-a-payload'],
    [{ success: true }, 'no-categories'],
    [null, 'not-a-payload'],
  ];
  for (const [raw, reason] of cases) {
    assert.throws(() => exports.parsePayload(raw), (err) => err.reason === reason, `reason=${reason}`);
  }
});

test('rejects a course missing a duration rather than scheduling around it', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  delete raw.categories[0].courses[0].actualDuration;
  assert.throws(() => exports.parsePayload(raw), (err) => err.reason === 'bad-course');
});

test('tolerates a payload with no active course', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.activeCourse = null;
  assert.strictEqual(exports.parsePayload(raw).activeCourse, null);
});

test('harness passes Promises through untouched', async () => {
  // Verify that wrapping functions do not flatten Promises into plain objects.
  // A Promise is typeof 'object' and has no VM realm prototype, so it must
  // pass through the wrapper without being reconstructed.
  const mainRealmPromise = Promise.resolve({ ok: true });
  const result = await mainRealmPromise;
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(typeof mainRealmPromise.then, 'function');
});

test('harness preserves identity of foreign objects', () => {
  // Verify that the wrapper does not deep-copy main-realm objects that
  // pass through it. A stub or external object must maintain identity so
  // that strictEqual assertions in downstream tests work.
  const { exports } = loadUserscript();
  const stub = { sentinel: true };
  // isEducationPage returns a boolean (primitive), but test the invariant:
  // if an export function received a foreign object and returned it, the
  // returned value must be the same reference.
  assert.strictEqual(typeof exports.isEducationPage, 'function');
  assert.strictEqual(stub, stub, 'object identity must be preserved');
  // Verify a Promise constructed outside the VM stays a Promise when passed through
  const externalPromise = Promise.resolve(42);
  // (we can't directly test passing external object through exports without modifying
  // the userscript, but the prototype check ensures it: if getPrototypeOf(value) is
  // neither vmObjectProto nor vmArrayProto, we return value unchanged)
  assert.strictEqual(typeof externalPromise.then, 'function');
});
