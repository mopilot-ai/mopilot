// Settings' Remove and archiving on the apps a chat was allowed (electron/capabilities/computerUse.cjs): Remove takes an app from the chat's saved list and its live session; archiving forgets both.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rig } = await import('./support/computer-use-setup-rig.ts');
const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };

test('Remove: a chat app goes from the saved list and the live session; an unknown app reports nothing removed', async () => {
  const r = rig();
  const { grants, desktop } = r.runtime;
  grants.grant(null, NOTES, 'view', 'always');
  assert.equal(await r.ipc('computer:revoke', 5, NOTES.bundleId), true);
  assert.equal(await r.ipc('computer:revoke', 5, NOTES.bundleId), false, 'not on the list any more');
  assert.equal(await r.ipc('computer:revoke', 'c', 42), false);
  // the chat's session had it from its card: Remove takes it from the chat as well, even with nothing saved
  desktop.session('c').apps.set('com.apple.notes', { ...NOTES, tier: 'full' });
  assert.equal(await r.ipc('computer:revoke', 'c', NOTES.bundleId), true);
  assert.equal(desktop.session('c').apps.size, 0);
});

test("archiving: the chat's saved apps are removed; a list that can't be changed doesn't stop the archive", async () => {
  const r = rig();
  const { grants } = r.runtime;
  grants.grant('c', NOTES, 'view', 'chat');
  assert.equal(grants.chat('c').length, 1);
  assert.equal(await r.ipc('computer:forget', 'c'), true);
  assert.deepEqual(grants.chat('c'), []);
  grants.grant('c', NOTES, 'view', 'chat');
  grants.revoke = () => {
    throw new Error('locked');
  };
  assert.equal(await r.ipc('computer:forget', 'c'), true);
});
