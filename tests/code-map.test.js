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

// Matching against raw source text means a label is satisfiable by prose: a
// comment that happens to quote a signature verifies as though it were the
// declaration. That is not hypothetical — a review moved the `init()` row to a
// comment reading "But this is the function init()" 770 lines from the real
// declaration and every test here stayed green. So code rows match against a
// comment-stripped copy of the source, and only a row that says it is anchored
// to a comment may match one.
//
// Line-count-preserving, and quote-aware so `'https://…'` is not read as the
// start of a comment. Block-comment state carries across lines.
function stripComments(lines) {
  let inBlock = false;
  return lines.map((raw) => {
    let out = '';
    let quote = null;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      const next = raw[i + 1];
      if (inBlock) {
        if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
        i += 1; continue;
      }
      if (quote) {
        out += c;
        if (c === '\\') { out += next || ''; i += 2; continue; }
        if (c === quote) quote = null;
        i += 1; continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
      if (c === '/' && next === '/') break;               // rest of the line is comment
      if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
      out += c;
      i += 1;
    }
    return out;
  });
}

// The three kinds of row that are legitimately anchored to a comment: the
// userscript metadata header, the ENGINE/RUNTIME section markers, and any row
// whose cell says so in as many words. Everything else is code.
function labelAllowsComment(cell, probe) {
  return probe.startsWith('//') || probe.includes('─') || /\(comment\)/i.test(cell);
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

// Every line in the file the label could be pointing at. A label that matches
// more than one place does not identify anything, and an anchor is only
// trustworthy if it is the single answer to "where is this?".
function matchingLines(row, raw, stripped) {
  const src = labelAllowsComment(row.cell, row.probe) ? raw : stripped;
  const hits = [];
  for (let i = 0; i < src.length; i++) {
    if (matches(src[i], row.probe)) hits.push(i + 1);
  }
  return hits;
}

test('every code-map anchor points at the declaration it names', () => {
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  const stripped = stripComments(raw);
  const rows = anchorRows();
  assert.ok(rows.length > 50, `the map yielded only ${rows.length} anchored rows — the table shape may have changed`);

  const wrong = [];
  for (const row of rows) {
    const hits = matchingLines(row, raw, stripped);
    const inRange = hits.filter((n) => n >= row.start && n <= row.end);
    const span = `${row.start}${row.end !== row.start ? '-' + row.end : ''}`;
    if (inRange.length === 0) {
      wrong.push(`code-map.md:${row.mapLine} anchors "${row.probe.slice(0, 60)}" at ${span}, ` +
        `which reads: ${(raw[row.start - 1] || '(past end of file)').trim().slice(0, 60)}` +
        (hits.length ? ` — it is really at ${hits.join(', ')}` : ' — no line in the file matches it'));
    }
  }
  assert.deepStrictEqual(wrong, [], `stale code-map anchors:\n  ${wrong.join('\n  ')}`);
});

test('no code-map label matches more than one place in the file', () => {
  // An anchor that happens to be right is not the same as a label that can
  // only mean one thing. A label matching several lines can be moved to any
  // of them and still verify, which is how a wrong anchor survives a check.
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  const stripped = stripComments(raw);

  const ambiguous = [];
  for (const row of anchorRows()) {
    const hits = matchingLines(row, raw, stripped);
    const outside = hits.filter((n) => n < row.start || n > row.end);
    if (outside.length > 0) {
      ambiguous.push(`code-map.md:${row.mapLine} "${row.probe.slice(0, 50)}" also matches ` +
        `line${outside.length > 1 ? 's' : ''} ${outside.join(', ')} — quote enough to be unambiguous`);
    }
  }
  assert.deepStrictEqual(ambiguous, [], `ambiguous code-map labels:\n  ${ambiguous.join('\n  ')}`);
});

test('a declaration label cannot be satisfied by a comment quoting it', () => {
  // The exploit this closes: a row moved to prose that quotes the signature.
  const raw = [
    "  // The bootstrap calls it below. But this is the function init()",
    "  async function init() {",
    "  const url = 'https://example.invalid//not-a-comment';",
    "  /* function init() { */",
  ];
  const stripped = stripComments(raw);
  const probe = probeOf('`init()` — re-entrant');
  assert.strictEqual(matches(stripped[0], probe), false, 'a comment satisfied a declaration label');
  assert.strictEqual(matches(stripped[1], probe), true, 'the real declaration stopped verifying');
  assert.strictEqual(matches(stripped[3], probe), false, 'a block comment satisfied a declaration label');
  // The quote-awareness that keeps a URL from being read as a comment.
  assert.match(stripped[2], /example\.invalid\/\/not-a-comment/, 'a string literal was truncated at //');
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
