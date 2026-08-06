'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUserscript, loadFixture } = require('./load-userscript');
const { makeFakeDocument: sharedFakeDocument } = require('./fake-document');

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
// The cookie is passed rather than assumed, because the shared document has
// none by default — a token every document carried would reroute tests written
// for the tokenless path without failing any of them.
function makeFakeDocument() {
  return sharedFakeDocument({ cookie: 'rfc_v=abcdefghijklm' });
}

function makeIncompleteDocument() {
  const doc = makeFakeDocument();
  const body = doc.body;
  const documentElement = doc.documentElement;
  doc.readyState = 'loading';
  doc.body = null;
  doc.documentElement = null;
  return {
    doc,
    reveal() {
      doc.body = body;
      doc.documentElement = documentElement;
      doc.readyState = 'complete';
    },
  };
}

// A document that throws on every query but can still build and hold elements:
// exactly the case findMountPoint's try/catch exists for, and the only case in
// which the "could not read the page" error can be shown at all.
function hostileDocument() {
  const doc = makeFakeDocument();
  doc.querySelector = function () { throw new Error('host document is hostile'); };
  doc.querySelectorAll = function () { throw new Error('host document is hostile'); };
  return doc;
}

// A page that swallows whatever we append: querySelector never finds the panel,
// so every sync sees a missing panel and wants to remount. This is what the
// attempt cap is for.
function neverFindsDocument() {
  const doc = makeFakeDocument();
  doc.querySelector = function () { return null; };
  return doc;
}

function collectText(node, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.textContent === 'string' && node.textContent) acc.push(node.textContent);
  for (const child of node.children || []) collectText(child, acc);
  return acc;
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

test('a PDA webview with immutable history methods still performs the initial mount', async () => {
  const history = {};
  Object.defineProperties(history, {
    pushState: { value() {}, writable: false, enumerable: true },
    replaceState: { value() {}, writable: false, enumerable: true },
  });
  const doc = makeFakeDocument();
  const loaded = loadUserscript({ document: doc, fetch: okFetch, history });
  await flush();

  assert.ok(doc.querySelector('#tes-panel'),
    'patching immutable PDA history aborted bootstrap before the first panel');
  assert.strictEqual((loaded.win.listeners.popstate || []).length, 1,
    'the safer navigation signals were not installed after history patching failed');
  assert.strictEqual(loaded.observers.length, 1,
    'the MutationObserver fallback was not installed after history patching failed');
});

test('PDA bootstrap waits for body and documentElement, then mounts without a route signal', async () => {
  const incomplete = makeIncompleteDocument();
  let fetches = 0;
  const loaded = loadUserscript({
    document: incomplete.doc,
    fetch: async () => { fetches += 1; return okFetch(); },
  });
  await flush();
  assert.strictEqual(fetches, 0, 'bootstrap acquired data before the PDA DOM existed');
  assert.strictEqual(loaded.observers.length, 0, 'navigation observer installed without a root');

  incomplete.reveal();
  incomplete.doc.fire('DOMContentLoaded');
  await flush();

  assert.strictEqual(fetches, 1, 'DOM readiness did not trigger exactly one initial acquisition');
  assert.strictEqual(loaded.observers.length, 1, 'navigation observer was not installed after readiness');
  assert.ok(incomplete.doc.querySelector('#tes-panel'), 'the panel did not mount after the PDA DOM arrived');

  incomplete.doc.fire('DOMContentLoaded');
  loaded.win.fire('load');
  await flush();
  assert.strictEqual(fetches, 1, 'duplicate readiness signals mounted twice');
  assert.strictEqual(loaded.observers.length, 1, 'duplicate readiness signals installed two observers');
});

test('PDA bootstrap polling recovers when load already fired before injection', async () => {
  const incomplete = makeIncompleteDocument();
  incomplete.doc.readyState = 'complete';
  let fetches = 0;
  const loaded = loadUserscript({
    document: incomplete.doc,
    fetch: async () => { fetches += 1; return okFetch(); },
  });
  await flush();
  assert.strictEqual(fetches, 0);

  incomplete.reveal();
  loaded.advanceTimersBy(50);
  await flush();

  assert.strictEqual(fetches, 1, 'bounded polling did not recover the late-injected DOM');
  assert.ok(incomplete.doc.querySelector('#tes-panel'));
});

test('PDA DOM waiting stops cleanly when no usable document ever appears', async () => {
  const incomplete = makeIncompleteDocument();
  let fetches = 0;
  const loaded = loadUserscript({
    document: incomplete.doc,
    fetch: async () => { fetches += 1; return okFetch(); },
  });
  loaded.advanceTimersBy(15000);
  await flush();

  assert.strictEqual(fetches, 0);
  assert.strictEqual(loaded.pendingTimerCount(), 0, 'DOM readiness left an unbounded polling timer');
  assert.strictEqual((incomplete.doc.listeners.DOMContentLoaded || []).length, 0,
    'DOMContentLoaded listener survived terminal readiness timeout');
  assert.strictEqual((loaded.win.listeners.load || []).length, 0,
    'load listener survived terminal readiness timeout');
  assert.strictEqual(loaded.observers.length, 0);
});

test('a loading shell is visible while education acquisition is pending', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const doc = makeFakeDocument();
  const loaded = loadUserscript({
    document: doc,
    fetch: async () => { await held; return okFetch(); },
  });
  await flush();

  const loadingPanel = doc.querySelector('#tes-panel');
  assert.ok(loadingPanel, 'no shell appeared while the request was pending');
  assert.match(collectText(loadingPanel).join(' '), /loading education data/i);

  release();
  await flush();
  const finalPanel = doc.querySelector('#tes-panel');
  assert.ok(finalPanel, 'the loading shell was not replaced by the final panel');
  assert.doesNotMatch(collectText(finalPanel).join(' '), /loading education data/i);
});

test('the final panel follows a Torn host replacement during loading', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const doc = makeFakeDocument();
  const firstHost = doc.createElement('div');
  firstHost.isConnected = true;
  doc.selectors['[class*="educationPage___"]'] = firstHost;
  loadUserscript({ document: doc, fetch: async () => { await held; return okFetch(); } });
  await flush();
  assert.ok(firstHost.children.some((child) => child.id === 'tes-panel' && !child.removed),
    'loading shell did not use the initial education host');

  const replacementHost = doc.createElement('div');
  replacementHost.isConnected = true;
  firstHost.isConnected = false;
  doc.selectors['[class*="educationPage___"]'] = replacementHost;
  release();
  await flush();

  assert.ok(replacementHost.children.some((child) => child.id === 'tes-panel' && !child.removed),
    'final panel stayed in Torn\'s detached host');
  assert.ok(!firstHost.children.some((child) => child.id === 'tes-panel' && !child.removed),
    'a live loading shell remained in the detached host');
});

test('a fallback panel moves into Torn page flow when the inline host arrives late', async () => {
  const doc = makeFakeDocument();
  let fetches = 0;
  const loaded = loadUserscript({
    document: doc,
    fetch: async () => { fetches += 1; return okFetch(); },
  });
  await flush();
  assert.ok(doc.querySelector('#tes-fallback-mount'), 'the initial fallback did not mount');

  const inlineHost = doc.createElement('div');
  inlineHost.isConnected = true;
  doc.selectors['[class*="educationPage___"]'] = inlineHost;
  loaded.observers[0].cb([], loaded.observers[0]);
  loaded.runTimers();
  await flush();

  assert.strictEqual(doc.querySelector('#tes-fallback-mount'), null,
    'the fixed fallback remained after Torn provided an inline host');
  assert.ok(inlineHost.children.some((child) => child.id === 'tes-panel' && !child.removed),
    'the panel did not move into Torn page flow');
  assert.strictEqual(fetches, 2, 'moving inline did not perform exactly one fresh acquisition');
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
  const { win, observers, runTimers } = loadUserscript({ document: doc, fetch: countingFetch });
  await flush();
  assert.strictEqual(fetches, 1, 'the initial mount did not fetch exactly once');
  assert.strictEqual(observers.length, 1, 'the bootstrap installed no MutationObserver');

  // Both live signals, not just the back button: on a real page the observer is
  // the one that fires constantly.
  for (let i = 0; i < 20; i += 1) {
    observers[0].cb([], observers[0]);
    win.fire('popstate');
    runTimers();
    await flush();
  }
  assert.strictEqual(fetches, 1, 'a mounted panel re-fetched on DOM churn — this is a request storm against Torn');
});

test('a host document that throws on every query renders a named error rather than nothing', async () => {
  // The guard is only worth having if it produces the visible failure the repo
  // requires. Reverting findMountPoint's try/catch must fail THIS test — the
  // bootstrap's own .catch would otherwise absorb the rejection and leave a
  // blank page that no assertion notices.
  const hostile = hostileDocument();
  const { exports: x } = loadUserscript({ location: { search: '' }, document: hostile });
  const panel = await x.init();
  assert.ok(panel, 'init() drew nothing for a document it could still build elements in');
  const text = collectText(panel).join(' ');
  assert.match(text, /could not read the page/i, 'the failure was not named in the panel');
  assert.match(text, /hostile/, 'the underlying reason was not carried into the panel');
});

test('init() does not reject when the host document has nowhere left to draw', async () => {
  const nowhere = {
    readyState: 'complete',
    querySelector() { throw new Error('host document is hostile'); },
    querySelectorAll() { throw new Error('host document is hostile'); },
    createElement() { throw new Error('host document is hostile'); },
    addEventListener() {},
    get body() { throw new Error('host document is hostile'); },
  };
  // location.search is cleared so the bootstrap does not race this call; the
  // point of the test is that init() itself never rejects.
  const { exports: x } = loadUserscript({ location: { search: '' }, document: nowhere });
  await assert.doesNotReject(() => x.init(), 'init() rejected on a hostile document');
  assert.strictEqual(await x.init(), null, 'init() must resolve null when there is nowhere to draw');
});

test('a hostile document leaves the bootstrap with a visible error and no unhandled rejection', async () => {
  const rejections = [];
  const onUnhandled = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  let hostile;
  let win;
  try {
    hostile = hostileDocument();
    const loaded = loadUserscript({ document: hostile, fetch: okFetch });
    win = loaded.win;
    await flush();
    win.fire('popstate');
    loaded.runTimers();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepStrictEqual(rejections, [], 'the bootstrap produced an unhandled rejection');
  const text = collectText(hostile.body).join(' ');
  assert.match(text, /could not read the page/i, 'the bootstrap swallowed the failure silently');
});

test('a mount whose render lands after the player has left does not orphan the panel', async () => {
  // mounted is set synchronously but init() awaits the network. If the route
  // changes during that await, the unmount runs against a panel that does not
  // exist yet, and the late render would paste the panel onto an unrelated page
  // with nothing left to take it away.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const heldFetch = async () => { await held; return okFetch(); };
  const doc = makeFakeDocument();
  const { win, runTimers } = loadUserscript({ document: doc, fetch: heldFetch });
  await flush();
  const loadingPanel = doc.querySelector('#tes-panel');
  assert.ok(loadingPanel, 'the loading shell did not draw before the fetch resolved');
  assert.match(collectText(loadingPanel).join(' '), /loading education data/i);

  win.location.search = '?sid=crimes';
  win.fire('popstate');
  runTimers();
  await flush();

  release();
  await flush();

  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'a late render orphaned the panel on another page');
  assert.strictEqual(doc.querySelector('#tes-fallback-mount'), null, 'a late render orphaned the fallback mount on another page');

  // And it stays gone through further churn — the orphan must not be something
  // only the next navigation happens to clean up.
  win.fire('popstate');
  runTimers();
  await flush();
  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'the orphaned panel came back');
});

test('a re-render that drops the panel while the route never changed remounts it', async () => {
  const doc = makeFakeDocument();
  let fetches = 0;
  const countingFetch = async () => { fetches += 1; return okFetch(); };
  const { observers, runTimers } = loadUserscript({ document: doc, fetch: countingFetch });
  await flush();
  const panel = doc.querySelector('#tes-panel');
  assert.ok(panel, 'the panel never mounted');

  // Torn reconciles the container we mounted into and our node goes with it.
  panel.remove();
  assert.strictEqual(doc.querySelector('#tes-panel'), null);

  assert.strictEqual(observers.length, 1, 'the bootstrap installed no MutationObserver');
  observers[0].cb([], observers[0]);
  runTimers();
  await flush();

  assert.ok(doc.querySelector('#tes-panel'), 'a dropped panel was never remounted');
  assert.strictEqual(fetches, 2, 'the remount did not re-acquire, or acquired more than once');
});

test('a page the panel can never be found in stops remounting at the cap', async () => {
  const doc = neverFindsDocument();
  let fetches = 0;
  const countingFetch = async () => { fetches += 1; return okFetch(); };
  const { win, runTimers } = loadUserscript({ document: doc, fetch: countingFetch });
  await flush();

  for (let i = 0; i < 50; i += 1) {
    win.fire('popstate');
    runTimers();
    await flush();
  }
  assert.strictEqual(fetches, 20, 'the mount attempt cap did not hold — this loops for the whole session');

  // Leaving and returning is a new visit and gets a fresh budget.
  win.location.search = '?sid=crimes';
  win.fire('popstate');
  runTimers();
  await flush();
  win.location.search = '?sid=education';
  win.fire('popstate');
  runTimers();
  await flush();
  assert.strictEqual(fetches, 21, 'a new visit did not get a fresh mount budget');
});

test('churn while a mount is still in flight does not start a second acquisition', async () => {
  // The window between "mounted" and "the panel exists" is exactly when the
  // remount rule would otherwise see a missing panel and mount again, once per
  // debounce tick, for as long as the network takes.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const heldFetch = async () => { fetches += 1; await held; return okFetch(); };
  const doc = makeFakeDocument();
  const { win, observers, runTimers } = loadUserscript({ document: doc, fetch: heldFetch });
  await flush();
  assert.strictEqual(fetches, 1, 'the initial mount did not fetch exactly once');

  for (let i = 0; i < 5; i += 1) {
    observers[0].cb([], observers[0]);
    win.fire('popstate');
    runTimers();
    await flush();
  }
  assert.strictEqual(fetches, 1, 'churn during an in-flight mount started another acquisition');

  release();
  await flush();
  assert.ok(doc.querySelector('#tes-panel'), 'the in-flight mount never finished');
});

test('remounting does not stack fixed-position fallback containers', async () => {
  const doc = makeFakeDocument();
  const { observers, runTimers } = loadUserscript({ document: doc, fetch: okFetch });
  await flush();
  const panel = doc.querySelector('#tes-panel');
  assert.ok(panel, 'the panel never mounted');

  // The panel goes, our fallback mount stays — nothing in Torn's DOM owns it.
  panel.remove();
  observers[0].cb([], observers[0]);
  runTimers();
  await flush();

  const live = doc.body.children.filter((c) => c.id === 'tes-fallback-mount' && !c.removed);
  assert.strictEqual(live.length, 1, 'the remount left a second fixed-position container over the site');
});

test('a mount that had nowhere to draw does not latch the session with no panel', async () => {
  // init() resolves null rather than rejecting when it cannot create a mount,
  // so the bootstrap's rejection path never fires. Treating that as a
  // successful mount would leave mounted = true for the rest of the session:
  // no panel, no retry, no complaint.
  const doc = makeFakeDocument();
  const realAppend = doc.body.appendChild.bind(doc.body);
  let failuresLeft = 1;
  doc.body.appendChild = function (child) {
    if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('nowhere to draw'); }
    return realAppend(child);
  };

  const { win, runTimers } = loadUserscript({ document: doc, fetch: okFetch });
  await flush();
  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'the first mount was supposed to fail');

  win.fire('popstate');
  runTimers();
  await flush();
  assert.ok(doc.querySelector('#tes-panel'), 'a failed mount latched mounted = true and never retried');
});

test('leaving the page removes a fallback mount left behind by a mount that drew no panel', async () => {
  // init() attaches the fallback container before it renders, so a render that
  // fails afterwards resolves null with the container already on the page — and
  // with mounted correctly cleared. The unmount on the way out must not be
  // gated on that flag, or the empty div follows the player around the site.
  const doc = makeFakeDocument();
  const realCreate = doc.createElement;
  let allowed = 1; // enough for the fallback mount, not for the panel
  doc.createElement = function (tag) {
    if (allowed <= 0) throw new Error('cannot create elements any more');
    allowed -= 1;
    return realCreate(tag);
  };

  const { win, runTimers } = loadUserscript({ document: doc, fetch: okFetch });
  await flush();
  assert.strictEqual(doc.querySelector('#tes-panel'), null, 'the mount was supposed to draw no panel');
  const attached = () => doc.body.children.filter((c) => c.id === 'tes-fallback-mount' && !c.removed);
  assert.strictEqual(attached().length, 1, 'no fallback mount was left to clean up');

  win.location.search = '?sid=crimes';
  win.fire('popstate');
  runTimers();
  await flush();

  assert.strictEqual(attached().length, 0, 'a fallback mount was stranded on an unrelated page');
});

test('a sidebar click that only pushStates into education mounts the panel', async () => {
  // The signal that motivates the whole task: Torn navigates programmatically,
  // fires no popstate, and reloads nothing.
  const doc = makeFakeDocument();
  const { win, runTimers } = loadUserscript({ location: { search: '' }, document: doc, fetch: okFetch });
  await flush();
  assert.strictEqual(doc.querySelector('#tes-panel'), null);

  win.location.search = '?sid=education';
  win.history.pushState({}, '', '/page.php?sid=education');
  runTimers();
  await flush();
  assert.ok(doc.querySelector('#tes-panel'), 'the pushState signal never reached the bootstrap');
});

test('a route change Torn makes without touching history still mounts the panel', async () => {
  const doc = makeFakeDocument();
  const { win, observers, runTimers } = loadUserscript({ location: { search: '' }, document: doc, fetch: okFetch });
  await flush();
  assert.strictEqual(observers.length, 1, 'the bootstrap installed no MutationObserver');
  assert.strictEqual(doc.querySelector('#tes-panel'), null);

  win.location.search = '?sid=education';
  observers[0].cb([], observers[0]);
  runTimers();
  await flush();
  assert.ok(doc.querySelector('#tes-panel'), 'the MutationObserver signal never reached the bootstrap');
});
