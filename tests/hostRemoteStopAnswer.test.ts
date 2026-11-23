// Stop and approvals for a chat that runs on a machine: the controller sends Stop to the Host before it marks the turn interrupted (electron/session/controllerSends.cjs acpCancel), and the acp:permission IPC answers a machine's card there (electron/harness/acp/ipc.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';

const { register } = createRequire(import.meta.url)('../electron/harness/acp/ipc.cjs');
const CHAT = 'acp:kimi:c1';

const running = (c: any, chatId = CHAT) => c.state.patch(chatId, { turn: 'running', activeTurn: { id: 't1', human: true } });

test('Stop on a chat on a machine reaches the Host first; only then is the turn marked interrupted, and nothing is cancelled here', async () => {
  const { c, acpCancels } = setup();
  running(c);
  const seen: any[] = [];
  c.remote = { stop: (chatId: string, turnId: unknown) => (seen.push([chatId, turnId]), Promise.resolve({ stopped: true })) };
  assert.equal(await c.acpCancel(CHAT, 't1'), true);
  assert.deepEqual(seen, [[CHAT, 't1']]);
  assert.equal(c.rt(CHAT).interrupted, true);
  assert.deepEqual(acpCancels, []);
});

test('A3: a Stop the Host does not get changes nothing: the turn stays running and the window is told why', async () => {
  const { c, acpCancels } = setup();
  running(c);
  c.remote = { stop: () => Promise.reject(new Error('Can’t reach the machine.')) };
  await assert.rejects(Promise.resolve(c.acpCancel(CHAT, 't1')), /reach the machine/);
  assert.notEqual(c.rt(CHAT).interrupted, true);
  assert.equal(c.state.get(CHAT).turn, 'running');
  assert.deepEqual(acpCancels, []);
});

test('a chat that runs here, a Stop for a turn that is not running, and a controller with no Host wiring are as before', async () => {
  const { c, acpCancels } = setup();
  running(c);
  // the default wiring knows no remote chats
  assert.equal(c.acpCancel(CHAT, 't1'), true);
  assert.deepEqual(acpCancels, [CHAT]);
  const asked: string[] = [];
  c.remote = { stop: (chatId: string) => (asked.push(chatId), null) };
  assert.equal(c.acpCancel(CHAT, 't1'), true);
  assert.equal(c.acpCancel(CHAT, 'another-turn'), 'retired');
  assert.deepEqual(asked, [CHAT]);
});

function ipc(remoteAnswer?: (id: string, option: string | null) => Promise<boolean> | null) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const local: any[] = [];
  const resolved: string[] = [];
  const host = Object.assign(new EventEmitter(), { permission: (id: string, option: string | null) => (local.push([id, option]), true) });
  register({ handle: (n: string, fn: any) => handlers.set(n, fn) }, host, {
    broadcast: () => undefined,
    onPermission: (id: string) => resolved.push(id),
    ...(remoteAnswer ? { routes: { remoteChats: () => ({ answer: remoteAnswer }) } } : {}),
  });
  return { permit: (...a: any[]) => handlers.get('acp:permission')!({}, ...a), local, resolved };
}

test("a card of a machine's chat is answered there and not here; this Mac's own cards still are", async () => {
  const sent: any[] = [];
  const w = ipc((id, option) => (id === 'remote-card' ? (sent.push([id, option]), Promise.resolve(true)) : null));
  assert.equal(await w.permit('remote-card', 'allow'), true);
  assert.equal(await w.permit('local-card', undefined), true);
  assert.deepEqual(sent, [['remote-card', 'allow']]);
  assert.deepEqual(w.local, [['local-card', null]]);
  assert.deepEqual(w.resolved, ['remote-card', 'local-card']);
});

test('a card the Host cannot be given the answer to rejects, so the window keeps the card', async () => {
  const w = ipc(() => Promise.reject(new Error('away')));
  await assert.rejects(w.permit('c', 'allow'), /away/);
  assert.deepEqual(w.local, []);
  // the card stays in main's state (and so its needs-you), not only in the window
  assert.deepEqual(w.resolved, []);
});

test('without a remote route the answer is the local Host’s', async () => {
  const w = ipc();
  assert.equal(await w.permit('c', 'allow'), true);
  assert.deepEqual(w.local, [['c', 'allow']]);
});

test('with no Host wiring, or Host off (no remote chats service), the answer is the local Host’s', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const host = Object.assign(new EventEmitter(), { permission: () => true });
  register({ handle: (n: string, fn: any) => handlers.set(n, fn) }, host, {
    broadcast: () => undefined,
    routes: { remoteChats: () => null },
  });
  assert.equal(await handlers.get('acp:permission')!({}, 'c', 'allow'), true);
  register({ handle: (n: string, fn: any) => handlers.set(n, fn) }, host, { broadcast: () => undefined, routes: {} });
  assert.equal(await handlers.get('acp:permission')!({}, 'c', 'allow'), true);
});
