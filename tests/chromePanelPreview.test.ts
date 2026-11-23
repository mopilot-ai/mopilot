// The side panel's streamed reply against a read of the chat (electron/chrome-extension/src/panelPreview.mjs): only the part of the turn's reply the read's rows hold goes, on every harness's history (#2116).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { unread, TURNS, MIN_OVERLAP } = await import('../electron/chrome-extension/src/panelPreview.mjs');

const you = (text: string) => ({ role: 'user', text });
const reply = (text: any) => ({ role: 'assistant', text });
const step = (text: string) => ({ role: 'step', text });
const over = { over: true };

test('a history with none of the reply keeps it all; one holding all of it, or more, drops it, whitespace aside', () => {
  assert.equal(unread('', [reply('x')]), '');
  // Claude Code: the transcript has the message, not the reply still streaming (nor any rows at all yet)
  assert.equal(unread('Working on it', []), 'Working on it');
  assert.equal(unread('Working on it', [you('go')]), 'Working on it');
  assert.equal(unread('Working on it', [you('go')], over), 'Working on it', 'stopped before it was written: what there is');
  // the same words in an earlier turn are not this turn's reply
  assert.equal(unread('Working on it', [reply('Working on it'), you('again')]), 'Working on it');
  // Codex: its thread holds the reply being written, and more of it than had streamed here
  assert.equal(unread('Working on it', [you('go'), reply('Working  on\nit')]), '');
  assert.equal(unread('Working on it', [you('go'), reply('Working on it, and done')]), '');
  // rows with no message at all are one turn
  assert.equal(unread('Working on it', [reply('Working on it')]), '');
});

test('the rows holding the reply’s first part (finished messages, a read behind the stream, a row cut short) keep what follows', () => {
  // Claude Code: the turn's first message and its step are rows, the next message is still streaming
  assert.equal(unread('First part, done. Second part', [you('q'), reply('First part, done.'), step('Ran ls')]), 'Second part');
  // a short first message is the rows' too
  assert.equal(unread('On it. Checking the file', [you('q'), reply('On it.')]), 'Checking the file');
  // several messages of the turn read as one, in order
  const many = [you('q'), reply('Alpha beta.'), step('Ran ls'), reply(null), reply('Gamma')];
  assert.equal(unread('Alpha beta. Gamma delta', many), 'delta');
  // a read behind the stream
  assert.equal(unread('The answer is forty-two.', [you('q'), reply('The answer is fo')], over), 'rty-two.');
  // a long row is cut short with "…": the rows hold up to there
  assert.equal(unread('Long text and the rest', [you('q'), reply('Long text…')]), 'and the rest');
});

test('a follow-up steered into the turn is a message among its replies', () => {
  const rows = [you('q'), reply('Before the follow-up.'), you('Also this'), reply('After')];
  assert.equal(unread('Before the follow-up. After it', rows), 'it');
  // before a reply follows the last message, an earlier message's replies may be another turn's: none of it is held
  assert.equal(unread('OK, now the next', [you('q'), reply('OK'), you('next')]), 'OK, now the next');
  // the turn's own message is one of the last few
  const steered = [you('q'), reply('Start.'), ...Array.from({ length: TURNS }, (_v, i) => you(`more ${i}`)), reply('x')];
  assert.equal(TURNS, 5);
  assert.equal(unread('Start. x And on', steered), 'Start. x And on', 'too many messages back: not this turn');
  const fewer = [you('q'), reply('Start.'), ...Array.from({ length: TURNS - 1 }, (_v, i) => you(`more ${i}`)), reply('x')];
  assert.equal(unread('Start. x And on', fewer), 'And on');
});

test('replies that are not this one: all of it while the turn runs, nothing once it ended', () => {
  const other = [you('q'), reply('I will look at the tests.')];
  assert.equal(unread('I will check the logs.', other), 'I will check the logs.');
  assert.equal(unread('I will check the logs.', other, over), '');
});

test('a panel that opened the chat mid-turn has the reply’s end only', () => {
  const rows = [you('go'), reply('First. Then the first half of the second message')];
  const joined = { joined: true };
  // Codex: the rows hold all it has
  assert.equal(unread('half of the second', rows, joined), '');
  // Claude Code: the rows end with the start of what it has
  assert.equal(unread('half of the second message and the third', rows, joined), 'and the third');
  // a few letters in common are chance
  assert.equal(MIN_OVERLAP, 8);
  assert.equal(unread('message! Next', rows, joined), 'message! Next');
  // the repeated start the matcher backs off from
  assert.equal(unread('aaaab and on', [you('go'), reply('xaaaaaaaaaab and')], joined), 'on');
  assert.equal(unread('abcabcabd tail', [you('go'), reply('abcabcabcabcabd')], joined), 'tail');
  // rows with no reply: all of it
  assert.equal(unread('half of the second', [you('go')], joined), 'half of the second');
});
