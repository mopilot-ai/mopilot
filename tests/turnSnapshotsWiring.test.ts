// Main's turn snapshot wiring (electron/app/sessions.cjs, electron/main.cjs), over a fake Electron: the controller gets the
// shared snapshots, their diffs reach every window, and claude:turns reads the saved ones back.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test("the controller's turn snapshots publish to windows and restore what the transcripts read back", async () => {
  const h = await loadMain();
  await h.ready();
  const snapshots = h.one('ChatController').turnSnapshots;
  assert.equal(snapshots.constructor.name, 'TurnSnapshots');
  // the same TurnChanges as the Codex adapter's
  assert.equal(snapshots.changes, h.one('CodexAdapter').opts.turnChanges);
  snapshots.publish({ chatId: 'cl1', turnId: 'ct-p1', diff: 'patch' });
  mock.timers.tick(50);
  assert.deepEqual(h.windows[0].webContents.on_('session:turnDiff').at(-1)[0], { chatId: 'cl1', turnId: 'ct-p1', diff: 'patch' });
  // a running turn's diff is for the windows showing the chat; with no view reported, this window may show it
  snapshots.publish({ chatId: 'cl1', turnId: 'ct-p1', diff: 'live' }, true);
  assert.deepEqual(h.windows[0].webContents.on_('session:turnDiff').at(-1)[0], { chatId: 'cl1', turnId: 'ct-p1', diff: 'live' });
  assert.equal(snapshots.shows('cl1'), false, 'no window reported a view of it');
  snapshots.changes.store.write('claude:s1', { p1: 'saved' });
  snapshots.changes.store.write('acp:kimi:a1', { p2: 'acp saved' });
  const claudeHooks = h.claude.register.mock.calls[0].arguments[2];
  assert.equal(typeof claudeHooks.pages, 'function');
  assert.deepEqual(snapshots.savedDiffs('claude:s1', ['h-p1']), { 'h-p1': 'saved' });
  const acpHooks = h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2];
  assert.deepEqual(acpHooks.diffs('acp:kimi:a1', ['at-p2']), { 'at-p2': 'acp saved' });
});

test('before the controller has snapshots, the transcripts read back as they are', async () => {
  const h = await loadMain();
  await h.ready();
  h.one('ChatController').turnSnapshots = null;
  assert.deepEqual(h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2].diffs('acp:kimi:a1', ['at-p2']), {});
});
