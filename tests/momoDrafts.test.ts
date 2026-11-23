// MoMo's drafts in main (electron/app/momoDrafts.cjs): Open in Mail builds the mail link from the checked draft and opens only that, refused while MoMo is not allowed, for a draft that is not one, for one too long for a link, and when the system has no mail app; and the tool is wired to the chat store and the windows' chat-changed broadcast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openMomoDrafts, registerDraftIpc, openMailLink, CHANNELS, NOT_ALLOWED, NO_MAIL } = require('../electron/app/momoDrafts.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

function ipc() {
  const handlers = new Map<string, (e: unknown, input: unknown) => Promise<any>>();
  return {
    handlers,
    ipcMain: {
      handle: (c: string, fn: any) => void handlers.set(c, fn),
      removeHandler: (c: string) => void handlers.delete(c),
    },
  };
}

test('Open in Mail opens a mail link built from the draft, and only that', async () => {
  const { ipcMain, handlers } = ipc();
  const opened: string[] = [];
  registerDraftIpc(ipcMain, { openExternal: async (u: string) => void opened.push(u), allowed: () => true });
  const open = handlers.get('momoDraft:openInMail')!;
  assert.deepEqual(await open({}, { to: ['sam@example.com'], subject: 'Hi', body: 'Friday?' }), { ok: true });
  assert.deepEqual(opened, ['mailto:sam@example.com?subject=Hi&body=Friday%3F']);
  // the window can name words, never a link: extra fields are ignored and nothing but the mailto is opened
  await open({}, { to: [], subject: '', body: 'x', url: 'https://evil.test', href: 'file:///etc/passwd' });
  assert.deepEqual(opened.at(-1), 'mailto:?body=x');
  assert.ok(opened.every((u) => u.startsWith('mailto:')));
});

test('a draft that is not one, one too long for a link, and a closed MoMo open nothing', async () => {
  const { ipcMain, handlers } = ipc();
  const opened: string[] = [];
  const gate = { allowed: true };
  registerDraftIpc(ipcMain, { openExternal: (u: string) => void opened.push(u), allowed: () => gate.allowed });
  const open = handlers.get('momoDraft:openInMail')!;
  const bad = await open({}, { to: ['nope'], body: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_to');
  assert.equal((await open({}, null)).reason, 'bad_body');
  const long = await open({}, { body: 'x'.repeat(2500) });
  assert.deepEqual(long, { ok: false, reason: 'too_long', error: 'Too long to open in Mail. Copy it instead.' });
  gate.allowed = false;
  assert.deepEqual(await open({}, { body: 'x' }), NOT_ALLOWED);
  assert.deepEqual(opened, []);
});

test('no mail app: the answer is short and the draft is not lost', async () => {
  const { ipcMain, handlers } = ipc();
  registerDraftIpc(ipcMain, {
    openExternal: async () => {
      throw new Error('No application knows how to open mailto:');
    },
    allowed: () => true,
  });
  assert.deepEqual(await handlers.get('momoDraft:openInMail')!({}, { body: 'x' }), { ok: false, reason: 'no_mail_app', error: NO_MAIL });
});

test('registering twice is removed again by its own remover', () => {
  const { ipcMain, handlers } = ipc();
  const off = registerDraftIpc(ipcMain, { openExternal: () => undefined, allowed: () => true });
  assert.deepEqual([...handlers.keys()], [...CHANNELS]);
  off();
  assert.equal(handlers.size, 0);
});

test('the tool is wired to the chat store and tells the windows the chat changed; with no registry only Open in Mail exists', async () => {
  const { ipcMain, handlers } = ipc();
  const records = new Map([['momo-main', { meta: { notes: [] as any[] } }]]);
  const broadcasts: any[] = [];
  let running = true;
  const registry = new Registry();
  registry.setApprover(async () => true);
  const live = {
    capabilities: registry,
    chats: {
      record: (id: string) => records.get(id),
      patchMeta: (id: string, p: any) => (Object.assign(records.get(id)!.meta, p), true),
      get: (id: string) => ({ id }),
    },
    sessions: { get: (id: string) => (running && id === 'momo-main' ? { activeTurn: { id: 'ct-9' } } : undefined) },
  };
  const o = {
    ipcMain,
    live,
    shell: { openExternal: async () => undefined },
    broadcastAll: (...a: any[]) => void broadcasts.push(a),
    allowed: () => true,
    isMomoChat: (id: string) => id === 'momo-main',
    owner: (ctx: any) => ctx.chatId,
    passChat: () => false,
  };
  openMomoDrafts(o);
  assert.equal(handlers.has('momoDraft:openInMail'), true);
  const r = await registry.invoke('momo-main', 'claude:s1', 'momo_draft', { subject: 'S', body: 'B' });
  assert.equal(r.error, undefined);
  assert.equal(records.get('momo-main')!.meta.notes[0].turnId, 'ct-9');
  assert.deepEqual(broadcasts, [['chats:changed', { id: 'momo-main', chat: { id: 'momo-main' } }]]);
  // a chat with no running session has no turn to follow
  running = false;
  const idle = await registry.invoke('momo-main', 'claude:s1', 'momo_draft', { body: 'B' });
  assert.equal(idle.error, undefined);
  assert.equal(records.get('momo-main')!.meta.notes[1].turnId, null);
  // the Open in Mail handler still goes through shell.openExternal
  assert.deepEqual(await handlers.get('momoDraft:openInMail')!({}, { body: 'B' }), { ok: true });
  // no capability registry (a process that has no tools): no tool, but Open in Mail exists
  const bare = ipc();
  openMomoDrafts({ ...o, ipcMain: bare.ipcMain, live: { ...live, capabilities: null } });
  assert.equal(bare.handlers.has('momoDraft:openInMail'), true);
});

test('only a mail link is handed to the system, whatever asks', async () => {
  const opened: string[] = [];
  const open = async (u: string) => void opened.push(u);
  for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'tel:123', '', ' mailto:a@b.co'])
    assert.deepEqual(await openMailLink(url, open), { ok: false, reason: 'unavailable', error: NO_MAIL }, url);
  assert.deepEqual(opened, []);
  assert.deepEqual(await openMailLink('mailto:a@b.co?body=x', open), { ok: true });
  assert.deepEqual(opened, ['mailto:a@b.co?body=x']);
});

test('the renderer’s types for a draft and for Open in Mail are loadable modules, and the bridge declares its calls', async () => {
  await import('../src/lib/native/contracts/momoDraft.ts');
  await import('../src/lib/native/momoDraft.ts');
  const bridge = require('../electron/bridge/momoDraft.cjs');
  assert.deepEqual(Object.keys(bridge), ['openInMail', 'accounts', 'send', 'state', 'onState']);
  assert.deepEqual(bridge.send, { kind: 'invoke', channel: 'momoDraft:send', params: 1 });
  assert.deepEqual(bridge.accounts, { kind: 'invoke', channel: 'momoDraft:accounts', params: 0 });
  assert.deepEqual(bridge.state, { kind: 'invoke', channel: 'momoDraft:state', params: 1 });
  assert.deepEqual(bridge.onState, { kind: 'on', channel: 'momoDraft:state' });
  assert.deepEqual(bridge.openInMail, { kind: 'invoke', channel: 'momoDraft:openInMail', params: 1 });
});
