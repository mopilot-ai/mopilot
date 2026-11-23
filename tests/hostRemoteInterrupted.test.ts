// A turn a machine's restart cut off, in this app (electron/host/remoteInterrupted.cjs through the mirror, electron/host/remoteChats.cjs): shown as failed with what was interrupted so Retry is offered, recorded that way so a reopened chat reads the same, and a person's Stop left a Stop. A: the notice; B: bounds and malformed fields; W: replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, ev, start, world } from './support/host/remoteChatsKit.ts';

import { isLimitError } from '../shared/acpStop.mjs';
import { isAuthText } from '../shared/acpAuth.mjs';

const require = createRequire(import.meta.url);
const { shownInterruption, toldEnd } = require('../electron/host/remoteInterrupted.cjs');
import { codeOfText } from '../shared/host/turnErrorCode.mjs';
const cut = (running: unknown, extra: object = {}) => ({
  kind: 'turnEnd',
  turnId: 't1',
  stopReason: 'cancelled',
  error: { message: 'The host stopped while this turn was running.' },
  interrupted: { by: 'host_restart', running },
  ...extra,
});

test('A: a turn the restart cut off is a failure that names what it was running; one running nothing just says the machine restarted', () => {
  assert.deepEqual(shownInterruption(cut(['npm test'])).error, {
    message: 'The machine restarted during this turn. Interrupted: npm test.',
  });
  assert.equal(shownInterruption(cut(['npm test'])).stopReason, 'error');
  assert.equal(shownInterruption(cut([])).error.message, 'The machine restarted during this turn.');
});

test('B: at most three names, long ones cut, and anything that is not a name left out', () => {
  const long = 'x'.repeat(200);
  assert.equal(
    shownInterruption(cut(['a', 'b', 'c', 'd', 'e'])).error.message,
    'The machine restarted during this turn. Interrupted: a, b, c and more.',
  );
  assert.equal(shownInterruption(cut([long])).error.message, `The machine restarted during this turn. Interrupted: ${'x'.repeat(80)}….`);
  assert.equal(shownInterruption(cut(['', 5, null, '  ', 'ls'])).error.message, 'The machine restarted during this turn. Interrupted: ls.');
  assert.equal(shownInterruption(cut('not a list')).error.message, 'The machine restarted during this turn.');
});

test('B: a command whose own words look like a usage limit or a sign-in error is not named, so the notice is not taken for one', () => {
  const told = shownInterruption(cut(['grep -rn "rate limit" src', 'npm test', 'echo "not logged in"'])).error.message;
  assert.equal(told, 'The machine restarted during this turn. Interrupted: npm test.');
  assert.equal(isLimitError(told), false);
  assert.equal(isAuthText(told), false);
  assert.equal(isLimitError(shownInterruption(cut([])).error.message), false);
});

test('#4278: the calls the machine had sent and not heard back from are named as possibly done, apart from what was only interrupted', () => {
  const lost = [
    { kind: 'tool', name: 'browser_click' },
    { kind: 'desktop', name: 'input.click' },
    { kind: 'browser', name: 'navigation' },
    { kind: 'tool', name: 'send_mail' },
    { kind: 'tool', name: 'more' },
  ];
  // a relayed tool whose card is named as interrupted (by its own name or inside a longer title) is not named a second time
  assert.equal(
    shownInterruption(cut([], { interrupted: { by: 'host_restart', running: ['mcp__mopilot__browser_click'], lost } })).error.message,
    'The machine restarted during this turn. Interrupted: mcp__mopilot__browser_click. May have run: desktop input.click, browser navigation, send_mail and more.',
  );
  // a card whose title merely contains a tool's letters is another thing: the tool is still named
  const both = {
    by: 'host_restart',
    running: ['tools list', 'ls'],
    lost: [
      { kind: 'tool', name: 'ls' },
      { kind: 'tool', name: 'cat' },
    ],
  };
  assert.equal(
    shownInterruption(cut([], { interrupted: both })).error.message,
    'The machine restarted during this turn. Interrupted: tools list, ls. May have run: cat.',
  );
  // nothing interrupted that a card showed, a malformed list, and entries that name nothing or read as a limit
  const only = (l: unknown) => shownInterruption(cut([], { interrupted: { by: 'host_restart', running: [], lost: l } })).error.message;
  assert.equal(only([{ kind: 'tool', name: 'send_mail' }]), 'The machine restarted during this turn. May have run: send_mail.');
  assert.equal(only('none'), 'The machine restarted during this turn.');
  assert.equal(
    only([null, 'x', { kind: 'tool' }, { kind: 'tool', name: 'rate limit reached' }]),
    'The machine restarted during this turn.',
  );
});

test('B: a Stop, an end with another cause, an end with a malformed field and any other event are left as they are', () => {
  const stop = { kind: 'turnEnd', turnId: 't1', stopReason: 'cancelled' };
  assert.equal(shownInterruption(stop), stop);
  for (const interrupted of [{ by: 'person' }, 'host_restart', null, ['host_restart']]) {
    const e = { ...stop, interrupted };
    assert.equal(shownInterruption(e), e);
  }
  const update = { kind: 'update', interrupted: { by: 'host_restart' } };
  assert.equal(shownInterruption(update), update);
  assert.equal(shownInterruption(null), null);
});

test('W: through the mirror the window hears the failure and the transcript keeps it, so a reopened chat reads the same and nothing is told twice', async () => {
  const w = world();
  w.host.reply = { snapshot: { rev: 2, items: [start('t1'), ev(cut(['sleep 45']))] }, patches: null, generation: 'g1', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const ended = w.emitted.filter((e: any) => e.kind === 'turnEnd');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].stopReason, 'error');
  assert.match(String(ended[0].error), /The machine restarted during this turn\. Interrupted: sleep 45\./);
  const record = w.items.records.find((r: any) => r.t === 'end');
  assert.equal(record.stopReason, 'error');
  assert.match(String(record.error), /machine restarted/);
  // the handoff's summary says the turn failed, with the reason
  assert.match(String(w.chats.mirror(CHAT)!.items.at(-1).error), /machine restarted/);
  // the same record again (a reconnect's replay) is not applied a second time
  w.host.fire.patch(CHAT, 2, ev(cut(['sleep 45'])));
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.filter((e: any) => e.kind === 'turnEnd').length, 1);
});

test('#4278: a failed end reaches this app as text with the machine’s code beside it, and the text reads as that code to every reader', () => {
  const end = (error: unknown, extra: object = {}) => ({ kind: 'turnEnd', turnId: 't1', stopReason: 'error', error, ...extra });
  // words that already read as the code are left as they are
  assert.deepEqual(toldEnd(end({ message: 'You have hit your usage limit', code: 'rate_limit' })), {
    ...end('You have hit your usage limit'),
    turnErrorCode: 'rate_limit',
    onMachine: true,
  });
  // words that do not are led by ones that do: the thread and a reopened chat read only the text
  for (const [code, lead] of [
    ['rate_limit', 'Usage limit reached'],
    ['auth', 'Not signed in'],
    ['context', 'Context window is full'],
    ['model_unavailable', 'Model unavailable'],
  ] as const) {
    const told = toldEnd(end({ message: 'Try again later.', code }));
    assert.equal(told.error, `${lead}: Try again later.`);
    assert.equal(told.turnErrorCode, code);
    assert.equal(codeOfText(told.error), code);
  }
  // words that read as another code than the Host's: the lead decides
  const mixed = toldEnd(end({ message: 'Overloaded: too many requests, retry', code: 'model_unavailable' }));
  assert.equal(codeOfText(mixed.error), 'model_unavailable');
  // an older Host sends no code, and one this app does not know is not passed on: the text is all there is
  assert.deepEqual(toldEnd(end({ message: 'boom' })), { ...end('boom'), onMachine: true });
  assert.deepEqual(toldEnd(end({ message: 'boom', code: 'made_up' })), { ...end('boom'), onMachine: true });
  assert.deepEqual(toldEnd(end('plain text')), { ...end('plain text'), onMachine: true });
  // an end with no error, and any other event, are not touched
  const clean = { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' };
  assert.equal(toldEnd(clean), clean);
  const update = { kind: 'update', error: { message: 'x' } };
  assert.equal(toldEnd(update), update);
  assert.equal(toldEnd(null), null);
});
