// Who sets a MoMo chat's pending harness switch and permission: MoMo's brain change alone, in main (electron/momo/mainChat.cjs
// reconcile writes the session state directly), on every harness; a window's patch of either is dropped
// (shared/momoCommands.mjs momoSessionPatch, applied by session:patch in electron/app/ipc/sessions.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/momoWorld.ts';

const { momoSessionPatch } = await import('../shared/momoCommands.mjs');

for (const [from, to] of [
  ['codex', 'claude'],
  ['claude', 'codex'],
  ['codex', 'acp:opencode'],
] as const) {
  test(`a brain change from ${from} to ${to} sets the switch in main, never through a window's patch`, async () => {
    const w = world({ prefs: { momo: { brain: { main: { harness: from } } } } });
    const { chatId } = await w.svc.ensureMainChat();
    // the window's route (session:patch → clientPatch) is not the brain's
    w.state.clientPatch = () => {
      throw new Error('a brain change went through a window patch');
    };
    const r = await w.svc.setBrain({ harness: to, ...(to === 'acp:opencode' ? {} : { model: 'm1', modelLabel: 'M1' }) });
    assert.equal(r.applied, 'nextMessage');
    const ps = w.state.get(chatId).pendingSwitch;
    assert.equal(ps.harness, to);
    // what a window could send for that chat is dropped, whatever it says
    assert.deepEqual(momoSessionPatch({ pendingSwitch: null }), {});
    assert.deepEqual(momoSessionPatch({ pendingSwitch: { ...ps, harness: from }, permission: 'full-access' }), {});
    assert.equal(w.state.get(chatId).pendingSwitch, ps);
  });
}
