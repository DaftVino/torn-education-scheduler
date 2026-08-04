'use strict';

/*
 * One fake DOM, shared.
 * ---------------------
 * Three test files grew their own copy of this, and they drifted: only one of
 * them modelled what a <select> reports before anyone touches it, which is how
 * a picker defaulting to "queue all 115 courses" reached review. A second,
 * weaker copy of a shared harness is the same failure the comment stripper had
 * earlier in this release, so this file exists for the same reason
 * `tests/strip-comments.js` does: there is one of it.
 *
 * The union of what the three copies could do, never the intersection:
 *   - an id-aware `querySelector` over a registry of created elements,
 *   - `attributes` recorded by `setAttribute` *and* mirrored onto the element
 *     (debug-report asserts on the map, panel.test.js reads the property),
 *   - `documentElement`, `readyState`, `querySelectorAll` and a document-level
 *     `addEventListener`, for the navigation tests,
 *   - an optional session cookie, off by default — a document that silently
 *     carried one would send tests through the fetch path they were written to
 *     avoid, and they would still pass, for the wrong reason.
 *
 * It is a stub, not a DOM: no layout, no event dispatch, no live collections.
 * Everything it does model, it models the way a browser does, because the value
 * of this harness is entirely in the divergences it refuses to have.
 */

// A browser resolves `select.value` from its options; it is not a field.
// Reading:
//   - the LAST option marked selected (a single-select keeps one, and a later
//     `selected` wins over an earlier one),
//   - else the first option (the "ask for a reset" step, which is why an
//     untouched picker submits whatever sits at the top),
//   - else ''.
// Writing `select.value = v` selects the first option whose value is String(v)
// and reports '' when nothing matches — it does not store the string. The one
// exception this models is the reset: appending an option while nothing is
// selected selects it, so an unmatched write does not survive the next append.
function defineSelectValue(el) {
  let written = null;
  let optionsAtWrite = 0;
  Object.defineProperty(el, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      const options = this.children;
      if (written !== null) {
        const match = options.find((o) => o.value === written);
        if (match) return match.value;
        // Nothing matched. A browser leaves selectedIndex at -1 and reports ''
        // until an option is appended, at which point the reset step selects
        // one and the failed write is forgotten.
        if (options.length <= optionsAtWrite) return '';
      }
      const selected = options.filter((o) => o.selected === true);
      if (selected.length > 0) return selected[selected.length - 1].value;
      return options.length > 0 ? options[0].value : '';
    },
    set(v) {
      written = String(v);
      optionsAtWrite = this.children.length;
    },
  });
}

function makeFakeDocument(options) {
  const settings = options || {};
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
      attributes: {},
      children: [],
      listeners: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, val) { this.attributes[name] = val; this[name] = val; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      remove() { this.removed = true; },
    };
    if (tag === 'select') defineSelectValue(el);
    registry.push(el);
    return el;
  }

  const body = makeElement('body');
  const doc = {
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
    registry: registry,
  };
  // Only when asked for. fetchEducationData reads the cookie jar to decide
  // whether to fire a request at all, so handing every document a session
  // token would quietly reroute tests written for the tokenless path.
  if (settings.cookie !== undefined) doc.cookie = settings.cookie;
  return doc;
}

module.exports = { makeFakeDocument };
