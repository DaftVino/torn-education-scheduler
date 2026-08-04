'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { SOURCE_PATH } = require('./load-userscript');

// The scan reads source as text, so `window` in an English comment used to
// fail it. Strip comments first — but with a scanner, not a regex: a naive
// //-to-end-of-line rule eats the rest of any string containing "http://".
//
// The scanner tracks the literal contexts a bare "search for // or /*" pass
// gets wrong: single- and double-quoted strings; template literals, whose
// `${...}` substitutions can themselves contain a nested template and so
// need brace-depth tracking rather than a single on/off flag; and regex
// literals, whose `\/` escapes and `[...]` character classes must not be
// misread as a comment starting a line early. A false *pass* — real code
// silently turned into "comment" and dropped — is the one outcome this must
// never produce, so wherever a case is genuinely ambiguous (division vs. a
// regex literal) the scanner keeps the text rather than stripping it: the
// worst failure mode is an unstripped comment word, never a deleted
// forbidden-API call.
function stripComments(src) {
  let out = '';
  let i = 0;
  // code | line | block | single | double | template | regex | regexClass
  let mode = 'code';
  // Last non-whitespace character emitted while in `code` mode. A `/` is a
  // regex literal's opening delimiter (not division) when the previous
  // significant token is one of these operator/punctuation characters, or
  // when there is no previous token at all — the standard heuristic real
  // lexers use to disambiguate the two without a full parse.
  let lastSignificant = null;
  const regexStarters = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
    '+', '-', '*', '%', '~', '^', '<', '>',
  ]);
  // Brace-depth counters for `${ ... }` template substitutions, one pushed
  // per level of nesting, so a template literal written inside another
  // template's `${...}` is tracked correctly instead of ending the outer
  // template on the inner one's first backtick.
  const templateExprDepths = [];

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === 'code') {
      // A stray backslash must never be left able to feed the `//` check
      // below — consume it and whatever it escapes as one unit.
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && (lastSignificant === null || regexStarters.has(lastSignificant))) {
        mode = 'regex'; out += c; i += 1; continue;
      }
      if (c === "'") { mode = 'single'; out += c; i += 1; continue; }
      if (c === '"') { mode = 'double'; out += c; i += 1; continue; }
      if (c === '`') { mode = 'template'; out += c; i += 1; continue; }
      if (c === '{' && templateExprDepths.length) {
        templateExprDepths[templateExprDepths.length - 1] += 1;
      } else if (c === '}' && templateExprDepths.length) {
        if (templateExprDepths[templateExprDepths.length - 1] === 0) {
          templateExprDepths.pop();
          mode = 'template';
          out += c; i += 1; continue;
        }
        templateExprDepths[templateExprDepths.length - 1] -= 1;
      }
      out += c;
      if (!/\s/.test(c)) lastSignificant = c;
      i += 1; continue;
    }

    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i += 1; continue;
    }

    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // keep line numbers honest
      i += 1; continue;
    }

    if (mode === 'single' || mode === 'double') {
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      out += c;
      if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"')) {
        mode = 'code'; lastSignificant = c;
      }
      i += 1; continue;
    }

    if (mode === 'template') {
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      if (c === '$' && next === '{') {
        // A fresh expression context starts here: reset so a `/` as its
        // very first token is judged by the "no previous token" rule.
        templateExprDepths.push(0); mode = 'code'; lastSignificant = null;
        out += c + next; i += 2; continue;
      }
      if (c === '`') { mode = 'code'; lastSignificant = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }

    if (mode === 'regex') {
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      if (c === '[') { mode = 'regexClass'; out += c; i += 1; continue; }
      if (c === '/') { mode = 'code'; lastSignificant = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }

    if (mode === 'regexClass') {
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      if (c === ']') { mode = 'regex'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
  }
  return out;
}

// The design's central claim is that the engine is pure and therefore
// testable. This makes that a checked property rather than a promise.
test('the engine section touches no browser, network, or clock API', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const start = src.indexOf('─── ENGINE START');
  const end = src.indexOf('─── ENGINE END');
  assert.ok(start !== -1 && end !== -1, 'engine section markers not found');
  assert.ok(end > start, 'engine markers are out of order');
  const engine = stripComments(src.slice(start, end));

  const forbidden = [
    /\bdocument\b/, /\bwindow\b/, /\blocation\b/, /\bGM_\w+/,
    /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bDate\.now\b/, /new Date\s*\(\s*\)/,
    /\bsetTimeout\b/, /\bsetInterval\b/, /\blocalStorage\b/, /\bMath\.random\b/,
  ];
  for (const pattern of forbidden) {
    assert.strictEqual(pattern.test(engine), false, `engine section must not use ${pattern}`);
  }
});

test('the engine section is not empty', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const engine = src.slice(src.indexOf('─── ENGINE START'), src.indexOf('─── ENGINE END'));
  assert.ok(engine.length > 500, 'engine section looks empty — markers may have moved');
});

test('the purity scan ignores forbidden words inside comments', () => {
  const sample = [
    '// a comment mentioning window, location and document freely',
    '/* a block comment mentioning fetch( and Date.now too */',
    'const legitimate = "a string is not a comment";',
    'function pure(a) { return a + 1; }',
  ].join('\n');
  const stripped = stripComments(sample);
  assert.ok(!/\bwindow\b/.test(stripped), 'line comment survived stripping');
  assert.ok(!/\bDate\.now\b/.test(stripped), 'block comment survived stripping');
  assert.ok(/a string is not a comment/.test(stripped), 'string literal was destroyed');
  assert.ok(/function pure/.test(stripped), 'code was destroyed');
});

test('the purity scan still catches a real violation in engine code', () => {
  const sample = 'function bad() { return document.querySelector("x"); }';
  assert.ok(/\bdocument\b/.test(stripComments(sample)), 'a real violation was masked');
});

test('a regex literal ending in an escaped slash does not swallow the code after it', () => {
  const inputs = [
    "const RE = /a\\//; document.title = 'x';",
    "const isUrl = /^https?:\\/\\//i; document.title = 'y';",
  ];
  for (const sample of inputs) {
    const stripped = stripComments(sample);
    assert.ok(/\bdocument\b/.test(stripped), `code after the regex literal was swallowed: ${sample}`);
  }
});

test('a regex character class containing a slash does not end the regex early', () => {
  const sample = "const re = /[/]/; document.title = 'z';";
  const stripped = stripComments(sample);
  assert.ok(/\bdocument\b/.test(stripped), 'code after the character class was swallowed');
});

test('division after an identifier is not mistaken for a regex literal', () => {
  const sample = 'const half = total / 2; const other = count / 2;';
  const stripped = stripComments(sample);
  assert.strictEqual(stripped, sample, 'plain division code was altered by the scanner');
});

test('a nested template literal inside a substitution does not end the outer template early', () => {
  const sample = "const s = `outer ${`inner ${1 + 1}` } tail`; document.title = 'nested';";
  const stripped = stripComments(sample);
  assert.ok(/\bdocument\b/.test(stripped), 'code after the nested template was swallowed');
});

test('comment-like sequences inside ordinary string literals are not treated as real comments', () => {
  const sample = [
    "const a = 'http://example.com'; document.title = 'p';",
    'const b = "/* not a comment */"; document.title = \'q\';',
  ].join('\n');
  const stripped = stripComments(sample);
  const matches = stripped.match(/\bdocument\b/g) || [];
  assert.strictEqual(matches.length, 2, 'code after a string containing // or /* was swallowed');
});
