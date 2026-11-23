// The whole path from the Switch host dialog's IPC: this Mac to machine B and back, and machine B to C, over the real protocol, the real continue machine and the real switch runner; only the sockets, the ACP agent and the app-server are fakes (3.1, 3.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeHostProcess } from './support/hostProcessKit.ts';
import { transcriptItems } from './support/acp-transcript.ts';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { createContinueInbox } = require('../electron/host/continueInbox.cjs');

const CHAT = 'acp:gemini:c1';
const acpRecords = [
  { t: 'session', cwd: '/mac/app', sessionId: 's0' },
  { t: 'user', turnId: 't1', text: 'fix the login bug' },
];

function mac() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-e2e-'));
  const folderOnMac = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-e2e-mac-'));
  const hosts: Record<string, ReturnType<typeof makeHostProcess>> = { B: makeHostProcess('B'), C: makeHostProcess('C') };
  const chats = new ChatsStore(path.join(dir, 'threads'));
  chats.commit({
    ...chats.record(CHAT),
    segments: [{ kind: 'acp:gemini', nativeId: 'n0', instance: null, provider: null, model: null, start: 0, count: null }],
  });
  const log: string[] = [];
  const started: any[] = [];
  const acpHost = {
    items: transcriptItems(() => []),
    history: async () => [],
    ensure: async (key: string, o: any) => (
      started.push({ key, cwd: o.cwd }), { key, sessionId: 'new', agent: { caps: {} }, state: {}, harness: 'gemini' }
    ),
    emitEvent: () => undefined,
    chats: new Map(),
  };
  const inbox = createContinueInbox({ dir: path.join(dir, 'host-inbox') });
  const runner = new SwitchRunner({
    chats,
    ref: (id: string) => {
      const seg = chats.record(id).segments.at(-1);
      return { kind: seg.kind, id: seg.nativeId, instance: null, key: `${seg.kind}:${seg.nativeId}` };
    },
    invalidate: () => log.push('invalidate'),
    claim: () => undefined,
    unclaim: () => undefined,
    changed: (id: string) => log.push(`changed ${id}`),
    prefs: () => ({ permission: 'default', serviceTier: null, claudeBin: null }),
    home: folderOnMac,
    emit: () => undefined,
    git: { info: async () => null, status: async () => null },
    codex: {} as any,
    claude: {} as any,
    permissionParams: () => ({}),
    acpHost,
    continues: inbox,
  });
  // the folder a chat on this Mac runs in comes from its session's record
  const mine = () => acpRecords.map((r) => (r.t === 'session' ? { ...r, cwd: folderOnMac } : r));
  (acpHost as any).history = async () => mine();
  (acpHost as any).items = transcriptItems(mine);
  const live: any = {
    sessions: { has: () => true, snapshot: () => ({ turn: 'idle', queue: [] }) },
    chats: { records: new Map([[CHAT, {}]]) },
    switchRunner: runner,
  };
  const statuses: Record<string, string> = { B: 'online', C: 'online' };
  const machines = {
    list: () => ({ machines: Object.entries(statuses).map(([id, status]) => ({ id, status })), resolved: true }),
    session: async (id: string, onEvent?: (e: any) => void) => {
      const conn = hosts[id].protocol.connection((m: object) => onEvent?.(m));
      return {
        call: (m: string, p: object) => (m.startsWith('git.') ? Promise.resolve({ isRepo: false }) : conn.call(m, p)),
        close: () => conn.close(),
      };
    },
  };
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: (() => machines) as any, allowed: () => true },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  return { dir, folderOnMac, hosts, chats, runner, inbox, started, log, call };
}
const hello = { protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] };
let n = 0;
const key = () => `e2e-key-${String(++n).padStart(6, '0')}`;
async function send(host: ReturnType<typeof makeHostProcess>, epoch: number, text: string) {
  const conn = host.protocol.connection(() => undefined);
  await conn.call('host.hello', hello);
  return conn.call('chat.send', { chatId: CHAT, epoch, key: key(), text });
}

test('the dialog continues a chat from this Mac to B and back: each side serves it at the right moment and the conversation follows', async () => {
  const m = mac();
  // Mac to B
  const out = await m.call('host:continue', { chatId: CHAT, targetHostId: 'B', cwd: '/srv/app', lostHostConfirmed: false });
  assert.deepEqual(out, { value: { hostId: 'B', epoch: 1 } });
  assert.deepEqual(await m.call('host:owner', CHAT), { hostId: 'B', epoch: 1 });
  await send(m.hosts.B, 1, 'now on B');
  assert.match(m.hosts.B.sends[0].text, /^<sage-handoff from="Gemini"/);
  assert.equal(m.hosts.B.sends[0].cwd, '/srv/app');
  // B refuses a stale writer at the old epoch and says where the chat is
  await assert.rejects(
    send(m.hosts.B, 0, 'stale'),
    (e: any) => e.code === 'stale_epoch' || e.code === 'chat_released' || e.code === 'not_serving',
  );

  // B back to this Mac: the chat's next message opens a new session in the picked folder, with B's record in front of it
  const back = await m.call('host:continue', { chatId: CHAT, targetHostId: 'local', cwd: m.folderOnMac, lostHostConfirmed: false });
  assert.deepEqual(back, { value: { hostId: 'local', epoch: 2 } });
  const ps = m.runner.pendingContinue(CHAT);
  assert.equal(ps.continue.cwd, fs.realpathSync(m.folderOnMac));
  const settled = await m.runner.perform(CHAT, ps, 1);
  assert.equal(settled.ready, true);
  assert.match(settled.prefix, /now on B/);
  assert.match(settled.prefix, /Earlier in this conversation, handed over from another host/);
  assert.equal(m.runner.pendingContinue(CHAT), null, 'used once');
  assert.deepEqual(
    m.started.map((s) => s.cwd),
    [fs.realpathSync(m.folderOnMac)],
  );
  assert.equal(m.chats.record(CHAT).segments.length, 2);

  // and out again to C, from this Mac, at the next epoch
  const again = await m.call('host:continue', { chatId: CHAT, targetHostId: 'C', cwd: '/srv/other', lostHostConfirmed: false });
  assert.deepEqual(again, { value: { hostId: 'C', epoch: 3 } });
  await send(m.hosts.C, 3, 'on C');
  // the Mac's history across both of its segments (the fake agent's records carry no text, so the turns read as empty)
  assert.match(m.hosts.C.sends[0].text, /## Conversation so far/);
  assert.match(m.hosts.C.sends[0].text, /Directory: \/srv\/other/);
});

test('refusals reach the dialog as values with their code, and the chat stays where it was', async () => {
  const m = mac();
  const bad = await m.call('host:continue', {
    chatId: CHAT,
    targetHostId: 'B',
    cwd: '/srv/app',
    lostHostConfirmed: false,
    carry: { confirmed: false, untracked: [] },
  });
  assert.equal(bad.value.hostId, 'B');
  const same = await m.call('host:continue', { chatId: CHAT, targetHostId: 'B', cwd: '/srv/app', lostHostConfirmed: false });
  assert.equal(same.error.code, 'same_host');
  const nowhere = await m.call('host:continue', { chatId: CHAT, targetHostId: 'nowhere', cwd: '/srv/app', lostHostConfirmed: false });
  assert.equal(nowhere.error.code, 'target_offline');
  assert.deepEqual(await m.call('host:owner', CHAT), { hostId: 'B', epoch: 1 });
});
