'use strict';

//
// Shared comment stripper for the source-text checks. Not a test file — the
// npm test glob is tests/*.test.js, so this is only ever required.
//
// It grew up inside tests/purity.test.js, where its five dedicated tests still
// live, and it has its current shape because an earlier review found its
// predecessor could produce a false PASS. tests/code-map.test.js briefly
// carried a simpler copy of its own, and a review separated the two with one
// line each:
//
//   const re = /['"]/; // ...the function init() lives here
//     The copy had no regex-literal state, read the leading slash as ordinary
//     code, and left the comment standing — reopening the exact hole the
//     code-map check had just closed.
//
//   A regex literal containing a slash-star sequence put the copy into
//     block-comment mode, and it silently swallowed every line that followed
//     until the next close marker. Three real declarations vanished.
//
// Both divergences are fail-closed today only because the uniqueness rule
// backstops them — but swallowing lines can erase a *duplicate* hit, which
// turns a genuinely ambiguous label into a passing one. So: one scanner, one
// set of tests. A second, weaker copy of a check like this is precisely the
// divergence that silently weakens one of them.
//
// The scanner tracks the literal contexts a bare "search for a comment opener"
// pass gets wrong: single- and double-quoted strings; template literals, whose
// `${...}` substitutions can themselves contain a nested template and so need
// brace-depth tracking rather than a single on/off flag; and regex literals,
// whose escapes and `[...]` character classes must not be misread as a comment
// starting a line early. A false *pass* — real code silently turned into
// "comment" and dropped — is the one outcome this must never produce, so
// wherever a case is genuinely ambiguous (division vs. a regex literal) the
// scanner keeps the text rather than stripping it: the worst failure mode is
// an unstripped comment word, never a deleted forbidden-API call.
//
// Newlines are preserved in every mode, so line numbers in the stripped text
// still match line numbers in the source. tests/code-map.test.js depends on
// that to report an anchor's real location.
function stripComments(src) {
  let out = '';
  let i = 0;
  // code | line | block | single | double | template | regex | regexClass
  let mode = 'code';
  // Last non-whitespace character emitted while in `code` mode. A slash opens
  // a regex literal (rather than being division) when the previous
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
  // template's substitution is tracked correctly instead of ending the outer
  // template on the inner one's first backtick.
  const templateExprDepths = [];

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === 'code') {
      // A stray backslash must never be left able to feed the comment check
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
        // A fresh expression context starts here: reset so a slash as its
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

module.exports = { stripComments };
