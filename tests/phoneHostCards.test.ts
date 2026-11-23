// The cards a Host waits on, as the phone shows them (mobile/src/remote/hostCards.ts): one card per (Host key, chat, request) whichever
// path delivered it, the latest host.pending wins, an answer in flight survives it, and the Host's refusal is shown, not a local guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardId,
  createCardStore,
  endedLine,
  failureState,
  closedState,
  answeredState,
  type HostCardWire,
} from '../mobile/src/remote/hostCards';

const card = (requestId: string, chatId = 'c1'): HostCardWire => ({
  chatId,
  epoch: 2,
  requestId,
  cardKind: 'permission',
  summary: { tool: 'execute', line: 'git push' },
  options: [
    { optionId: 'a', name: 'Allow', kind: 'allow' },
    { optionId: 'd', name: 'Deny', kind: 'deny' },
  ],
  at: 1,
});

test('a card is one card whichever path delivered it, keyed by (Host key, chat, request)', () => {
  const s = createCardStore();
  s.addMac('hk', card('r1'));
  s.setPending('hk', [card('r1'), card('r2')]);
  assert.deepEqual(
    s.list('hk').map((c) => [c.id, c.via]),
    [
      [cardId('hk', 'c1', 'r1'), 'mac'],
      [cardId('hk', 'c1', 'r2'), 'direct'],
    ],
  );
  // the Mac's copy of a card the Host already listed adds nothing
  s.addMac('hk', card('r2'));
  assert.equal(s.list('hk').length, 2);
  assert.equal(s.waiting('hk'), 2);
  assert.equal(s.list().length, 2);
  assert.notEqual(cardId('hk', 'c1', 'r1'), cardId('other', 'c1', 'r1'), 'the same ids on another Host are another card');
});

test('the latest host.pending wins: a card it no longer lists goes, one being answered stays', () => {
  const s = createCardStore();
  let told = 0;
  const off = s.subscribe(() => void told++);
  s.setPending('hk', [card('r1'), card('r2')]);
  s.sending(cardId('hk', 'c1', 'r1'), 'a');
  s.setPending('hk', [card('r1')]);
  assert.deepEqual(
    s.list('hk').map((c) => [c.card.requestId, c.state.kind]),
    [
      ['r1', 'sending'],
      ['r2', 'closed'],
    ],
    'a card the Host no longer lists turns to the line that says so, and its buttons go',
  );
  assert.deepEqual(s.list('hk')[0].state, { kind: 'sending', optionId: 'a' });
  assert.deepEqual(s.list('hk')[1].state, { kind: 'closed', line: 'No longer waiting.' });
  s.setPending('hk', []);
  assert.deepEqual(
    s.list('hk').map((c) => c.card.requestId),
    ['r1', 'r2'],
    'an answer in flight is not dropped by a list',
  );
  s.setPending('other', [card('x')]);
  s.setPending('hk', []);
  assert.equal(s.list('other').length, 1, 'one Host’s list never touches another’s cards');
  off();
  const before = told;
  s.setPending('hk', []);
  assert.equal(told, before);
});

test("a card that left the Host's list says how: answered on a device, withdrawn, or (an older Host) no longer waiting; a card whose Host could not be reached closes the same way", () => {
  const s = createCardStore();
  s.setPending('hk', [card('r1'), card('r2'), card('r3'), card('r4')]);
  s.settle(cardId('hk', 'c1', 'r4'), { kind: 'unreachable', optionId: 'a' });
  s.setPending(
    'hk',
    [],
    [
      { chatId: 'c1', requestId: 'r1', by: { name: 'Studio' } },
      { chatId: 'c1', requestId: 'r2' },
    ],
  );
  assert.deepEqual(
    s.list('hk').map((c) => (c.state.kind === 'closed' ? c.state.line : c.state.kind)),
    ['Already answered on Studio.', 'Cancelled', 'No longer waiting.', 'No longer waiting.'],
  );
  assert.equal(endedLine(undefined), 'No longer waiting.');
});

test('a card closed only because a list lacked it opens again when the next list has it; one the Host closed for a reason, or answered here, stays closed', () => {
  const s = createCardStore();
  s.addMac('hk', card('r1'));
  // a read that began before the card did arrives without it
  s.setPending('hk', []);
  assert.equal(s.list('hk')[0].state.kind, 'closed');
  s.setPending('hk', [card('r1')]);
  assert.deepEqual(s.list('hk')[0].state, { kind: 'waiting' });
  // answered here: it stays as the receipt even if a list still has it
  s.settle(cardId('hk', 'c1', 'r1'), answeredState('allow', null));
  s.setPending('hk', [card('r1')]);
  assert.deepEqual(s.list('hk')[0].state, { kind: 'closed', line: 'Allowed' });
});

test('a tap is pending until the Host replies; an unreachable Host leaves the card to try again; the refusal is the Host’s', () => {
  const s = createCardStore();
  s.setPending('hk', [card('r1'), card('r2'), card('r3'), card('r4')]);
  const id = (r: string) => cardId('hk', 'c1', r);
  s.sending(id('r1'), 'a');
  s.sending(id('r1'), 'd');
  assert.deepEqual(
    s.list('hk')[0].state,
    { kind: 'sending', optionId: 'd' }.kind === 'sending' ? { kind: 'sending', optionId: 'a' } : null,
    'the first tap holds; a second is ignored',
  );
  s.settle(id('r1'), answeredState('allow', null));
  s.sending(id('r1'), 'a');
  assert.deepEqual(s.list('hk')[0].state, { kind: 'closed', line: 'Allowed' }, 'a closed card is not reopened by a tap');
  s.sending(id('r2'), 'a');
  s.settle(id('r2'), failureState({ code: 'timeout' }, 'build-box', 'a'));
  assert.deepEqual(s.list('hk')[1].state, { kind: 'unreachable', optionId: 'a' });
  assert.equal(s.waiting('hk'), 3, 'an unreachable card still waits for a person');
  s.sending(id('r2'), 'a');
  assert.deepEqual(s.list('hk')[1].state, { kind: 'sending', optionId: 'a' });
  s.settle(id('r3'), failureState({ code: 'card_answered', details: { by: { name: 'Work MacBook Pro' } } }, 'build-box'));
  assert.deepEqual(s.list('hk')[2].state, { kind: 'closed', line: 'Already answered on Work MacBook Pro.' });
  s.close(id('r4'), closedState('expired'));
  assert.deepEqual(s.list('hk')[3].state, { kind: 'closed', line: 'Not answered' });
  // a request the store does not hold is ignored
  s.sending('nope', 'a');
  s.settle('nope', { kind: 'waiting' });
});

test('failures and closings read as the plan words them', () => {
  assert.deepEqual(failureState({ code: 'stale_epoch' }, 'm'), { kind: 'closed', line: 'This chat moved to another machine.' });
  assert.deepEqual(failureState({ code: 'unreachable' }, 'm'), { kind: 'unreachable', optionId: '' });
  assert.deepEqual(failureState({ code: 'card_answered' }, 'm'), { kind: 'closed', line: 'Already answered.' });
  assert.deepEqual(failureState({ code: 'weird' }, 'build-box'), { kind: 'closed', line: "Couldn't reach build-box." });
  assert.deepEqual(failureState({}, 'build-box'), { kind: 'closed', line: "Couldn't reach build-box." });
  assert.deepEqual(closedState('answered', { kind: 'deny', device: 'Pocket iPhone' }), { kind: 'closed', line: 'Denied on Pocket iPhone' });
  assert.deepEqual(closedState('answered'), { kind: 'closed', line: 'Cancelled' });
  assert.deepEqual(closedState('host_restarted'), { kind: 'closed', line: 'The machine restarted' });
  assert.deepEqual(closedState('stopped'), { kind: 'closed', line: 'Cancelled' });
});

test('a card that closed is stamped when it did, whether the Host stopped listing it or a tap settled it', () => {
  let t = 1000;
  const s = createCardStore(() => t);
  s.setPending('hk', [card('r1'), card('r2')]);
  assert.equal(s.list('hk')[0].closedAt, undefined);
  t = 2000;
  s.setPending('hk', [card('r2')]);
  assert.equal(s.list('hk').find((c) => c.card.requestId === 'r1')!.closedAt, 2000, 'it left the Host’s list');
  t = 3000;
  s.settle(cardId('hk', 'c1', 'r2'), closedState('allow' as any, null as any) as any);
  assert.equal(s.list('hk').find((c) => c.card.requestId === 'r2')!.closedAt, 3000, 'a reply closed it');
  s.sending(cardId('hk', 'c1', 'r2'), 'a');
  s.settle(cardId('hk', 'c1', 'r2'), { kind: 'waiting' });
  assert.equal(s.list('hk').find((c) => c.card.requestId === 'r2')!.state.kind, 'waiting');
});
