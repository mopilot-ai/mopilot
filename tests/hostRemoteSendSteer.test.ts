// A message sent to a chat on a machine while its turn runs (electron/host/remoteSend.cjs, remoteSendDelivery.cjs, #4916): the person's choice of steer goes to the Host as `followUp: 'steer'` only where This Mac would steer it (the agent can, no Plan, goal, compaction or held switch); anything else is sent as it always was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { parseParams } from '../shared/host/schema.mjs';

const steerWith = (kind: string, over: object = {}, opts: object = {}) => ({
  ...msg('add this', UUID(1)),
  followUp: 'steer',
  ...over,
  opts,
});

test('steer goes to the Host for an agent that takes it, and nowhere else', async (t) => {
  for (const [kind, over, opts, steers, why] of [
    ['codex', {}, {}, true, 'Codex steers'],
    ['claude', {}, {}, true, 'Claude Code steers'],
    ['acp:host-codex', {}, {}, true, 'a machine’s Codex chat is an ACP-kind chat in this app'],
    ['acp:host-claude', {}, {}, true, 'a machine’s Claude Code chat is an ACP-kind chat in this app'],
    ['acp:kimi', {}, {}, false, 'ACP has no way into a running prompt'],
    ['unknown', {}, {}, false, 'an agent nothing is known of'],
    ['codex', { followUp: 'queue' }, {}, false, 'the person chose queue'],
    ['codex', { followUp: undefined }, {}, false, 'no choice made'],
    ['codex', {}, { goal: 'ship' }, false, 'a goal'],
    ['codex', {}, { compact: { args: '' } }, false, 'a compaction'],
  ] as const) {
    const w = world(t);
    w.remote('c1');
    w.kinds.set('c1', kind);
    await w.service.send('c1', steerWith(kind, over, opts));
    assert.equal(w.sent.length, 1, why);
    assert.equal(w.sent[0].item.followUp, steers ? 'steer' : undefined, why);
  }
});

test('Plan, and a chat with a held switch, are not steered; the Host is told nothing of it', async (t) => {
  const planned = world(t);
  planned.remote('c1');
  planned.kinds.set('c1', 'codex');
  planned.row.harnesses = [{ id: 'codex', planMode: true }];
  await planned.service.send('c1', steerWith('codex', {}, { plan: true }));
  assert.equal(planned.sent[0].item.followUp, undefined);
  const switching = world(t);
  switching.remote('c1');
  switching.kinds.set('c1', 'codex');
  switching.switches.set('c1', { harness: 'claude' });
  await switching.service.send('c1', steerWith('codex'));
  assert.equal(switching.sent[0].item.followUp, undefined);
});

test('the wire takes followUp steer on chat.send and nothing else of it', () => {
  const base = { chatId: 'c', epoch: 1, key: 'key-send-00000001', text: 'hi' };
  assert.equal(parseParams('chat.send', { ...base, followUp: 'steer' }).followUp, 'steer');
  for (const followUp of ['queue', 'steered', '', null, 5, undefined])
    assert.equal('followUp' in parseParams('chat.send', { ...base, followUp }), false);
});
