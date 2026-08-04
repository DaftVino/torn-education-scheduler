'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript } = require('./load-userscript');

test('a fresh install loads the default plan', () => {
  const { exports } = loadUserscript();
  assert.deepStrictEqual(exports.loadPlan(), { queue: [], collapsed: false });
});

test('a saved plan round-trips', () => {
  const { exports } = loadUserscript();
  exports.savePlan({ queue: [38, 39], collapsed: true });
  assert.deepStrictEqual(exports.loadPlan(), { queue: [38, 39], collapsed: true });
});

test('saving writes to GM storage under the declared key', () => {
  const { exports, gmStore } = loadUserscript();
  exports.savePlan({ queue: [34], collapsed: false });
  assert.ok(gmStore.has(exports.STORAGE_KEY));
});

test('corrupt stored data falls back to the default instead of throwing', () => {
  const { exports, gmStore } = loadUserscript();
  gmStore.set(exports.STORAGE_KEY, '{not json');
  assert.deepStrictEqual(exports.loadPlan(), { queue: [], collapsed: false });
});

test('a stored plan with a non-array queue falls back', () => {
  const { exports, gmStore } = loadUserscript();
  gmStore.set(exports.STORAGE_KEY, JSON.stringify({ queue: 'nope', collapsed: true }));
  assert.deepStrictEqual(exports.loadPlan(), { queue: [], collapsed: false });
});

test('non-numeric queue entries are dropped, not trusted', () => {
  const { exports, gmStore } = loadUserscript();
  gmStore.set(exports.STORAGE_KEY, JSON.stringify({ queue: [38, 'x', null, 39], collapsed: false }));
  assert.deepStrictEqual(exports.loadPlan().queue, [38, 39]);
});
