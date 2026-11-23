// Review auto-fix wiring: the setting or the chat's PR Auto-fix turns it on, the controller's hooks feed it, and the fix
// request goes through the controller like any message, on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applyFixesRequest } from '../shared/reviewFindings.mjs';
import { autoApplyReviewFixes } from '../shared/reviewAutoFix.mjs';

const require = createRequire(import.meta.url);
const { attachReviewAutoFix } = require('../electron/app/reviewAutoFix.cjs');

const REVIEW = 'Review comment:\n\n- [P1] div multiplies — /r/calc.js:2\n  div(6, 3) is 18.';
const finding = { file: '/r/calc.js', line: 2, shortSummary: 'div multiplies', summary: 'div(6, 3) is 18.', category: 'P1' };
const tick = () => new Promise((r) => setImmediate(r));

function fixture({
  prefs = {} as Record<string, unknown>,
  snapshot = (_id: string): any => null,
  kind = 'codex',
  queue = [] as unknown[],
} = {}) {
  const sent: [string, any, unknown][] = [];
  const deleted: { onDeleted?: (r: { chatId: string }) => void } = {};
  const controller: any = {
    ref: () => ({ kind }),
    chatOf: (key: string) => key,
    requestThread: (thread: string) => thread,
    send: (chatId: string, item: any, origin: unknown) => sent.push([chatId, item, origin]),
  };
  const meta: Record<string, any> = {};
  const broadcasts: [string, any][] = [];
  const live = {
    controller,
    chats: {
      records: new Map([['chat', {}]]),
      record: () => ({ meta }),
      patchMeta: (_id: string, patch: object) => (Object.assign(meta, patch), true),
      get: (id: string) => ({ id, meta }),
    },
    sessions: { get: () => ({ queue }) },
    chatDeletion: deleted,
  };
  const blocked: string[] = [];
  const autoFix = attachReviewAutoFix({
    live,
    monitor: { snapshot },
    blocked: (id: string) => (blocked.push(id), null),
    readState: () => ({ prefs }),
    broadcastAll: (channel: string, payload: unknown) => broadcasts.push([channel, payload]),
  });
  const review = async (chatId = 'chat') => {
    controller.onLiveEvent('codex', {
      method: 'item/completed',
      params: { threadId: chatId, item: { type: 'exitedReviewMode', review: REVIEW } },
    });
    controller.onFinished({ chatId, completed: true, text: REVIEW });
    await tick();
  };
  return { controller, live, autoFix, sent, blocked, deleted, review, meta, broadcasts };
}

test('the setting reads true only when it is set', () => {
  assert.equal(autoApplyReviewFixes({ autoApplyReviewFixes: true }), true);
  for (const prefs of [{ autoApplyReviewFixes: 'yes' }, {}, null, undefined]) assert.equal(autoApplyReviewFixes(prefs as any), false);
});

test("with the setting on, a review's findings go to the chat through the controller, worded for the chat's harness", async () => {
  const codex = fixture({ prefs: { autoApplyReviewFixes: true } });
  await codex.review();
  assert.equal(codex.sent.length, 1);
  const [chatId, item, origin] = codex.sent[0];
  assert.equal(chatId, 'chat');
  assert.equal(origin, null);
  assert.equal(item.text, applyFixesRequest([finding], { reportTool: false }));
  assert.deepEqual(codex.blocked, ['chat'], "the PR monitor's gate is asked first");
  // shown as MoPilot's: the chat's meta says so, and every window hears of it before the input goes out
  assert.deepEqual(item.authored, { id: item.id });
  assert.deepEqual(
    { ...codex.meta.authored[item.id], at: 0 },
    { by: 'mopilot', title: 'Applying the code review’s finding', body: '/r/calc.js:2: div multiplies', at: 0 },
  );
  assert.deepEqual(codex.broadcasts, [['chats:changed', { id: 'chat', chat: { id: 'chat', meta: codex.meta } }]]);
  // a Claude Code chat is asked for the outcomes through ReportFindings
  const claude = fixture({ prefs: { autoApplyReviewFixes: true }, kind: 'claude' });
  await claude.review();
  assert.equal(claude.sent[0][1].text, applyFixesRequest([finding], { reportTool: true }));
  // the fix request's own dispatch is noted, so its turn is not a review to fix again
  await claude.controller.beforeDispatch({ chatId: 'chat', kind: 'turn', item: claude.sent[0][1] });
  assert.equal(claude.autoFix.turns.get('chat').auto, true);
});

test('with the setting off, only a chat whose open PR is monitored with Auto-fix applies them', async () => {
  const off = fixture();
  await off.review();
  const monitored = fixture({ snapshot: () => ({ autoFix: true, pr: { state: 'OPEN' } }) });
  await monitored.review();
  const notReadYet = fixture({ snapshot: () => ({ autoFix: true, pr: null }) });
  await notReadYet.review();
  const merged = fixture({ snapshot: () => ({ autoFix: true, pr: { state: 'MERGED' } }) });
  await merged.review();
  const watchedOnly = fixture({ snapshot: () => ({ autoFix: false, pr: { state: 'OPEN' } }) });
  await watchedOnly.review();
  const broken = fixture({
    snapshot: () => {
      throw new Error('Invalid PR monitor store');
    },
  });
  await broken.review();
  assert.deepEqual(
    [off, monitored, notReadYet, merged, watchedOnly, broken].map((f) => f.sent.length),
    [0, 1, 1, 0, 0, 0],
  );
});

test('a chat that is gone or has a message queued gets nothing; a hook that fails never holds up a message', async () => {
  const gone = fixture({ prefs: { autoApplyReviewFixes: true } });
  await gone.review('other');
  const queued = fixture({ prefs: { autoApplyReviewFixes: true }, queue: [{ id: 'q' }] });
  await queued.review();
  const noSession = fixture({ prefs: { autoApplyReviewFixes: true } });
  noSession.live.sessions.get = () => undefined as any;
  await noSession.review();
  assert.deepEqual([gone.sent.length, queued.sent.length, noSession.sent.length], [0, 0, 1]);
  // a dispatch the service can't read, and a live event that throws, are noted and passed
  const f = fixture({ prefs: { autoApplyReviewFixes: true } });
  await f.controller.beforeDispatch(null);
  f.controller.onLiveEvent('codex', {
    method: 'item/completed',
    params: {
      get threadId() {
        throw new Error('bad event');
      },
      item: { type: 'exitedReviewMode' },
    },
  });
  f.controller.onFinished(null);
  // a deleted chat's review is forgotten
  f.controller.onLiveEvent('codex', {
    method: 'item/completed',
    params: { threadId: 'chat', item: { type: 'exitedReviewMode', review: REVIEW } },
  });
  f.deleted.onDeleted!({ chatId: 'chat' });
  assert.equal(f.autoFix.turns.has('chat'), false);
});

test('with no chat deletion service, nothing hooks into one', () => {
  const controller: any = { ref: () => ({ kind: 'codex' }) };
  const autoFix = attachReviewAutoFix({
    live: { controller, chats: { records: new Map() }, sessions: { get: () => null } },
    monitor: { snapshot: () => null },
    blocked: () => null,
    readState: () => null,
    broadcastAll: () => {},
  });
  assert.ok(autoFix);
  assert.equal(typeof controller.onFinished, 'function');
});
