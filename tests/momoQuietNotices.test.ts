// MoMo's chats make no system banner (electron/momo/quietNotices.cjs, Notifier.setQuiet in electron/platform/notify.cjs, #2139): through the app's one Notifier, a MoMo chat's turn, approval (from the real ChatController), cross-chat message, goal and auth notices show nothing while a coding chat's still do; scheduled and computer notices pass; with no quiet set every chat notifies as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { momoQuiet, MOMO_QUIET } = require('../electron/momo/quietNotices.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

function rig() {
  const shown: any[] = [];
  let t = 0;
  const notifier = new Notifier({
    getMode: () => 'always',
    now: () => (t += 120_000),
    show: (n: any) => (shown.push([n.chatId, n.title]), { close() {} }),
  });
  return { shown, notifier };
}

test('with no quiet set, every chat notifies as before', () => {
  const { shown, notifier } = rig();
  notifier.notify('turn', 'momo-1', { title: 'Done' });
  assert.deepEqual(shown, [['momo-1', 'Done']]);
});

test('every chat-keyed notice of a MoMo chat is kept back, from every caller; a coding chat’s and other kinds go through', () => {
  const { shown, notifier } = rig();
  notifier.setQuiet(momoQuiet((id: string) => id.startsWith('momo-')));
  const results: any[] = [];
  // the real controller's approval and finished-turn notices
  const rec = (id: string) => ({ id, segments: [{ kind: 'claude', nativeId: id }], meta: {} });
  const records = new Map(['momo-routine', 'coding-1'].map((id) => [id, rec(id)]));
  const controller = new ChatController({
    state: new SessionStore(),
    chats: { record: rec, records },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    notify: (kind: string, chatId: string, opts: any) => results.push([kind, chatId, notifier.notify(kind, chatId, opts) !== null]),
    chatTitle: (id: string) => `Title of ${id}`,
  });
  for (const chatId of ['momo-routine', 'coding-1']) {
    controller.state.patch(chatId, { turn: 'running' });
    controller.addApproval(chatId, { id: `a-${chatId}`, method: 'item/commandExecution/requestApproval', params: {} });
    controller.resolveApproval(`a-${chatId}`);
    controller.end(chatId);
  }
  // a cross-chat message delivered to a MoMo chat, a goal at its limit, computer use's OK: the callers app/ wires
  notifier.notify('turn', 'momo-routine', { title: 'Message from another chat' });
  notifier.notify('goal', 'momo-routine', { title: 'Codex', status: 'usageLimited' });
  notifier.notify('auth', 'momo-routine', { title: 'needs your OK' });
  assert.deepEqual(
    results.map((r) => r.slice(0, 2)),
    [
      ['approval', 'momo-routine'],
      ['turn', 'momo-routine'],
      ['approval', 'coding-1'],
      ['turn', 'coding-1'],
    ],
  );
  assert.deepEqual([results[0][2], results[1][2], results[2][2]], [false, false, true]);
  // the coding chat's turn notice is the Notifier's own to merge with its approval's: never kept back as MoMo's
  assert.equal(notifier.quiet('turn', 'coding-1'), false);
  assert.deepEqual(new Set(shown.map((s) => s[0])), new Set(['coding-1']), 'nothing shown for the MoMo chat');
  const before = shown.length;
  // a paired device's computer notice and a scheduled task's are not a MoMo chat's
  notifier.notify('computer', 'momo-device', { title: 'Computer use stopped' });
  notifier.notify('scheduled', 'momo-routine', { title: 'Scheduled task started' });
  assert.equal(shown.length, before + 2);
  assert.deepEqual([...MOMO_QUIET].sort(), ['approval', 'auth', 'goal', 'turn']);
  // only a true answer keeps a notice back
  notifier.setQuiet(momoQuiet(() => 'yes' as any));
  notifier.notify('turn', 'momo-routine', { title: 'Shown' });
  assert.equal(shown.length, before + 3);
});
