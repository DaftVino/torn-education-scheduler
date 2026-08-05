'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
const { makeFakeDocument } = require('./fake-document');

// This file's other tests are all engine/storage unit tests with no DOM.
// This one has to run a real init() end to end to reach the reset button at
// all, so it needs the shared fake document — and, since it needs only one
// element off it, minimal local copies of tests/panel.test.js's own
// descendants()/fire() idioms rather than a second full DOM harness.
function descendants(el) {
  const out = [];
  (function walk(node) {
    out.push(node);
    for (const child of (node.children || [])) walk(child);
  })(el);
  return out;
}
const fire = (el, type) => { for (const fn of (el.listeners[type] || [])) fn(); };

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

test('a duplicated course id is deduped, keeping the first occurrence', () => {
  const { exports, gmStore } = loadUserscript();
  gmStore.set(exports.STORAGE_KEY, JSON.stringify({ queue: [38, 39, 38, 40, 39], collapsed: false }));
  assert.deepStrictEqual(exports.loadPlan().queue, [38, 39, 40]);
});

test('savePlan reports success and failure to its caller', () => {
  const { exports, sandbox } = loadUserscript();
  assert.strictEqual(exports.savePlan({ queue: [38], collapsed: false }), true);
  sandbox.GM_setValue = () => { throw new Error('storage unavailable'); };
  assert.strictEqual(exports.savePlan({ queue: [38], collapsed: false }), false);
});

// v0.3.0 Task 2: resetArmed lives only in init()'s closure (see the reset
// control wiring in the RUNTIME section) and is never written into either
// stored blob. Arming alone must leave both keys exactly as init() found
// them — a confirmed reset's own tests live in tests/panel.test.js, since
// they need to assert on what changed rather than what did not.
test('the armed flag never reaches storage', async () => {
  const doc = makeFakeDocument();
  doc.cookie = 'rfc_v=abcdefghijklm';
  const { exports: x, gmStore } = loadUserscript({
    location: { search: '' },
    document: doc,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) }),
  });
  gmStore.set(x.STORAGE_KEY, JSON.stringify({ queue: [34], collapsed: false }));
  await x.init();

  const panel = doc.querySelector('#tes-panel');
  const resetBtn = descendants(panel).find((c) => /tes-reset/.test(c.className));
  fire(resetBtn, 'click');

  for (const key of [x.STORAGE_KEY, x.SETTINGS_KEY]) {
    const raw = gmStore.get(key);
    if (raw) assert.ok(!/armed/i.test(raw), `${key} must not carry the armed flag`);
  }
});
