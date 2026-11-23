// A phone's Reply quote at the start of a message is split from the words under it (#4837).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteBlocks, splitQuote } from '../shared/quotedReply.mjs';

test('a message that starts with a quote gives the quote and the words under it', () => {
  assert.deepEqual(splitQuote('> one\n> two\n\nmy answer'), { quote: 'one\ntwo', rest: 'my answer' });
  assert.deepEqual(splitQuote('> one\n>\n> two\n\nmy answer\nmore'), { quote: 'one\n\ntwo', rest: 'my answer\nmore' });
  assert.deepEqual(splitQuote('> only a quote\n\n'), { quote: 'only a quote', rest: '' });
  assert.deepEqual(splitQuote('> only a quote'), { quote: 'only a quote', rest: '' });
});

test('anything else is not a quote: no leading ">", ">" run into text, a quote with nothing in it', () => {
  assert.equal(splitQuote('plain'), null);
  assert.equal(splitQuote('words\n\n> later quote'), null);
  assert.equal(splitQuote('>no space\n\nx'), null);
  assert.equal(splitQuote('> one\nrun straight on'), null);
  assert.equal(splitQuote('>\n\nx'), null);
  assert.equal(splitQuote(''), null);
});

test('several quotes, a blank line between them, are one quote with the words under the last', () => {
  assert.deepEqual(splitQuote('> the\n\n> total\n\nmy answer'), { quote: 'the\n\ntotal', rest: 'my answer' });
  assert.deepEqual(splitQuote('> a\n> b\n\n\n> c\n\n'), { quote: 'a\nb\n\nc', rest: '' });
  assert.deepEqual(quoteBlocks('> a\n\n> b\n\nnote'), { blocks: ['> a', '> b'], rest: 'note' });
  assert.equal(splitQuote('> a\n\n> b\nrun straight on'), null, 'a later quote that runs into text is no quote at all');
  assert.deepEqual(quoteBlocks('> a\n\nnote\n\n> not leading'), { blocks: ['> a'], rest: 'note\n\n> not leading' });
});
