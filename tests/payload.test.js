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

test('rejects an active course whose completedAt is not an integer', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.activeCourse.completedAt = '1767225600';
  assert.throws(() => exports.parsePayload(raw), (err) => err.reason === 'bad-active-course');
});

test('rejects an active course whose id is null', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.activeCourse.id = null;
  assert.throws(() => exports.parsePayload(raw), (err) => err.reason === 'bad-active-course');
});

test('rejects an active course completedAt given in milliseconds, not seconds', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  // The fixture's real value (1767225600) times 1000 — a plausible-looking
  // integer that isInt alone would wave through, and the exact corruption
  // that would otherwise land a finish date around the year 57970.
  raw.activeCourse.completedAt = 1767225600000;
  assert.throws(() => exports.parsePayload(raw), (err) => err.reason === 'bad-active-course');
});

test('rejects an active course completedAt of 0', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.activeCourse.completedAt = 0;
  assert.throws(() => exports.parsePayload(raw), (err) => err.reason === 'bad-active-course');
});

test('rejects a negative active course completedAt', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  raw.activeCourse.completedAt = -1767225600;
  assert.throws(() => exports.parsePayload(raw), (err) => err.reason === 'bad-active-course');
});

test('accepts the fixture\'s real completedAt — the range check must not reject valid data', () => {
  const { exports } = loadUserscript();
  const raw = loadFixture();
  assert.strictEqual(raw.activeCourse.completedAt, 1767225600);
  assert.strictEqual(exports.parsePayload(raw).activeCourse.completedAt, 1767225600);
});

test('transform rebuilds vm-realm objects so deepStrictEqual can compare them', () => {
  const { transform, runInVm } = loadUserscript();
  const vmObj = runInVm('({ a: 1, b: [2, 3] })');
  assert.notStrictEqual(Object.getPrototypeOf(vmObj), Object.prototype,
    'precondition: a vm-realm literal must not share the main realm prototype');
  const plain = transform(vmObj);
  assert.strictEqual(Object.getPrototypeOf(plain), Object.prototype);
  assert.deepStrictEqual(plain, { a: 1, b: [2, 3] });
});

test('transform passes thenables through by identity', () => {
  const { transform } = loadUserscript();
  const promise = Promise.resolve({ ok: true });
  assert.strictEqual(transform(promise), promise);
  const thenable = { then: function (cb) { cb(1); } };
  assert.strictEqual(transform(thenable), thenable);
});

test('transform passes main-realm objects through by identity', () => {
  const { transform } = loadUserscript();
  const foreign = { sentinel: true, nested: { deep: 1 } };
  assert.strictEqual(transform(foreign), foreign);
  assert.strictEqual(transform(foreign).nested, foreign.nested);
});

test('transform keeps Map and Set as Map and Set with contents rebuilt', () => {
  const { transform, runInVm } = loadUserscript();
  const out = transform(runInVm('new Map([[1, { x: 1 }]])'));
  assert.ok(out instanceof Map);
  assert.deepStrictEqual(out.get(1), { x: 1 });
  const set = transform(runInVm('new Set([{ y: 2 }])'));
  assert.ok(set instanceof Set);
  assert.deepStrictEqual([...set], [{ y: 2 }]);
});
