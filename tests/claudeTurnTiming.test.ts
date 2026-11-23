// A Claude turn's time read back from its transcript (core/crates/translate/src/claude): only the conversation's own
// messages count, so a title written later by a rename or a fork does not stretch "Worked for" (#1941).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from './support/claude-translate.ts';

const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, s)).toISOString();
const turn = [
  { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'run it' } },
  { type: 'assistant', uuid: 'a1', timestamp: at(20), message: { id: 'm1', content: [{ type: 'text', text: 'done' }] } },
];

test('a title line written later does not stretch the last turn', () => {
  const titled = [...turn, { type: 'custom-title', customTitle: 'chat (fork)', sessionId: 's', timestamp: at(59) }];
  const [t] = buildTurns(titled, 'claude:s', '/repo');
  assert.equal(t.durationMs, 20_000);
  assert.equal(t.completedAt, Date.parse(at(20)) / 1000);
});

test('a system line inside the turn still counts', () => {
  const withSystem = [...turn, { type: 'system', subtype: 'informational', uuid: 's1', timestamp: at(30), content: 'note' }];
  const [t] = buildTurns(withSystem, 'claude:s', '/repo');
  assert.equal(t.durationMs, 30_000);
});

test("a fork's copy of its last message, stamped with the fork's time, does not stretch its turn", () => {
  const from = (uuid: string) => ({ forkedFrom: { sessionId: 'src', messageUuid: uuid } });
  const forked = [
    { ...turn[0], ...from('u1') },
    {
      type: 'assistant',
      uuid: 'a0',
      timestamp: at(15),
      message: { id: 'm0', content: [{ type: 'text', text: 'working' }] },
      ...from('a0'),
    },
    { ...turn[1], timestamp: at(59), ...from('a1') },
  ];
  const [t] = buildTurns(forked, 'claude:f', '/repo');
  assert.equal(t.durationMs, 15_000);
  // a turn after the fork is timed as usual
  const more = [
    ...forked,
    { type: 'user', uuid: 'u2', timestamp: at(70), message: { role: 'user', content: 'next' } },
    { type: 'assistant', uuid: 'a2', timestamp: at(75), message: { id: 'm2', content: [{ type: 'text', text: 'ok' }] } },
  ];
  assert.equal(buildTurns(more, 'claude:f', '/repo')[1].durationMs, 5_000);
});
