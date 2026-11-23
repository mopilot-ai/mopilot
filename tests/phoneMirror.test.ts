// Terminal slices and live frames: ordering, redelivery, gaps, multibyte splits, escape sequences and frame validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyData, display, emptyTerminal, exitText, MAX_TERMINAL_CHARS } from '../mobile/src/remote/mirror.ts';

const b64 = (bytes: number[] | string) => Buffer.from(typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)).toString('base64');

test('slices apply in order, redelivered bytes are skipped and overlapping ones keep only the new tail', () => {
  const decoder = new TextDecoder();
  let t = applyData(emptyTerminal(), decoder, 0, b64('hello '));
  t = applyData(t, decoder, 6, b64('world'));
  assert.deepEqual([t.text, t.at, t.gap], ['hello world', 11, false]);
  assert.equal(applyData(t, decoder, 0, b64('hello ')), t);
  t = applyData(t, decoder, 8, b64('rld!'));
  assert.deepEqual([t.text, t.at], ['hello world!', 12]);
});

test('a slice that starts beyond what the screen has marks a gap and applies nothing', () => {
  const t = applyData(emptyTerminal(5), new TextDecoder(), 9, b64('x'));
  assert.deepEqual([t.text, t.at, t.gap], ['', 5, true]);
  const healed = applyData(t, new TextDecoder(), 5, b64('y'));
  assert.deepEqual([healed.text, healed.gap], ['y', false]);
});

test('a character split across slices is decoded whole, and malformed events change nothing', () => {
  const decoder = new TextDecoder();
  const euro = [0xe2, 0x82, 0xac];
  let t = applyData(emptyTerminal(), decoder, 0, b64(euro.slice(0, 2)));
  assert.equal(t.text, '');
  t = applyData(t, decoder, 2, b64(euro.slice(2)));
  assert.equal(t.text, '€');
  assert.equal(applyData(t, decoder, 'x', b64('a')), t);
  assert.equal(applyData(t, decoder, 3, 5), t);
});

test('only the latest output is kept', () => {
  const t = applyData(emptyTerminal(), new TextDecoder(), 0, b64('a'.repeat(MAX_TERMINAL_CHARS + 50)));
  assert.equal(t.text.length, MAX_TERMINAL_CHARS);
});

test('display removes escape sequences and lets a carriage return rewind its line', () => {
  assert.equal(display('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok \u001b]8;;x\u001b\\link\u001b=\r\nnext'), 'red ok link\nnext');
  assert.equal(display('progress 10%\rprogress 100%\ndone'), 'progress 100%\ndone');
});

test('exit text names a signal, a code, or neither', () => {
  assert.equal(exitText(0, 'SIGTERM'), 'The terminal ended (SIGTERM).');
  assert.equal(exitText(2, undefined), 'The terminal ended with code 2.');
  assert.equal(exitText(undefined, ''), 'The terminal ended.');
});
