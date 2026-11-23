// Main's one TurnChanges (electron/app/sessions.cjs): the Codex adapter records its turns' changes on it, and the
// snapshots every other family's turns take land on the same one, so a chat's changes don't depend on its harness.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
after(() => unloadMain());

test('main gives the Codex adapter and the turn snapshots the same TurnChanges', async () => {
  const h = await loadMain();
  await h.ready();
  const changes = h.one('CodexAdapter').opts.turnChanges;
  assert.equal(typeof changes?.begin, 'function', 'a TurnChanges');
  assert.equal(h.one('ChatController').turnSnapshots.changes, changes);
});
