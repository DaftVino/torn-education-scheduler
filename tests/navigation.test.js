'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');

function fakeDoc() {
  const removed = [];
  const nodes = {};
  return {
    removed,
    nodes,
    readyState: 'complete',
    querySelector(sel) { return nodes[sel] || null; },
    querySelectorAll() { return []; },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }),
    addEventListener() {},
    body: { appendChild() {} },
    documentElement: {},
  };
}

// observeNavigation installs at most once per window, and the bootstrap has
// already claimed the sandbox window by the time a test runs. The unit tests
// below therefore need a window nothing has installed on yet, or every install
// under test would be the no-op second install. The shape mirrors the sandbox's
// windowStub deliberately — the bootstrap tests further down exercise the real
// one.
function fakeWin() {
  const listeners = {};
  return {
    listeners,
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    fire(type) { for (const fn of (listeners[type] || []).slice()) fn({ type }); },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() {}
      disconnect() {}
    },
  };
}

// A document rich enough for init() to draw into: id-aware querySelector over a
// registry of created elements, plus the session cookie the fetch path needs.
function makeFakeDocument() {
  const registry = [];
  function makeElement(tag) {
    const el = {
      tagName: tag,
      id: '',
      className: '',
      textContent: '',
      value: '',
      style: {},
      dataset: {},
      children: [],
      listeners: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, val) { this[name] = val; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      remove() { this.removed = true; },
    };
    registry.push(el);
    return el;
  }
  const body = makeElement('body');
  return {
    cookie: 'rfc_v=abcdefghijklm',
    readyState: 'complete',
    documentElement: makeElement('html'),
    createElement: makeElement,
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        const id = sel.slice(1);
        return registry.find((el) => el.id === id && !el.removed) || null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: body,
  };
}

const okFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(loadFixture()) });

// init() is async and awaits the acquisition chain; a route change only starts
// it. Drain the microtask queue across a few macrotasks before asserting.
async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('unmountPanel removes the panel and the fallback mount, and tolerates neither existing', () => {
  const { exports: x } = loadUserscript();
  const doc = fakeDoc();
  assert.doesNotThrow(() => x.unmountPanel(doc));

  let panelRemoved = false;
  let mountRemoved = false;
  doc.nodes['#tes-panel'] = { remove() { panelRemoved = true; } };
  doc.nodes['#tes-fallback-mount'] = { remove() { mountRemoved = true; } };
  x.unmountPanel(doc);
  assert.strictEqual(panelRemoved, true);
  assert.strictEqual(mountRemoved, true);
});

test('unmountPanel survives a document that throws on querySelector', () => {
  const { exports: x } = loadUserscript();
  const hostile = { querySelector() { throw new Error('hostile'); } };
  assert.doesNotThrow(() => x.unmountPanel(hostile));
  assert.doesNotThrow(() => x.unmountPanel(null));
});

test('observeNavigation fires onRouteChange for pushState, replaceState and popstate', () => {
  const { exports: x } = loadUserscript();
  const doc = fakeDoc();
  const win = fakeWin();
  let calls = 0;
  const stop = x.observeNavigation(doc, win, { onRouteChange() { calls += 1; } });

  win.history.pushState({}, '', '/page.php?sid=education');
  assert.strictEqual(calls, 1, 'pushState did not notify');

  win.history.replaceState({}, '', '/page.php?sid=education');
  assert.strictEqual(calls, 2, 'replaceState did not notify');

  win.fire('popstate');
  assert.strictEqual(calls, 3, 'popstate did not notify');

  stop();
  win.fire('popstate');
  win.history.pushState({}, '', '/page.php?sid=education');
  assert.strictEqual(calls, 3, 'disconnect() did not stop notifications');
});

test('observeNavigation installs only once per window', () => {
  const { exports: x } = loadUserscript();
  const doc = fakeDoc();
  const win = fakeWin();
  let calls = 0;
  x.observeNavigation(doc, win, { onRouteChange() { calls += 1; } });
  x.observeNavigation(doc, win, { onRouteChange() { calls += 1; } });
  win.fire('popstate');
  assert.strictEqual(calls, 1, 'the second install duplicated the listener');
});

test('observeNavigation survives a window with no history object', () => {
  const { exports: x } = loadUserscript();
  const doc = fakeDoc();
  const bare = { addEventListener() {}, removeEventListener() {} };
  assert.doesNotThrow(() => x.observeNavigation(doc, bare, { onRouteChange() {} }));
});

test('observeNavigation notifies on a DOM mutation, and a throwing handler does not break navigation', () => {
  const { exports: x } = loadUserscript();
  const doc = fakeDoc();
  const win = fakeWin();
  let calls = 0;
  const created = [];
  win.MutationObserver = class {
    constructor(cb) { this.cb = cb; created.push(this); }
    observe() {}
    disconnect() {}
  };
  x.observeNavigation(doc, win, { onRouteChange() { calls += 1; throw new Error('bad handler'); } });

  assert.strictEqual(created.length, 1, 'no MutationObserver was installed');
  assert.doesNotThrow(() => created[0].cb([], created[0]), 'a throwing handler escaped the observer callback');
  assert.strictEqual(calls, 1);
  assert.doesNotThrow(() => win.fire('popstate'), 'a throwing handler escaped the popstate listener');
  assert.strictEqual(calls, 2);
});

test('the bootstrap installs the navigation observer exactly once on load', () => {
  const { win } = loadUserscript({ location: { search: '' }, document: makeFakeDocument() });
  assert.strictEqual((win.listeners.popstate || []).length, 1, 'the bootstrap did not install a popstate listener');
});

test('arriving at the education page without a reload mounts the panel', async () => {
  const doc = makeFakeDocument();
  // Loaded somewhere else in Torn: @run-at document-idle has already fired and
  // the panel is correctly absent.
  const { win, runTimers } = loadUserscript({ location: { search: '' }, document: doc, fetch: okFetch });
  await flush();
  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'the panel mounted off the education page');

  win.location.search = '?sid=education';
  win.fire('popstate');
  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'the route change was not debounced');
  runTimers();
  await flush();

  assert.ok(doc.querySelector('#tes-fallback-mount'), 'no mount was created on arrival');
  assert.ok(doc.querySelector('#tes-panel'), 'the panel did not mount on arrival');
});

test('leaving the education page unmounts the panel', async () => {
  const doc = makeFakeDocument();
  const { win, runTimers } = loadUserscript({ document: doc, fetch: okFetch });
  await flush();
  assert.ok(doc.querySelector('#tes-panel'), 'the panel never mounted on load');

  win.location.search = '?sid=crimes';
  win.fire('popstate');
  runTimers();
  await flush();

  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'the panel outlived the education page');
  assert.strictEqual(doc.querySelector('#tes-fallback-mount'), null, 'the fallback mount outlived the education page');
});

test('observer churn while already mounted does not re-acquire the data', async () => {
  const doc = makeFakeDocument();
  let fetches = 0;
  const countingFetch = async (...args) => { fetches += 1; return okFetch(...args); };
  const { win, runTimers } = loadUserscript({ document: doc, fetch: countingFetch });
  await flush();
  assert.strictEqual(fetches, 1, 'the initial mount did not fetch exactly once');

  for (let i = 0; i < 20; i += 1) {
    win.fire('popstate');
    runTimers();
  }
  await flush();
  assert.strictEqual(fetches, 1, 'a mounted panel re-fetched on DOM churn — this is a request storm against Torn');
});

test('init() does not reject when the host document throws on every query', async () => {
  const hostile = {
    readyState: 'complete',
    querySelector() { throw new Error('host document is hostile'); },
    querySelectorAll() { throw new Error('host document is hostile'); },
    createElement() { throw new Error('host document is hostile'); },
    addEventListener() {},
    get body() { throw new Error('host document is hostile'); },
  };
  // location.search is cleared so the bootstrap does not race this call; the
  // point of the test is that init() itself never rejects.
  const { exports: x } = loadUserscript({ location: { search: '' }, document: hostile });
  await assert.doesNotReject(() => x.init(), 'init() rejected on a hostile document');
});

test('a hostile document does not leave the bootstrap with an unhandled rejection', async () => {
  const rejections = [];
  const onUnhandled = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const hostile = {
      readyState: 'complete',
      querySelector() { throw new Error('host document is hostile'); },
      querySelectorAll() { throw new Error('host document is hostile'); },
      createElement() { throw new Error('host document is hostile'); },
      addEventListener() {},
      get body() { throw new Error('host document is hostile'); },
    };
    const { win, runTimers } = loadUserscript({ document: hostile });
    await flush();
    win.fire('popstate');
    runTimers();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepStrictEqual(rejections, [], 'the bootstrap produced an unhandled rejection');
});
