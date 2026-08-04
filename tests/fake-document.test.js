'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeDocument } = require('./fake-document');

// The harness is tested because it is trusted. A stub that hard-coded
// `select.value = ''` is what let a picker defaulting to "queue all 115
// courses" through review: every panel test set the value by hand, so none of
// them could see what an untouched control reports. These pin the behaviour
// the panel tests now rest on, in the direction a browser actually behaves.
function selectWith(doc, values, selectedIndexes) {
  const select = doc.createElement('select');
  for (const value of values) {
    const option = doc.createElement('option');
    option.value = value;
    select.appendChild(option);
  }
  for (const i of (selectedIndexes || [])) select.children[i].selected = true;
  return select;
}

test('an empty select reports no value', () => {
  const doc = makeFakeDocument();
  assert.strictEqual(doc.createElement('select').value, '');
});

test('an untouched select reports its first option, as a browser does', () => {
  const doc = makeFakeDocument();
  assert.strictEqual(selectWith(doc, ['a', 'b', 'c']).value, 'a');
});

test('a selected option wins over the first one', () => {
  const doc = makeFakeDocument();
  assert.strictEqual(selectWith(doc, ['a', 'b', 'c'], [1]).value, 'b');
  assert.strictEqual(selectWith(doc, ['a', 'b', 'c'], [2]).value, 'c');
});

// The dangerous direction: reporting the first would read '' off a placeholder
// and see the add button refuse a click a real browser would let through.
test('the last selected option wins, not the first', () => {
  const doc = makeFakeDocument();
  assert.strictEqual(selectWith(doc, ['a', 'b', 'c'], [0, 2]).value, 'c');
});

test('writing a value an option offers selects that option', () => {
  const doc = makeFakeDocument();
  const select = selectWith(doc, ['a', 'b', 'c']);
  select.value = 'b';
  assert.strictEqual(select.value, 'b');
});

test('writing a value no option offers reports nothing, not the string', () => {
  const doc = makeFakeDocument();
  const select = selectWith(doc, ['a', 'b']);
  select.value = 'nope';
  assert.strictEqual(select.value, '');
});

test('an option appended after an unmatched write ends the unselected state', () => {
  const doc = makeFakeDocument();
  const select = selectWith(doc, ['a']);
  select.value = 'nope';
  assert.strictEqual(select.value, '');
  const added = doc.createElement('option');
  added.value = 'b';
  select.appendChild(added);
  // A browser's "ask for a reset" step selects the first option once one
  // exists and nothing is selected; the failed write does not survive it.
  assert.strictEqual(select.value, 'a');
});

test('writing null does not become the string "null"', () => {
  const doc = makeFakeDocument();
  const select = selectWith(doc, ['a', 'b']);
  select.value = null;
  assert.strictEqual(select.value, '');
});

test('a write beats a selected flag, because the player chose last', () => {
  const doc = makeFakeDocument();
  const select = selectWith(doc, ['a', 'b'], [1]);
  select.value = 'a';
  assert.strictEqual(select.value, 'a');
});

test('only a select gets the accessor; other elements keep a plain value', () => {
  const doc = makeFakeDocument();
  const input = doc.createElement('input');
  input.value = 'anything at all';
  assert.strictEqual(input.value, 'anything at all');
});

test('the document carries a session cookie only when asked', () => {
  assert.ok(!('cookie' in makeFakeDocument()), 'a token nothing asked for reroutes the fetch path');
  assert.strictEqual(makeFakeDocument({ cookie: 'rfc_v=x' }).cookie, 'rfc_v=x');
});

test('querySelector answers by id over created elements and forgets removed ones', () => {
  const doc = makeFakeDocument();
  const el = doc.createElement('div');
  el.id = 'tes-panel';
  assert.strictEqual(doc.querySelector('#tes-panel'), el);
  assert.strictEqual(doc.querySelector('.tes-panel'), null);
  el.remove();
  assert.strictEqual(doc.querySelector('#tes-panel'), null);
});

test('setAttribute records the attribute and mirrors it onto the element', () => {
  const doc = makeFakeDocument();
  const link = doc.createElement('a');
  link.setAttribute('href', 'https://example.invalid/');
  assert.strictEqual(link.attributes.href, 'https://example.invalid/');
  assert.strictEqual(link.href, 'https://example.invalid/');
});
