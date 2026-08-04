'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCE_PATH } = require('./load-userscript');

const MAP_PATH = path.join(__dirname, '..', 'docs', 'code-map.md');

// CLAUDE.md: "a stale anchor is worse than none, because it is trusted." Every
// session is told to grep this map and read the userscript in slices around
// the anchors it gives, so an anchor that points at the wrong declaration
// sends the next session to read the wrong code and believe it read the right
// code. That is a checkable property, so it is checked here rather than
// promised in a comment.
//
// The rule that matters: a row is verified against the FIRST backticked
// snippet in its label cell, not against any identifier anywhere in the row.
// An earlier hand-rolled verifier keyed on "does the anchor line contain the
// row's leading identifier", and was structurally blind to rows whose label is
// prose wrapping a call site rather than a declaration — the Bootstrap row,
// labelled with the call `observeNavigation(document, window, ...)`, happily
// matched `function observeNavigation(doc, win, handlers)` 360 lines away.
// Comparing the whole snippet in both directions is what separates the two:
// the call site is not a substring of the declaration, nor the reverse.
function probeOf(cell) {
  const m = cell.match(/`([^`]+)`/);
  return (m ? m[1] : cell).replace(/\s+/g, ' ').trim();
}

// A line only counts as "quoted by the map" if it is substantial enough to
// identify something. Without this, `})();` — and every bare closing brace in
// the file — is a substring of any label that happens to contain one, and the
// check silently accepts an anchor pointing at the wrong scope's close.
const MIN_QUOTED_LINE = 12;

// A label of the form `name` or `name(args)` names a declaration, so it must
// anchor to where that name is *declared*. Plain substring matching cannot
// tell `scheduleSync();` (a call, 50 lines up) from `function scheduleSync()`,
// and picking the call is the same class of error as anchoring a call site to
// its declaration — just in the other direction.
const DECLARATION_LABEL = /^[A-Za-z_$][\w$]*(\(.*\))?$/;

function declarationRe(name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])(async\\s+)?(function|const|let|var|class)\\s+${safe}([^\\w$]|$)`);
}

function matches(sourceLine, probe) {
  const line = sourceLine.replace(/\s+/g, ' ').trim();
  if (!line || !probe) return false;

  if (DECLARATION_LABEL.test(probe)) {
    const name = probe.replace(/\(.*$/, '');
    return declarationRe(name).test(line);
  }

  // Otherwise the label is prose, a marker, or a call-site snippet: either the
  // map quotes part of the line, or the line is part of what the map quotes.
  if (line.includes(probe)) return true;
  return line.length >= MIN_QUOTED_LINE && probe.includes(line);
}

function anchorRows() {
  const rows = [];
  const lines = fs.readFileSync(MAP_PATH, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\|\s*(.*?)\s*\|\s*(\d+)(?:[–-](\d+))?\s*\|\s*$/);
    if (!m) return;
    const cell = m[1];
    if (cell === 'Symbol' || cell === 'File' || /^-+$/.test(cell)) return;
    rows.push({
      mapLine: i + 1,
      cell: cell,
      probe: probeOf(cell),
      start: Number(m[2]),
      end: m[3] ? Number(m[3]) : Number(m[2]),
    });
  });
  return rows;
}

test('every code-map anchor points at the declaration it names', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  const rows = anchorRows();
  assert.ok(rows.length > 50, `the map yielded only ${rows.length} anchored rows — the table shape may have changed`);

  const wrong = [];
  for (const row of rows) {
    let ok = false;
    for (let i = row.start; i <= row.end && !ok; i++) {
      if (matches(src[i - 1] || '', row.probe)) ok = true;
    }
    if (!ok) {
      wrong.push(`code-map.md:${row.mapLine} anchors "${row.probe.slice(0, 60)}" at ` +
        `${row.start}${row.end !== row.start ? '-' + row.end : ''}, which reads: ` +
        `${(src[row.start - 1] || '(past end of file)').trim().slice(0, 60)}`);
    }
  }
  assert.deepStrictEqual(wrong, [], `stale code-map anchors:\n  ${wrong.join('\n  ')}`);
});

test('the anchor check tells a call site from its declaration, in both directions', () => {
  const declaration = '  function observeNavigation(doc, win, handlers) {';
  const callSite = '  observeNavigation(document, window, { onRouteChange: scheduleSync });';

  // The blindness that shipped: the Bootstrap row's label is the call site,
  // and a leading-identifier check passed it against the declaration 360
  // lines away.
  const callLabel = probeOf('Bootstrap: `observeNavigation(document, window, { onRouteChange: scheduleSync }); syncToRoute();`');
  assert.strictEqual(matches(callSite, callLabel), true, 'the real call site must verify');
  assert.strictEqual(matches(declaration, callLabel), false, 'the declaration must not satisfy a call-site label');

  // And the mirror image, which a plain substring rule also gets wrong: a
  // declaration label must not be satisfied by a call to it.
  const declLabel = probeOf('`scheduleSync()` — 150 ms debounce');
  assert.strictEqual(matches('  function scheduleSync() {', declLabel), true, 'the declaration must verify');
  assert.strictEqual(matches('    scheduleSync();', declLabel), false, 'a bare call must not satisfy a declaration label');

  // A bare closing brace must never satisfy a label that happens to contain one.
  assert.strictEqual(matches('  }', probeOf('IIFE close `})();`')), false, 'a stray brace satisfied a label');
});

test('the code-map records the userscript length it was generated against', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  // A trailing newline yields a final empty element; the file's line count is
  // what an editor would report.
  const lineCount = src.length - (src[src.length - 1] === '' ? 1 : 0);
  const map = fs.readFileSync(MAP_PATH, 'utf8');
  const m = map.match(/torn-education-scheduler\.user\.js`?\s*\((\d+) lines\)/);
  assert.ok(m, 'the code-map header no longer states the file length');
  assert.strictEqual(
    Number(m[1]), lineCount,
    'the code-map was generated against a different revision of the userscript',
  );
});
