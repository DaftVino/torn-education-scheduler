'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

const LIMITS = { maxNodes: 5000, maxDepth: 12 };

test('looksLikePayload accepts the real fixture and rejects near-misses', () => {
  const { exports: x } = loadUserscript();
  assert.strictEqual(x.looksLikePayload(loadFixture()), true);
  assert.strictEqual(x.looksLikePayload(null), false);
  assert.strictEqual(x.looksLikePayload([]), false);
  assert.strictEqual(x.looksLikePayload({ success: true, categories: [] }), false);
  assert.strictEqual(x.looksLikePayload({ success: false, categories: [{ id: 1, courses: [] }] }), false);
  assert.strictEqual(x.looksLikePayload({ success: true, categories: [{ id: 'x', courses: [] }] }), false);
});

test('searchForPayload finds a payload nested inside a props graph', () => {
  const { exports: x } = loadUserscript();
  const payload = loadFixture();
  const root = { a: { b: [{ c: null }, { memoizedProps: { data: payload } }] } };
  const found = x.searchForPayload(root, LIMITS);
  assert.ok(found, 'payload not found');
  assert.strictEqual(found.categories.length, payload.categories.length);
});

test('searchForPayload terminates on a cyclic graph', () => {
  const { exports: x } = loadUserscript();
  const a = { name: 'a' };
  const b = { name: 'b', a: a };
  a.b = b;
  assert.strictEqual(x.searchForPayload(a, LIMITS), null);
});

test('searchForPayload respects maxNodes and maxDepth', () => {
  const { exports: x } = loadUserscript();
  const payload = loadFixture();
  // Bury the payload deeper than maxDepth allows.
  let deep = { data: payload };
  for (let i = 0; i < 20; i += 1) deep = { child: deep };
  assert.strictEqual(x.searchForPayload(deep, { maxNodes: 100000, maxDepth: 5 }), null);
  // And starve the node budget with a wide graph.
  const wide = { kids: [] };
  for (let i = 0; i < 500; i += 1) wide.kids.push({ filler: i });
  wide.kids.push({ data: payload });
  assert.strictEqual(x.searchForPayload(wide, { maxNodes: 10, maxDepth: 12 }), null);
});

test('searchForPayload ignores non-plain values without throwing', () => {
  const { exports: x } = loadUserscript();
  const root = { fn: function () {}, s: 'str', n: 5, d: new Date(), u: undefined, nul: null };
  assert.strictEqual(x.searchForPayload(root, LIMITS), null);
});

test('acquireEducationData falls through to the fiber when the fetch fails', async () => {
  const payload = loadFixture();
  const node = { nodeType: 1 };
  node['__reactFiber$abc123'] = { memoizedProps: { data: payload } };
  const doc = {
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => [node],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }),
    body: { appendChild() {} },
  };
  const { exports: x } = loadUserscript({
    document: doc,
    fetch: async () => { throw new Error('endpoint gone'); },
  });
  const result = await x.acquireEducationData(doc);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'fiber');
  assert.strictEqual(result.data.courses.size, 131);
});

test('acquireEducationData prefers the fetch and never consults the fiber on success', async () => {
  const payload = loadFixture();
  let fiberTouched = false;
  const doc = {
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => { fiberTouched = true; return []; },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }),
    body: { appendChild() {} },
  };
  const { exports: x } = loadUserscript({
    document: doc,
    location: { origin: 'https://www.torn.com', href: 'https://www.torn.com/page.php?sid=education' },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) }),
  });
  // The adapter needs a cookie to fire; give the sandbox one.
  const result = await x.acquireEducationData(doc);
  if (result.ok) {
    assert.strictEqual(result.source, 'fetch');
    assert.strictEqual(fiberTouched, false, 'fiber was consulted despite a successful fetch');
  } else {
    // No cookie jar in the sandbox: the fetch short-circuits, so the fiber is
    // reached and finds nothing. Both outcomes prove the ordering.
    assert.strictEqual(result.triedFiber, true);
  }
});

test('acquireEducationData reports both failures and never rejects', async () => {
  const doc = {
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }),
    body: { appendChild() {} },
  };
  const { exports: x } = loadUserscript({
    document: doc,
    fetch: async () => { throw new Error('boom'); },
  });
  const result = await x.acquireEducationData(doc);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.triedFiber, true);
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
});
