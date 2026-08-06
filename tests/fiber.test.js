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

test('a throwing getter does not abandon the rest of the walk', () => {
  const { exports: x } = loadUserscript();
  const payload = loadFixture();
  // A node whose `success` getter throws trips looksLikePayload itself, not
  // just the key enumeration. Unguarded, this abandons every sibling and every
  // remaining root; the payload sitting elsewhere in the same graph is the
  // proof that the walk carried on.
  const hostile = { tag: 'hostile' };
  Object.defineProperty(hostile, 'success', { get() { throw new Error('boom'); }, enumerable: true });
  const root = { bad: hostile, good: { data: payload } };
  const found = x.searchForPayload(root, LIMITS);
  assert.ok(found, 'the walk gave up when a getter threw');
  assert.strictEqual(found.categories.length, payload.categories.length);
});

test('a throwing getter on the categories probe is survived too', () => {
  const { exports: x } = loadUserscript();
  const payload = loadFixture();
  const hostile = { success: true };
  Object.defineProperty(hostile, 'categories', { get() { throw new Error('boom'); }, enumerable: true });
  const root = { bad: hostile, good: { data: payload } };
  assert.ok(x.searchForPayload(root, LIMITS), 'the walk gave up on a throwing categories getter');
});

test('a shared walk state spends one budget across every root', () => {
  const { exports: x } = loadUserscript();
  // Two roots, 20 nodes each. A shared 25-node budget must be consumed by the
  // pair, not handed to each of them fresh — the per-root bug this guards
  // against multiplied the real ceiling by the number of roots.
  const makeRoot = () => {
    const r = { kids: [] };
    for (let i = 0; i < 20; i += 1) r.kids.push({ filler: i });
    return r;
  };
  const rootA = makeRoot();
  const rootB = makeRoot();

  const shared = x.newWalkState();
  x.searchForPayload(rootA, { maxNodes: 25, maxDepth: 12 }, shared);
  assert.strictEqual(shared.exhausted, false, 'the first root alone should not exhaust 25 nodes');
  const spentAfterFirst = shared.visited;
  assert.ok(spentAfterFirst > 0, 'the first root spent nothing');

  x.searchForPayload(rootB, { maxNodes: 25, maxDepth: 12 }, shared);
  assert.strictEqual(shared.exhausted, true, 'the second root got a fresh budget instead of the shared one');
  assert.ok(shared.visited > spentAfterFirst, 'the shared counter did not carry over');
});

test('the walk state distinguishes exhaustion from a completed search', () => {
  const { exports: x } = loadUserscript();
  const small = { a: { b: 1 } };

  const completed = x.newWalkState();
  assert.strictEqual(x.searchForPayload(small, LIMITS, completed), null);
  assert.strictEqual(completed.exhausted, false, 'a finished walk must not report exhaustion');

  const starved = x.newWalkState();
  const wide = { kids: [] };
  for (let i = 0; i < 500; i += 1) wide.kids.push({ filler: i });
  assert.strictEqual(x.searchForPayload(wide, { maxNodes: 10, maxDepth: 12 }, starved), null);
  assert.strictEqual(starved.exhausted, true, 'a starved walk must report exhaustion');
});

test('fiberRootsFrom dedupes and caps the roots it returns', () => {
  const { exports: x } = loadUserscript();
  // One shared fiber object reachable from many nodes under many keys, exactly
  // as React 18 arranges it: __reactFiber$ and __reactProps$ on every host node.
  const shared = { memoizedProps: {} };
  const nodes = [];
  for (let i = 0; i < 200; i += 1) {
    const node = { nodeType: 1 };
    node['__reactFiber$abc123'] = shared;
    node['__reactProps$abc123'] = { distinct: i };
    nodes.push(node);
  }
  const doc = { querySelector: () => null, querySelectorAll: () => nodes };
  const roots = x.fiberRootsFrom(doc);
  assert.ok(roots.length <= 8, `expected at most 8 roots, got ${roots.length}`);
  // The shared fiber appears once, not 200 times.
  assert.strictEqual(roots.filter((r) => r === shared).length <= 1, true);
});

test('readFiberEducationData reports budget exhaustion as its own reason', async () => {
  const { exports: x } = loadUserscript();
  // A graph far larger than FIBER_LIMITS.maxNodes, holding no payload. The
  // honest answer is "gave up", not "it was not there".
  const big = { kids: [] };
  for (let i = 0; i < 30000; i += 1) big.kids.push({ filler: i, nested: { deeper: i } });
  const node = { nodeType: 1 };
  node['__reactFiber$abc123'] = big;
  const doc = { querySelector: () => null, querySelectorAll: () => [node] };

  const result = await x.readFiberEducationData(doc);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'fiber-budget-exhausted');
  assert.match(result.detail, /gave up after \d+ nodes/);
});

test('readFiberEducationData distinguishes an empty graph from an exhausted one', async () => {
  const { exports: x } = loadUserscript();
  const node = { nodeType: 1 };
  node['__reactFiber$abc123'] = { memoizedProps: { nothing: true } };
  const doc = { querySelector: () => null, querySelectorAll: () => [node] };

  const result = await x.readFiberEducationData(doc);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no-fiber-payload');
});

test('acquireEducationData falls through to the fiber when the fetch fails', async () => {
  const payload = loadFixture();
  const node = { nodeType: 1 };
  node['__reactFiber$abc123'] = { memoizedProps: { data: payload } };
  const doc = {
    readyState: 'complete',
    // With a token the fetch genuinely fires and genuinely fails, rather than
    // short-circuiting on a missing session token before it ever runs.
    cookie: 'rfc_v=abcdefghijklm',
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

test('acquireEducationData falls through to fiber when the endpoint times out', async () => {
  const payload = loadFixture();
  const node = { nodeType: 1 };
  node['__reactFiber$abc123'] = { memoizedProps: { data: payload } };
  const doc = {
    readyState: 'complete',
    cookie: 'rfc_v=abcdefghijklm',
    querySelector: () => null,
    querySelectorAll: () => [node],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }),
    body: { appendChild() {} },
  };
  const loaded = loadUserscript({
    document: doc,
    fetch: () => new Promise(() => {}),
  });
  const pending = loaded.exports.acquireEducationData(doc);
  loaded.advanceTimersBy(loaded.exports.FETCH_TIMEOUT_MS);
  const result = await pending;
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'fiber');
  assert.strictEqual(result.data.courses.size, 131);
});

test('acquireEducationData prefers the fetch and never consults the fiber on success', async () => {
  const payload = loadFixture();
  let fiberTouched = false;
  const doc = {
    readyState: 'complete',
    // fetchEducationData reads the ambient cookie jar to find the rfcv token.
    // Without this the adapter short-circuits on 'no-session-token', the fetch
    // never fires, and the assertion below silently stops being exercised.
    cookie: 'rfc_v=abcdefghijklm',
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
  const result = await x.acquireEducationData(doc);
  assert.strictEqual(result.ok, true, `fetch path failed: ${result.reason} — ${result.detail}`);
  assert.strictEqual(result.source, 'fetch');
  assert.strictEqual(fiberTouched, false, 'fiber was consulted despite a successful fetch');
});

test('acquireEducationData never rejects against a document that throws on every query', async () => {
  const doc = {
    readyState: 'complete',
    cookie: 'rfc_v=abcdefghijklm',
    // Every DOM query throws. init() awaits acquireEducationData with no catch
    // of its own, so a rejection escaping here would blank the panel rather
    // than explain itself.
    querySelector: () => { throw new Error('DOM exploded'); },
    querySelectorAll: () => { throw new Error('DOM exploded'); },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }),
    body: { appendChild() {} },
  };
  const { exports: x } = loadUserscript({
    document: doc,
    // Off the education page, so the module-level bootstrap does not fire
    // init() against this deliberately hostile document — this test is about
    // acquireEducationData alone.
    location: { pathname: '/index.php', search: '' },
    fetch: async () => { throw new Error('endpoint gone'); },
  });
  const result = await x.acquireEducationData(doc);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.triedFiber, true);
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
  assert.ok(!/undefined/.test(result.detail), `detail leaked an undefined: ${result.detail}`);
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
