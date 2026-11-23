// A machine chat's move to another agent, on this Mac's side (electron/host/remoteChatCalls.cjs, chatIds.cjs, remoteSwitch.cjs, remoteSend.cjs, ipc/host.cjs): the request carries the chat's epoch and a key and the gates of the Host's wire (A), the Host is asked with its own chat id (W), a Host that is away or a chat that runs here is told so, never a silent no-op (B), and the IPC reaches only a remote chat (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { helloParams, requireFeatures } from '../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
const { withAppChatIds } = require('../electron/host/chatIds.cjs');
const { createSwitch, switchChat, SWITCH_AWAY } = require('../electron/host/remoteSwitch.cjs');

const U = '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
const claudeId = `claude:${U}`;

function calls(features: string[] = helloParams().features) {
  const asked: any[][] = [];
  const c = chatCalls({
    needs: (method: string, params?: any) => requireFeatures(method, { features }, params),
    request: async (method: string, params: any) => (asked.push([method, params]), { result: { pending: { harness: 'codex' } } }),
    epochOf: () => 7,
    mintKey: () => 'key-switch-mint0',
    speaks: () => true,
  });
  return { c, asked };
}

test('A: the pick goes to the Host with the chat’s epoch, a key, and only the fields the Host parses', async () => {
  const { c, asked } = calls();
  const out = await c.switchTo(claudeId, { harness: 'codex', model: 'gpt-x', effort: 'high', extra: 1 } as any);
  assert.deepEqual(out, { pending: { harness: 'codex' } });
  assert.deepEqual(asked, [
    ['chat.switch', { chatId: claudeId, epoch: 7, key: 'key-switch-mint0', harness: 'codex', model: 'gpt-x', effort: 'high' }],
  ]);
  // a caller that retries names its own key
  await c.switchTo(claudeId, { harness: 'acp:kimi' }, { key: 'key-retry-00001' });
  assert.equal((asked[1][1] as any).key, 'key-retry-00001');
  assert.equal('model' in (asked[1][1] as any), false);
});

test('A: a Host without the feature, or a credential choice for one without logins, is refused before anything is sent', async () => {
  const without = (f: string) => helloParams().features.filter((x: string) => x !== f);
  const old = calls(without('switch'));
  await assert.rejects(
    old.c.switchTo(claudeId, { harness: 'codex' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('switch'),
  );
  const nologins = calls(without('logins'));
  await assert.rejects(nologins.c.switchTo(claudeId, { harness: 'codex', credential: { source: 'key' } }), (e: any) =>
    e.missing.includes('logins'),
  );
  assert.equal(old.asked.length + nologins.asked.length, 0);
  await assert.rejects(calls().c.switchTo(claudeId, { harness: 'gemini' }), (e: any) => e.code === 'invalid');
});

test('W: the Host is asked with its own chat id, whatever id the app shows', async () => {
  const asked: any[] = [];
  const host = { state: () => 'online', switchTo: async (...a: any[]) => (asked.push(a), { pending: null }) };
  const view = withAppChatIds(host, () => true);
  await view.switchTo(`acp:host-claude:${U}`, { harness: 'codex' }, { key: 'k' });
  assert.deepEqual(asked, [[claudeId, { harness: 'codex' }, { key: 'k' }]]);
});

test('B: the switch reaches an online machine’s Host now; a machine that is away, or none, fails with a short reason; a chat that runs here is null', async () => {
  const sent: any[] = [];
  const hosts: Record<string, any> = {
    online: { state: () => 'online', switchTo: async (...a: any[]) => (sent.push(a), { pending: { harness: 'codex' } }) },
    away: { state: () => 'offline', switchTo: async () => assert.fail('an offline machine is never asked') },
  };
  const owners: Record<string, string> = { here: 'local', r1: 'online', r2: 'away', r3: 'gone' };
  const make = createSwitch({
    isRemote: (id: string) => owners[id] !== 'local',
    hostFor: (hostId: string) => hosts[hostId],
    ownerOf: (id: string) => ({ hostId: owners[id] }),
    mintKey: () => 'key-mint-0000001',
  });
  assert.equal(make('here', { harness: 'codex' }), null);
  assert.deepEqual(await make('r1', { harness: 'codex' }), { pending: { harness: 'codex' } });
  assert.deepEqual(sent, [['r1', { harness: 'codex' }, { key: 'key-mint-0000001' }]]);
  for (const id of ['r2', 'r3']) await assert.rejects(make(id, { harness: 'codex' }) as Promise<unknown>, { message: SWITCH_AWAY });
});

test('I: the IPC answers a remote chat with the Host’s reply, and a chat of this Mac (or no remote service) with a refusal', async () => {
  const live = (route: any) => ({ remoteSend: () => (route ? { switchTo: route } : undefined) });
  const reply = { pending: null };
  assert.equal(
    await switchChat(
      live(() => Promise.resolve(reply)),
      7 as any,
      { harness: 'codex' },
    ),
    reply,
  );
  for (const l of [live(() => null), live(null), undefined])
    assert.throws(
      () => switchChat(l, undefined, { harness: 'codex' }),
      (e: any) => e.code === 'invalid' && /runs on this Mac/.test(e.message),
    );
});

test('I: `host:chatSwitch` is registered with the IPC and answers through the remote service of main', async () => {
  const { register } = require('../electron/app/ipc/host.cjs');
  const handlers = new Map<string, any>();
  const reached: any[] = [];
  const deps: any = {
    app: { getPath: () => '/ud' },
    shell: { openExternal: async () => undefined },
    shellEnv: { childEnv: () => ({}) },
    broadcastAll: () => undefined,
    live: {},
  };
  register({ handle: (c: string, fn: any) => handlers.set(c, fn) }, deps, {
    create: () => ({}),
    allowed: () => true,
    makeRemoteSend: () => () => ({ switchTo: (...a: any[]) => (reached.push(a), Promise.resolve({ pending: null })) }),
    makeRemoteChats: () => ({ get: () => undefined }),
  });
  const handler = handlers.get('host:chatSwitch');
  assert.ok(handler, 'the channel is registered');
  const out = await handler({}, `acp:host-claude:${U}`, { harness: 'codex' });
  assert.deepEqual(out, { value: { pending: null } });
  assert.deepEqual(reached, [[`acp:host-claude:${U}`, { harness: 'codex' }]]);
});
