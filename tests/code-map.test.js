'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCE_PATH } = require('./load-userscript');
const { stripComments } = require('./strip-comments');

const MAP_PATH = path.join(__dirname, '..', 'docs', 'code-map.md');

// CLAUDE.md: "a stale anchor is worse than none, because it is trusted." Every
// session is told to grep this map and read the userscript in slices around
// the anchors it gives, so an anchor that points at the wrong declaration
// sends the next session to read the wrong code and believe it read the right
// code. That is a checkable property, so it is checked here rather than
// promised in a comment.
//
// The invariant every rule below serves: **a row must be satisfiable by
// exactly one place in the file, and that place must be where a reader would
// go to find what the row names.** Everything else here — the declaration
// rule, comment stripping, uniqueness, range exactness, checking every symbol
// a label names rather than the first — is a way of failing an anchor that
// satisfies the letter of "it matches" while sending a reader somewhere
// useless. Each was added after an attack that did exactly that; see
// `rowProbes` and the tests below for which rule answers which.
//
// (This header claimed a mechanism — "a row is verified against the FIRST
// backticked snippet" — until the multi-symbol fix made it false, and it
// disagreed with `rowProbes` a few dozen lines down for a commit. It is stated
// as an invariant now for the reason the userscript's renderPanel comment
// gives. Written up in the same round that hunted four instances of the class
// elsewhere: the rule is easy to apply to someone else's comments and hard to
// apply to your own.)
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
// The stripper is the one tests/purity.test.js uses, not a copy: it is a full
// eight-mode scanner with regex-literal tracking, and a simpler copy that
// lived here was defeated by both `const re = /['"]/; // comment` (comment
// left standing) and a regex literal containing a slash-star (every following
// line swallowed). See tests/strip-comments.js for why there is only one.
// Line numbers survive stripping, so a reported location is the real one.
function strippedLines(raw) {
  return stripComments(raw.join('\n')).split('\n');
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

// A row's *label* is everything before the first em dash; the prose after it
// may name any symbol it likes without claiming to be anchored to it. Rows
// routinely document several declarations at once — `mounted` / `inFlight` /
// `generation` / `attempts` / `pending` is one row covering five lines — and
// checking only the first backticked snippet verified one symbol in five.
// Demonstrated: the TRI_STATE_OPTIONS row could be shrunk to drop
// `triStateField` entirely and stay green.
//
// Secondary symbols are only enforced when they are declaration-shaped AND
// actually declared somewhere, so prose backticks in the label — `null`, `#`,
// `@grant` — are ignored rather than turned into impossible requirements.
function rowProbes(cell, stripped) {
  const label = cell.split(/\s+—\s+/)[0];
  const snippets = (label.match(/`[^`]+`/g) || []).map((s) => s.slice(1, -1).replace(/\s+/g, ' ').trim());
  const primary = probeOf(cell);
  const probes = [{ text: primary, allowComment: labelAllowsComment(cell, primary) }];
  for (const s of snippets.slice(1)) {
    if (!DECLARATION_LABEL.test(s)) continue;
    const re = declarationRe(s.replace(/\(.*$/, ''));
    if (!stripped.some((line) => re.test(line))) continue;
    probes.push({ text: s, allowComment: false });
  }
  return probes;
}

function anchorRows(stripped) {
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
      probes: rowProbes(cell, stripped),
      start: Number(m[2]),
      end: m[3] ? Number(m[3]) : Number(m[2]),
    });
  });
  return rows;
}

// Every line in the file a label could be pointing at. A label that matches
// more than one place does not identify anything, and an anchor is only
// trustworthy if it is the single answer to "where is this?".
function hitsFor(probe, raw, stripped) {
  const src = probe.allowComment ? raw : stripped;
  const hits = [];
  for (let i = 0; i < src.length; i++) {
    if (matches(src[i], probe.text)) hits.push(i + 1);
  }
  return hits;
}

function matchingLines(row, raw, stripped) {
  const all = new Set();
  for (const probe of row.probes) for (const n of hitsFor(probe, raw, stripped)) all.add(n);
  return Array.from(all).sort((a, b) => a - b);
}

test('every code-map anchor points at the declaration it names', () => {
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  const stripped = strippedLines(raw);
  const rows = anchorRows(stripped);
  assert.ok(rows.length > 50, `the map yielded only ${rows.length} anchored rows — the table shape may have changed`);

  const wrong = [];
  for (const row of rows) {
    const span = `${row.start}${row.end !== row.start ? '-' + row.end : ''}`;
    // Every symbol the label names, not just the first.
    for (const probe of row.probes) {
      const hits = hitsFor(probe, raw, stripped);
      if (hits.some((n) => n >= row.start && n <= row.end)) continue;
      wrong.push(`code-map.md:${row.mapLine} anchors "${probe.text.slice(0, 60)}" at ${span}, ` +
        `which reads: ${(raw[row.start - 1] || '(past end of file)').trim().slice(0, 60)}` +
        (hits.length ? ` — it is really at ${hits.join(', ')}` : ' — no line in the file matches it'));
    }
  }
  assert.deepStrictEqual(wrong, [], `stale code-map anchors:\n  ${wrong.join('\n  ')}`);
});

test('a code-map range is exactly the lines it documents, not a net cast wide', () => {
  // Nothing else bounds range width: `| init() | 1-1933 |` contains every
  // matching line and would otherwise pass, sending a reader to the right
  // code but with no useful precision. The range must be the span of what the
  // label names — first named line to last, nothing spare on either side.
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  const stripped = strippedLines(raw);

  const loose = [];
  for (const row of anchorRows(stripped)) {
    const hits = matchingLines(row, raw, stripped);
    if (hits.length === 0) continue; // reported by the anchor test
    const first = hits[0];
    const last = hits[hits.length - 1];
    if (row.start !== first || row.end !== last) {
      loose.push(`code-map.md:${row.mapLine} "${row.probe.slice(0, 46)}" spans ` +
        `${row.start}-${row.end} but what it names lives at ${first}-${last}`);
    }
  }
  assert.deepStrictEqual(loose, [], `code-map ranges wider than what they document:\n  ${loose.join('\n  ')}`);
});

test('no code-map label matches more than one place in the file', () => {
  // An anchor that happens to be right is not the same as a label that can
  // only mean one thing. A label matching several lines can be moved to any
  // of them and still verify, which is how a wrong anchor survives a check.
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8').split(/\r?\n/);
  const stripped = strippedLines(raw);

  const ambiguous = [];
  for (const row of anchorRows(stripped)) {
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
  const stripped = strippedLines(raw);
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

test('every test count the code-map states is the real one', () => {
  // The row documenting the debug report's own coverage claimed 26 tests
  // against 24 actual, and 22 against 21 before that — a false number in the
  // round that was closing false claims. Numbers nothing verifies drift, so
  // either they get checked or they should not be written down.
  const rows = fs.readFileSync(MAP_PATH, 'utf8').split(/\r?\n/);
  const wrong = [];
  rows.forEach((line, i) => {
    const m = line.match(/^\|\s*`(tests\/[\w.-]+\.test\.js)`\s*\|(.*)\|\s*$/);
    if (!m) return;
    const claimed = m[2].match(/\((\d+) tests?\)/);
    if (!claimed) return;
    const file = path.join(__dirname, '..', m[1]);
    if (!fs.existsSync(file)) { wrong.push(`code-map.md:${i + 1} names ${m[1]}, which does not exist`); return; }
    const actual = (fs.readFileSync(file, 'utf8').match(/^test\(/gm) || []).length;
    if (actual !== Number(claimed[1])) {
      wrong.push(`code-map.md:${i + 1} claims ${m[1]} has ${claimed[1]} tests; it has ${actual}`);
    }
  });
  assert.deepStrictEqual(wrong, [], `code-map test counts are wrong:\n  ${wrong.join('\n  ')}`);
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
