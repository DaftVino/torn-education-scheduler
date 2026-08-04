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

process.env.TZ = 'UTC';

const SOURCE_PATH = path.join(__dirname, '..', 'torn-education-scheduler.user.js');

// Every name a test needs to reach. A function missing from this list is
// invisible to tests — add it here in the same commit that adds the function.
const EXPORT_NAMES = [
  'SCRIPT_VERSION', 'EDU_ENDPOINT', 'STORAGE_KEY',
  'isEducationPage',
];

function buildInstrumentedSource() {
  const original = fs.readFileSync(SOURCE_PATH, 'utf8');
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

  const documentStub = {
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, appendChild() {}, addEventListener() {},
      children: [], dataset: {},
    }),
    addEventListener: () => {},
    body: { appendChild() {} },
  };

  const windowStub = {
    location: { ...defaultLocation, ...(options.location || {}) },
    addEventListener: () => {},
    removeEventListener: () => {},
    fetch: options.fetch || (async () => { throw new Error('fetch not stubbed'); }),
    MutationObserver: class { observe() {} disconnect() {} },
  };

  const sandbox = {
    console,
    Date: MockDate,
    location: windowStub.location,
    window: windowStub,
    document: options.document || documentStub,
    fetch: windowStub.fetch,
    MutationObserver: windowStub.MutationObserver,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    GM_setValue: (k, v) => { gmStore.set(k, v); },
    GM_getValue: (k, d) => (gmStore.has(k) ? gmStore.get(k) : d),
    URL, Blob: class {}, JSON, Math, Object, Array, Promise, Map, Set, Error,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  return { sandbox, gmStore, setNow: (ms) => { currentNow = ms; } };
}

function loadUserscript(options = {}) {
  const { sandbox, gmStore, setNow } = makeSandbox(options);
  const context = vm.createContext(sandbox);
  vm.runInContext(buildInstrumentedSource(), context, { filename: 'torn-education-scheduler.user.js' });
  if (sandbox.__TES_ERR__) throw sandbox.__TES_ERR__;
  if (!sandbox.__TES__) throw new Error('Export injection failed: __TES__ not set');
  return { exports: sandbox.__TES__, sandbox, gmStore, setNow };
}

function loadFixture(name = 'education-init-data.json') {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

module.exports = { loadUserscript, loadFixture, EXPORT_NAMES, SOURCE_PATH };
