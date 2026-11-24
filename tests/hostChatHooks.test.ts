// What the Mac's chat index tells main (electron/app/hostChatHooks.cjs): each change reaches the windows only while Host access is open, and a turn that ended or a card that waits on a machine reaches the desktop notifier unless this Mac follows that chat itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chatIndexHooks } = require('../electron/app/hostChatHooks.cjs');
const { openNotified } = require('../electron/app/computerAccess.cjs');

function rig(o: { allowed?: boolean; records?: string[]; owner?: string; name?: string | undefined } = {}) {
  const sent: any[] = [];
  const shown: any[] = [];
  const hooks = chatIndexHooks({
    deps: {
      broadcastAll: (c: string, p: unknown) => sent.push([c, p]),
      live: {
        notifier: { notify: (...a: any[]) => shown.push(a) },
        chats: { records: new Set(o.records ?? []) },
        hostOwnership: { get: () => ({ hostId: o.owner ?? 'local' }) },
      },
    },
    allowed: () => o.allowed ?? true,
    service: () => ({
      chatIndex: () => ['snapshot'],
      row: () => ('name' in o ? (o.name === undefined ? undefined : { name: o.name }) : { name: 'build-box' }),
    }),
  });
  return { hooks, sent, shown };
}

test('a change is sent to the windows with every machine’s chats; with Host access closed they hear nothing', () => {
  const open = rig();
  open.hooks.onChange();
  assert.deepEqual(open.sent, [['host:chatIndex', ['snapshot']]]);
  const closed = rig({ allowed: false });
  closed.hooks.onChange();
  assert.deepEqual(closed.sent, [['host:chatIndex', []]]);
});

test('a turn that ended on a machine is a turn notification and a card that waits an approval, under this app’s id for the chat', () => {
  const { hooks, shown } = rig();
  hooks.notify('m1', 'turnEnded', { chatId: 'claude:abc', title: 'Fix the build' });
  hooks.notify('m1', 'attention', { chatId: 'def', title: '' });
  assert.deepEqual(shown, [
    ['turn', 'acp:host-claude:abc', { title: 'Fix the build', chatTitle: 'Fix the build', body: 'Finished on build-box' }],
    ['approval', 'acp:host-codex:def', { title: 'Chat', chatTitle: 'Chat', body: 'Needs you on build-box' }],
  ]);
});

test('a chat this Mac has, in a window or on a machine, notifies from its own session; a machine without a name is still named', () => {
  const mine = rig({ records: ['acp:host-claude:abc'] });
  mine.hooks.notify('m1', 'turnEnded', { chatId: 'claude:abc', title: 't' });
  const onMachine = rig({ owner: 'm1' });
  onMachine.hooks.notify('m1', 'turnEnded', { chatId: 'claude:abc', title: 't' });
  assert.deepEqual([...mine.shown, ...onMachine.shown], []);
  const unnamed = rig({ name: undefined });
  unnamed.hooks.notify('gone', 'turnEnded', { chatId: 'x', title: 't' });
  assert.equal(unnamed.shown[0][2].body, 'Finished on a machine');
});

test('what the Host called a chat or a machine is one plain line: control characters, line breaks and bidi or zero-width marks are spaces, and it is cut', () => {
  const { hooks, shown } = rig({ name: 'box\u202Eevil\ngone\u200B' });
  hooks.notify('m1', 'turnEnded', { chatId: 'x', title: `fix\u0007 the\r\nbuild\u2066${'y'.repeat(300)}` });
  const [, , opts] = shown[0];
  assert.equal(opts.title.startsWith('fix the build '), true);
  assert.equal(opts.title.length <= 120, true);
  assert.equal(opts.title, opts.chatTitle);
  assert.doesNotMatch(opts.title + opts.body, /[\u0000-\u001f\u202a-\u202e\u2066-\u2069\u200b]/);
  assert.equal(opts.body, 'Finished on box evil gone');
  const { hooks: h2, shown: s2 } = rig({ name: '\u202E\u200B' });
  h2.notify('m1', 'attention', { chatId: 'x', title: '\n\u202E' });
  assert.deepEqual([s2[0][2].title, s2[0][2].body], ['Chat', 'Needs you on a machine']);
});

test('clicking the notification of a chat this Mac has no record of only asks the window to open it: nothing is started, sent or approved', async () => {
  const sent: unknown[][] = [];
  openNotified(null, async (...a: unknown[]) => void sent.push(a), 'acp:host-claude:chosen-by-the-host');
  openNotified({ get: () => undefined }, async (...a: unknown[]) => void sent.push(a), 'acp:host-codex:another');
  assert.deepEqual(sent, [
    ['open-chat', 'acp:host-claude:chosen-by-the-host'],
    ['open-chat', 'acp:host-codex:another'],
  ]);
});
