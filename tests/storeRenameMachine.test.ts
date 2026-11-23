// src/store/actions.ts renameThread for a chat on a machine: the name this Mac keeps stands, and the machine's refusal is said.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
});

test('renameThread keeps the name an ACP chat was given here even when its machine did not take it, and says why', async () => {
  set({ threads: { 'acp:host-claude:m1': { id: 'acp:host-claude:m1', name: 'old' } as any } });
  // the machine answered `{ error }`: the Mac's own record holds the name, so the chat shows it, with the machine's reason
  impl['acp.acpRename'] = async () => ({ error: 'Pocket Mac is too old for this. Update it.' });
  await S.renameThread('acp:host-claude:m1', 'Mine');
  assert.equal((st().threads['acp:host-claude:m1'] as any).name, 'Mine');
  assert.equal(st().toasts.at(-1)?.text, 'Pocket Mac is too old for this. Update it.');
  assert.equal(st().toasts.at(-1)?.kind, 'error');
  // a machine that took it, and a chat that runs here, say nothing
  const before = st().toasts.length;
  impl['acp.acpRename'] = async () => null;
  await S.renameThread('acp:host-claude:m1', 'Mine again');
  assert.equal((st().threads['acp:host-claude:m1'] as any).name, 'Mine again');
  assert.equal(st().toasts.length, before);
});
