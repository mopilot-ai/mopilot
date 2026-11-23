// src/store/send.ts startNewChat: a chat started at once on the harness family it is given (a new chat with a summary).
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
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
  impl['session.snapshot'] = async () => null;
});

test('startNewChat starts a chat on the family it is given, whatever new chats default to', async () => {
  set({ prefs: { ...st().prefs, defaultHarness: 'codex' } as any });
  const proj = { id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' } as any;
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  impl['claude.startClaudeThread'] = (o: any) => `cl-${o.cwd}`;
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:${o.cwd}`;
  assert.equal(await S.startNewChat('codex', { cwd: '/w/p', proj, ephemeral: undefined, basic: null }), 'cx-/w/p');
  assert.equal(callsOf('codex.startThread').at(-1)![0].projectId, 'cxp');
  assert.equal(await S.startNewChat('claude', { cwd: '/w/p', proj, ephemeral: undefined, basic: null }), 'cl-/w/p');
  assert.deepEqual(callsOf('claude.startClaudeThread').at(-1), [{ cwd: '/w/p', projectId: 'p', ephemeral: undefined }]);
  assert.equal(await S.startNewChat('acp', { cwd: '/w/p', proj: null, ephemeral: undefined, basic: 'kimi' }), 'acp:kimi:/w/p');
  assert.deepEqual(callsOf('acp.startAcpThread').at(-1), [{ cwd: '/w/p', projectId: null, harness: 'kimi' }]);
  impl['codex.startThread'] = () => Promise.reject(new Error('down'));
  await assert.rejects(S.startNewChat('codex', { cwd: '/w/p', proj, ephemeral: undefined, basic: null }), /down/);
});
