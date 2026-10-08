'use strict';

/*
 * Non-invasive test harness for torn-education-scheduler.user.js
 * -------------------------------------------------------------
 * The production userscript is a single IIFE that keeps its helpers private.
 * To exercise them from Node without touching the file on disk we:
 *   1. Read the production source verbatim.
 *   2. Inject (IN MEMORY ONLY) an export statement immediately before the final
 *      `})();` so the IIFE publishes its internals onto the sandbox global.
 *   3. Run the modified-in-memory source in a `vm` context with mocked globals.
 *
 * Adapted from the same pattern in Torn Bookie Live Scores.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Default to UTC so every test sees the same clock — but let a test that is
// specifically about timezone handling pin its own. tests/timezone.test.js
// exists to catch a local-getter regression, which is invisible on a UTC
// machine, including CI.
process.env.TZ = process.env.TZ || 'UTC';

const SOURCE_PATH = path.join(__dirname, '..', 'torn-education-scheduler.user.js');

// Every name a test needs to reach. A function missing from this list is
// invisible to tests — add it here in the same commit that adds the function.
const EXPORT_NAMES = [
  'SCRIPT_VERSION', 'EDU_ENDPOINT', 'STORAGE_KEY',
  'isEducationPage',
  // payload
  'PayloadError', 'parsePayload',
  // rfcv token
  'readRfcvToken',
  // prerequisites
  'unmetPrerequisites', 'validateQueue', 'requiredCoursesFor', 'allRemainingCourses',
  'canMoveQueueCourse', 'moveQueueCourse',
  'plannedCompletions',
  // the picker's all-remaining sentinel
  'ALL_COURSES_OPTION', 'GUIDE_PRESETS', 'guidePresetForValue', 'expandGuidePreset',
  // schedule
  'schedule', 'buildDegreeGrid',
  // queue ordering
  'ORDER_MODE_LABELS', 'orderQueue', 'dependentCount', 'upstreamOf',
  // focus taxonomy
  'FOCUS_TAXONOMY', 'focusRegistry', 'FOCUS_CATEGORIES',
  // working stats
  'WORKING_STATS', 'WORKING_STAT_RE', 'workingStatsFor', 'bonusLabel',
  // focus scoring
  'focusKey', 'focusScores', 'balancedScores', 'FOCUS_WORKING_STATS', 'focusTotals', 'pathGains', 'FOCUS_UNSTATABLE',
  // storage
  'freshPlan', 'loadPlan', 'savePlan',
  // settings
  'SETTINGS_KEY', 'normaliseSettings', 'settingsDefaults', 'freshSettings', 'loadSettings', 'saveSettings',
  'normaliseFocuses', 'toggleFocus', 'setFocusPriority',
  // perks
  'inferPerks',
  // the share string — the only input this script parses from outside the
  // player's own browser
  'SHARE_PREFIX', 'encodePlan', 'decodePlan', 'FOCUS_CONCAT_INDEX',
  // consumables: the Books ceiling, the floor date, and what it costs
  'SECONDS_PER_BOOK', 'SECONDS_PER_JOB_POINT', 'booksCeiling', 'planConsumables', 'formatMoney',
  // adapter
  'FETCH_TIMEOUT_MS', 'fetchEducationData',
  // acquisition
  'looksLikePayload', 'searchForPayload', 'newWalkState', 'fiberRootsFrom', 'readFiberEducationData', 'acquireEducationData',
  // panel
  'formatDate', 'formatTime', 'formatDuration', 'buildPanelModel', 'loadingModel', 'findMountPoint', 'renderPanel', 'init',
  // panel stylesheet — test-only, so a rule's colour can be asserted without
  // a DOM to read the injected <style> element back out of
  'panelStyleText',
  // errorModel/noopHandlers are exported as a pair: the render path treats
  // noopHandlers by identity, so a test asserting that needs the real object.
  'errorModel', 'noopHandlers',
  // views
  'renderScheduleView', 'renderSettingsView', 'renderGridView', 'renderFocusView',
  // reset control (arm/confirm), wired into schedule/focus/settings' nav row
  'resetButton',
  // navigation
  'unmountPanel', 'observeNavigation', 'whenDocumentReady',
  // debug report and published guide links
  // isResolvedUrl remains with the two URLs it guards (§ K1), so a future
  // placeholder cannot accidentally render as a real link.
  'GREASY_FORK_URL', 'FORUM_POST_URL', 'isResolvedUrl', 'buildDebugReport', 'gatherDebugContext',
];

// The § K1 launch URLs are module-level consts inside the IIFE, closed over by
// every renderer that reads them. These test-only replacements exercise both a
// known alternate URL and the unresolved fallback without changing the guard
// token itself.
const RESOLVED_GREASY_FORK_URL = 'https://greasyfork.org/en/scripts/123456-torn-education-scheduler';
const RESOLVED_FORUM_POST_URL = 'https://www.torn.com/forums.php#p=threads&f=61&t=16589908&b=0&a=0';
const UNRESOLVED_FORUM_POST_URL = 'https://www.torn.com/forums.php#REPLACE_BEFORE_LAUNCH';

function replaceLaunchUrl(source, name, url) {
  const pattern = new RegExp(`const ${name} = (?:\`[^\`]*\`|'[^']*'|"[^"]*");`);
  if (!pattern.test(source)) {
    throw new Error(`${name} is not a simple string literal — update replaceLaunchUrl`);
  }
  return source.replace(pattern, `const ${name} = ${JSON.stringify(url)};`);
}

function resolveLaunchUrls(source) {
  let out = replaceLaunchUrl(source, 'GREASY_FORK_URL', RESOLVED_GREASY_FORK_URL);
  out = replaceLaunchUrl(out, 'FORUM_POST_URL', RESOLVED_FORUM_POST_URL);
  return out;
}

function buildInstrumentedSource(options = {}) {
  let original = fs.readFileSync(SOURCE_PATH, 'utf8');
  if (options.resolveLaunchUrls) original = resolveLaunchUrls(original);
  if (options.unresolveForumPostUrl) {
    original = replaceLaunchUrl(original, 'FORUM_POST_URL', UNRESOLVED_FORUM_POST_URL);
  }
  const marker = '})();';
  const idx = original.lastIndexOf(marker);
  if (idx === -1) throw new Error('Could not find IIFE close marker in production source');
  const pairs = EXPORT_NAMES
    .map((n) => `${JSON.stringify(n)}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`)
    .join(', ');
  const injection = `\n;try { globalThis.__TES__ = { ${pairs} }; } catch (e) { globalThis.__TES_ERR__ = e; }\n`;
  return original.slice(0, idx) + injection + original.slice(idx);
}

function makeSandbox(options = {}) {
  let currentNow = options.now ?? Date.UTC(2026, 0, 1, 0, 0, 0);

  class MockDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(currentNow);
      else super(...args);
    }
    static now() { return currentNow; }
  }

  const gmStore = new Map();

  const defaultLocation = {
    origin: 'https://www.torn.com',
    hostname: 'www.torn.com',
    pathname: '/page.php',
    href: 'https://www.torn.com/page.php?sid=education',
    search: '?sid=education',
    hash: '',
  };

  const documentListeners = {};
  const documentStub = {
    readyState: 'complete',
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, appendChild() {}, addEventListener() {},
      children: [], dataset: {},
    }),
    addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = documentListeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    fire(type) { for (const fn of (documentListeners[type] || []).slice()) fn({ type }); },
    listeners: documentListeners,
    body: { appendChild() {} },
  };

  // A real listener registry, not a no-op: observeNavigation() installs a
  // popstate listener and history patches, and the navigation tests have to be
  // able to fire them. `fire` is the test-side trigger.
  const historyStub = options.history || {
    pushState() {}, replaceState() {},
  };
  const observers = [];
  const windowStub = {
    location: { ...defaultLocation, ...(options.location || {}) },
    history: historyStub,
    listeners: {},
    addEventListener(type, fn) { (windowStub.listeners[type] = windowStub.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = windowStub.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    fire(type) { for (const fn of (windowStub.listeners[type] || []).slice()) fn({ type }); },
    fetch: options.fetch || (async () => { throw new Error('fetch not stubbed'); }),
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    },
  };

  // Deterministic timers. PDA readiness, navigation debounce and endpoint
  // timeout use materially different delays; treating them as one undated bag
  // lets a navigation test accidentally fire a network timeout too.
  let nextTimerId = 1;
  let timerNow = 0;
  const timers = new Map();
  const runTimers = () => {
    if (timers.size === 0) return;
    const nextDue = Math.min(...Array.from(timers.values(), (timer) => timer.due));
    timerNow = Math.max(timerNow, nextDue);
    const due = Array.from(timers.entries())
      .filter(([, timer]) => timer.due <= timerNow)
      .sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
    for (const [id, timer] of due) {
      timers.delete(id);
      if (typeof timer.fn === 'function') timer.fn();
    }
  };
  const advanceTimersBy = (ms) => {
    const target = timerNow + Math.max(0, Number(ms) || 0);
    while (timers.size > 0) {
      const nextDue = Math.min(...Array.from(timers.values(), (timer) => timer.due));
      if (nextDue > target) break;
      timerNow = nextDue;
      runTimers();
    }
    timerNow = target;
  };

  const sandbox = {
    console,
    Date: MockDate,
    location: windowStub.location,
    window: windowStub,
    history: historyStub,
    document: options.document || documentStub,
    fetch: windowStub.fetch,
    MutationObserver: windowStub.MutationObserver,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.set(id, { fn, due: timerNow + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    GM_setValue: (k, v) => { gmStore.set(k, v); },
    GM_getValue: (k, d) => (gmStore.has(k) ? gmStore.get(k) : d),
    URL, URLSearchParams, Blob: class {}, JSON, Math, Object, Array, Promise, Map, Set, Error,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  return {
    sandbox, gmStore, setNow: (ms) => { currentNow = ms; }, win: windowStub,
    observers, runTimers, advanceTimersBy, pendingTimerCount: () => timers.size,
  };
}

function loadUserscript(options = {}) {
  const {
    sandbox, gmStore, setNow, win, observers, runTimers, advanceTimersBy, pendingTimerCount,
  } = makeSandbox(options);
  const context = vm.createContext(sandbox);
  vm.runInContext(buildInstrumentedSource(options), context, { filename: 'torn-education-scheduler.user.js' });
  if (sandbox.__TES_ERR__) throw sandbox.__TES_ERR__;
  if (!sandbox.__TES__) throw new Error('Export injection failed: __TES__ not set');

  // Capture the VM realm's prototypes by creating sample objects in the VM
  // and extracting their prototype. This ensures we detect objects actually
  // created inside the VM, even though the Object constructor was injected from main context.
  const vmProtos = vm.runInContext(`
    (function() {
      return {
        objectProto: Object.getPrototypeOf({}),
        arrayProto: Object.getPrototypeOf([])
      };
    })()
  `, context);
  const vmObjectProto = vmProtos.objectProto;
  const vmArrayProto = vmProtos.arrayProto;

  function transformFromVM(value) {
    // Only transform objects whose prototypes are from the VM realm.
    // Everything else (Promises, thenables, DOM-like objects, main-realm stubs)
    // passes through untouched to preserve identity and awaitable behavior.
    if (value === null || typeof value !== 'object') return value;

    // Thenables (including Promises) must pass through untouched so they remain awaitable
    if (typeof value.then === 'function') return value;

    // Handle collections built from main-realm constructors (injected into VM sandbox)
    if (value instanceof Map) {
      const newMap = new Map();
      for (const [k, v] of value) {
        newMap.set(transformFromVM(k), transformFromVM(v));
      }
      return newMap;
    }
    if (value instanceof Set) {
      const newSet = new Set();
      for (const v of value) {
        newSet.add(transformFromVM(v));
      }
      return newSet;
    }

    // Only reconstruct objects that actually have VM realm prototypes.
    // If the prototype is from the main context, it's a stub or external object
    // that we must not copy (to preserve identity for strictEqual assertions).
    const proto = Object.getPrototypeOf(value);
    if (proto === vmArrayProto) {
      // Array created inside the VM - reconstruct in main context
      const arr = [];
      for (const item of value) {
        arr.push(transformFromVM(item));
      }
      return arr;
    }
    if (proto === vmObjectProto) {
      // Plain object created inside the VM - reconstruct in main context
      const result = {};
      for (const key of Object.keys(value)) {
        result[key] = transformFromVM(value[key]);
      }
      return result;
    }

    // Otherwise, leave it alone (it's from the main context or is a built-in like Error/Date)
    return value;
  }

  function wrapExports(vmExports) {
    const wrapped = {};
    for (const [key, value] of Object.entries(vmExports)) {
      if (typeof value === 'function') {
        wrapped[key] = function(...args) {
          const result = value.apply(this, args);
          return transformFromVM(result);
        };
      } else {
        wrapped[key] = value;
      }
    }
    return wrapped;
  }

  // Expose test utilities for guards that need to directly test transformFromVM
  const runInVm = (expr) => vm.runInContext(expr, context);

  return {
    exports: wrapExports(sandbox.__TES__),
    sandbox,
    win,
    observers,
    runTimers,
    advanceTimersBy,
    pendingTimerCount,
    gmStore,
    setNow,
    transform: transformFromVM,
    runInVm,
  };
}

function loadFixture(name = 'education-init-data.json') {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

module.exports = {
  loadUserscript, loadFixture, EXPORT_NAMES, SOURCE_PATH,
  RESOLVED_GREASY_FORK_URL, RESOLVED_FORUM_POST_URL,
};
