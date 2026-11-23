// Panel titles and limit notices come only from the current native adapter and its pinned account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { panelIdentity } = require('../electron/app/chromePanelIdentity.cjs');
const { CapsService } = require('../electron/session/caps.cjs');

function fixture(kind: string = 'codex') {
  let ref: any = { kind, key: 'native-key', id: 'native-id' };
  const record = {};
  const live: any = { controller: { ref: () => ref }, chats: { records: new Map([['chat', record]]) } };
  return {
    live,
    change: (r: any) => {
      ref = r;
    },
  };
}

test('each adapter reads its own title; native whitespace and long Unicode titles are bounded', async () => {
  for (const kind of ['codex', 'claude', 'acp:goose']) {
    const f = fixture(kind);
    const calls: any[] = [];
    f.live.codex = { chatName: (id: string) => (calls.push(id), '  Booking\n refund  ') };
    f.live.acpHost = { titleOf: (key: string) => (calls.push(key), { name: '  Booking\n refund  ' }) };
    const claude = { info: (id: string) => (calls.push(id), { customTitle: '  Booking\n refund  ' }) };
    assert.deepEqual(await panelIdentity(f.live, claude, 'chat'), { title: 'Booking refund' });
    assert.deepEqual(calls, [kind === 'codex' ? 'chat' : kind === 'claude' ? 'native-id' : 'native-key']);
  }
  const f = fixture();
  f.live.codex = { chatName: () => '😀'.repeat(100) };
  assert.equal([...(await panelIdentity(f.live, {}, 'chat')).title].length, 80);
});

test('missing, malformed and failed native metadata leave the transcript usable', async () => {
  for (const kind of ['codex', 'claude', 'acp:goose', 'unknown']) {
    const f = fixture(kind);
    assert.deepEqual(await panelIdentity(f.live, {}, 'chat'), {});
  }
  const f = fixture();
  f.change(null);
  assert.deepEqual(await panelIdentity(f.live, {}, 'chat'), {});
  f.change({ kind: 'codex', key: 'n' });
  f.live.codex = {
    chatName: () => {
      throw new Error('native title unavailable');
    },
  };
  f.live.capsService = {
    accountLimit: () => {
      throw new Error('identity unavailable');
    },
  };
  assert.deepEqual(await panelIdentity(f.live, {}, 'chat'), {});
  f.live.codex.chatName = () => ({ title: 'invalid boundary' });
  assert.deepEqual(await panelIdentity(f.live, {}, 'chat'), {});
});

test('a delayed title from a retired native session or deleted/replaced record is never published', async () => {
  for (const change of ['kind', 'key', 'deleted', 'record', 'no-ref']) {
    const f = fixture('claude');
    let finish: any;
    const pending = panelIdentity(
      f.live,
      {
        info: () =>
          new Promise((r) => {
            finish = r;
          }),
      },
      'chat',
    );
    await new Promise((r) => setImmediate(r));
    if (change === 'kind') f.change({ kind: 'codex', key: 'native-key' });
    if (change === 'key') f.change({ kind: 'claude', key: 'new-key' });
    if (change === 'deleted') f.live.chats.records.delete('chat');
    if (change === 'record') f.live.chats.records.set('chat', {});
    if (change === 'no-ref') f.change(null);
    finish({ customTitle: 'Obsolete' });
    assert.deepEqual(await pending, {});
  }
});

test('limit notices follow the actual Codex pin or Claude login, with none for an unknown or basic account', async () => {
  for (const kind of ['codex', 'claude', 'acp:goose', 'unknown']) {
    const f = fixture(kind);
    const active = { id: 'active', active: true, account: 'a', label: 'Active', limited: false };
    const pinned = { id: 'pin', account: 'b', label: 'Pinned', limited: true };
    f.live.capsService = new CapsService({
      ref: f.live.controller.ref,
      instances: () => [active, pinned],
      chatInstance: () => pinned,
      claudeLogin: () => 'b',
    });
    const notice = { key: 'pin', text: 'Usage limit reached on Pinned.' };
    assert.deepEqual(await panelIdentity(f.live, {}, 'chat'), ['codex', 'claude'].includes(kind) ? { limit: notice } : {});
    pinned.limited = false;
    assert.equal(f.live.capsService.accountLimit('chat'), null);
  }
  const f = fixture();
  f.change(null);
  assert.equal(new CapsService({ ref: f.live.controller.ref }).accountLimit('chat'), null);
});

test('a title reader that stops answering cannot hide the conversation behind its metadata', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('claude');
  let finish: any;
  const pending = panelIdentity(
    f.live,
    {
      info: () =>
        new Promise((r) => {
          finish = r;
        }),
    },
    'chat',
  );
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(3000);
  assert.deepEqual(await pending, {});
  finish({ customTitle: 'Late' });
  await new Promise((r) => setImmediate(r));
});
