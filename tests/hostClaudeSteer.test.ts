// A message sent with followUp steer while a Claude Code turn runs on the Host (host/src/sessions.mjs, #4916): into the turn, where one without it waits behind it, as on This Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, until, keyOf } from './support/host/claudeKit.ts';

test('A: a message sent with followUp steer while a turn runs goes into the turn, where one without it waits behind it (the same choice as on this Mac)', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: h.dir });
    await until(() => h.state(key).turn === 'running' && h.text(key) === 'working');
    const steered = await h.sessions.chatRuntime.send({ key, text: 'and this too', followUp: 'steer' });
    assert.equal(steered.action, 'steered');
    assert.equal(h.state(key).queue.length, 0, 'not queued behind the turn');
    // the stream tells the message in the turn it went into, keyed as the client keyed it
    const [told] = h.of('steered', key);
    assert.deepEqual([told.turnId, told.user.content[0].text], [h.of('turnStart', key)[0].turnId, 'and this too']);
    assert.equal(told.user.messageKey, told.user.clientId);
    const plain = await h.sessions.chatRuntime.send({ key, text: 'later' });
    assert.equal(plain.action, 'queued');
    assert.equal(h.state(key).queue.length, 1);
    await h.sessions.chatRuntime.host.cancel(key);
    await until(() => h.of('turnEnd', key).length > 0);
  } finally {
    await h.close();
  }
});
