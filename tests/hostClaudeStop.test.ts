// A follow-up after a slow Stop on a Claude Code chat on the Host (#4023): it is never taken for the stopped turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, until, keyOf } from './support/host/claudeKit.ts';

test('A: under a slow Stop a follow-up is never taken for the stopped turn: sent during it, it waits as queued; sent after the end, it is its own turn (#4023)', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: h.dir });
    await until(() => h.state(key).turn === 'running' && h.text(key) === 'working');
    const [first] = h.of('turnStart', key);
    // the CLI takes a while to honour the interrupt
    const [q] = h.fake.queries;
    const interrupt = q.interrupt.bind(q);
    q.interrupt = async () => (await new Promise((r) => setTimeout(r, 300)), interrupt());
    const stopping = h.sessions.chatRuntime.host.cancel(key);
    const during = await h.sessions.chatRuntime.send({ key, text: 'during' });
    assert.equal(during.action, 'queued');
    await stopping;
    await until(() => h.of('turnEnd', key).length === 1 && h.state(key).turn === 'idle');
    const [end] = h.of('turnEnd', key);
    assert.deepEqual([end.turnId, end.stopReason], [first.turnId, 'cancelled']);
    assert.equal(h.of('turnStart', key).length, 1, 'no ghost turn start; the stopped turn ended once');
    // a stop by the person keeps what was queued for them to send (the controller holds it first in line)
    assert.deepEqual(
      h.state(key).queue.map((m: any) => m.text),
      ['during'],
    );
    // a message after the end is a turn of its own, with its own receipt, words and end
    const after = await h.sessions.chatRuntime.send({ key, text: 'after' });
    assert.equal(after.action, 'started');
    // then the message held for the person runs as a third turn of its own
    await until(() => h.of('turnEnd', key).length === 3 && h.state(key).turn === 'idle');
    const ends = h.of('turnEnd', key);
    assert.deepEqual([ends[1].stopReason, ends[1].turnId], ['end_turn', after.turnId]);
    assert.equal(ends[2].stopReason, 'end_turn');
    assert.deepEqual(new Set(ends.map((e: any) => e.turnId)).size, 3, 'every message has its own turn');
    assert.match(h.text(key), /fake-claude: afterfake-claude: during$/);
  } finally {
    await h.close();
  }
});
