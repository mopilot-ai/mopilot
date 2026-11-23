// Moving a machine chat to another agent (D13, #4278), the wire and the Host's answer: the request's shape (A), what the Host holds and refuses (W, B), and that an end or a Host without the feature is never served half (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import chatSwitch from '../host/src/methods/chatSwitch.mjs';
import { helloParams, parseParams, requireFeatures, FEATURES } from '../shared/host/schema.mjs';
import { SWITCH_FEATURE, SWITCH_REFUSALS } from '../shared/host/chatSwitch.mjs';

const quiet = { report: () => undefined };
const scope = { chatId: 'claude:00000000-0000-4000-8000-000000000001', epoch: 1, key: 'key-switch-0001' };
const READY = [
  { id: 'claude', detected: true, signedIn: true },
  { id: 'codex', detected: true, signedIn: true },
  { id: 'gemini', detected: true, signedIn: false },
  { id: 'kimi', detected: true, signedIn: false, keyed: true },
  { id: 'amp', detected: false, signedIn: false },
  { id: 'lentkey', detected: true, signedIn: false, sources: { own: false, key: true, org: false } },
  { id: 'lentorg', detected: true, signedIn: false, sources: { own: false, key: false, org: true } },
  { id: 'nosource', detected: true, signedIn: false, sources: { own: false, key: false, org: false } },
  { id: 'unsureone', detected: true, signedIn: false, unsure: true },
];

function setup({ switching = true, harnesses = READY as any, current = 'claude' as string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-switch-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const chosen: any[] = [];
  const runtime: any = {
    host,
    send: async () => ({ turnId: 't' }),
    permit: () => true,
    familyOf: () => 'claude',
    ...(switching
      ? {
          switching: true,
          switchState: () => (current ? { harness: current } : null),
          choose: (id: string, p: any) => void chosen.push([id, p]),
        }
      : {}),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({ running: true, harnesses }) }).connection(() => undefined);
  let n = 0;
  const call = (p: any) => conn.call('chat.switch', { ...scope, key: `key-switch-${++n}-00`, ...p });
  return { conn, call, chosen };
}

test('A: the request names the chat, the agent and what the new agent runs with; a bad one is refused', () => {
  const ok = parseParams('chat.switch', {
    ...scope,
    harness: 'codex',
    model: 'gpt-x',
    effort: 'high',
    credential: { source: 'own', login: 'work' },
    extra: 1,
  });
  assert.deepEqual(ok, { ...scope, harness: 'codex', model: 'gpt-x', effort: 'high', credential: { source: 'own', login: 'work' } });
  assert.deepEqual(parseParams('chat.switch', { ...scope, harness: 'acp:gemini' }), { ...scope, harness: 'acp:gemini' });
  for (const bad of [
    {},
    { harness: 'gemini' },
    { harness: 'codex', model: 5 },
    { harness: 'codex', model: '' },
    { harness: 'codex', effort: 'x'.repeat(201) },
    { harness: 'codex', credential: { source: 'cloud' } },
  ])
    assert.throws(
      () => parseParams('chat.switch', { ...scope, ...bad }),
      (e: any) => e.code === 'invalid',
    );
  assert.throws(
    () => parseParams('chat.switch', { harness: 'codex', epoch: 1, key: scope.key }),
    (e: any) => e.code === 'invalid',
  );
});

test('I: a switch needs the feature, and a credential choice also needs logins: an older end or Host is refused, never served half', () => {
  assert.ok(FEATURES.includes(SWITCH_FEATURE));
  const full = { features: [...FEATURES] };
  assert.doesNotThrow(() => requireFeatures('chat.switch', full, {}));
  const without = (f: string) => ({ features: FEATURES.filter((x: string) => x !== f) });
  assert.throws(
    () => requireFeatures('chat.switch', without(SWITCH_FEATURE), {}),
    (e: any) => e.code === 'feature_missing' && e.missing.includes(SWITCH_FEATURE),
  );
  assert.throws(
    () => requireFeatures('chat.switch', without('logins'), { credential: { source: 'key' } }),
    (e: any) => e.missing.includes('logins'),
  );
  assert.doesNotThrow(() => requireFeatures('chat.switch', without('logins'), {}));
});

test('I: a Host whose runtime cannot settle a switch does not offer it, and refuses the request', async () => {
  const s = setup({ switching: false });
  const hello = await s.conn.call('host.hello', helloParams());
  assert.equal(hello.agreed.features.includes(SWITCH_FEATURE), false);
  await assert.rejects(s.call({ harness: 'codex' }), (e: any) => e.code === 'feature_missing');
  // the handler itself says so too, for a caller that skipped the gate
  const { effects } = chatSwitch({ runtime: {}, status: () => ({}) } as any);
  await assert.rejects(effects['chat.switch']({ ...scope, harness: 'codex' }), /cannot move a chat to another agent yet/);
});

test('W: a Host that can settle a switch offers it and holds the choice on the chat, with what the new agent runs with', async () => {
  const s = setup();
  const hello = await s.conn.call('host.hello', helloParams());
  assert.equal(hello.agreed.features.includes(SWITCH_FEATURE), true);
  const out = await s.call({ harness: 'codex', model: 'gpt-x', effort: 'high', credential: { source: 'key' } });
  assert.deepEqual(out.result, { pending: { harness: 'codex', model: 'gpt-x' } });
  assert.deepEqual(s.chosen, [
    [scope.chatId, { harness: 'codex', model: 'gpt-x', modelLabel: 'gpt-x', mode: 'auto', effort: 'high', credential: { source: 'key' } }],
  ]);
  // a choice that names no model is the agent's own default
  const bare = await s.call({ harness: 'codex' });
  assert.deepEqual(bare.result, { pending: { harness: 'codex' } });
  assert.deepEqual(s.chosen[1][1], { harness: 'codex', model: '', modelLabel: '', mode: 'auto' });
});

test("W: a resend under the same key holds the choice once, and a choice back to the chat's own agent drops it", async () => {
  const s = setup();
  await s.conn.call('host.hello', helloParams());
  const again = { ...scope, harness: 'codex' };
  await s.conn.call('chat.switch', again);
  const replay = await s.conn.call('chat.switch', again);
  assert.equal(replay.replayed, true);
  assert.equal(s.chosen.length, 1);
  const back = await s.call({ harness: 'claude' });
  assert.deepEqual(back.result, { pending: null });
  assert.deepEqual(s.chosen[1], [scope.chatId, null]);
});

test('B: an agent that is not installed, or signed out, is refused with a reason and nothing is held; a key the app lent counts as signed in', async () => {
  const s = setup();
  await s.conn.call('host.hello', helloParams());
  await assert.rejects(
    s.call({ harness: 'acp:amp' }),
    (e: any) => e.code === 'agent_missing' && /not installed on this machine/.test(e.message),
  );
  await assert.rejects(
    s.call({ harness: 'acp:gemini' }),
    (e: any) => e.code === 'agent_signed_out' && /Sign in to .* on this machine first/.test(e.message),
  );
  // a machine that reported no agents has none of them
  const none = setup({ harnesses: null });
  await none.conn.call('host.hello', helloParams());
  await assert.rejects(none.call({ harness: 'codex' }), (e: any) => e.code === 'agent_missing');
  assert.equal(s.chosen.length + none.chosen.length, 0);
  await s.call({ harness: 'acp:kimi' });
  assert.equal(s.chosen.length, 1);
  // a key or a lease the app lent is a sign-in for the Host's own report too; no credential at all is not
  await s.call({ harness: 'acp:lentkey' });
  await s.call({ harness: 'acp:lentorg' });
  assert.equal(s.chosen.length, 3);
  // an agent the Host could not check in time is not refused as signed out: the send reports the real cause (#5177)
  await s.call({ harness: 'acp:unsureone' });
  assert.equal(s.chosen.length, 4);
  await assert.rejects(s.call({ harness: 'acp:nosource' }), (e: any) => e.code === 'agent_signed_out');
  assert.equal(s.chosen.length, 4);
  for (const code of Object.keys(SWITCH_REFUSALS)) assert.match(SWITCH_REFUSALS[code as keyof typeof SWITCH_REFUSALS], /\{agent\}/);
});

test('B: a chat this machine does not have is refused', async () => {
  const s = setup({ current: null });
  await s.conn.call('host.hello', helloParams());
  await assert.rejects(s.call({ harness: 'codex' }), (e: any) => e.code === 'chat_unknown');
  assert.equal(s.chosen.length, 0);
});
