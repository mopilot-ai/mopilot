// A new chat starts in the Auto mode new chats use (prefs.autoRouteNewChats): its saved config says so, and its first
// message carries the mode for main, which may read that message before the config arrives.
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
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  impl['proxy.send'] = async () => ({ action: 'started', id: 'turn' });
  set({
    conn: 'ready',
    home: '/home/me',
    newChatProjectId: 'p',
    savedProjects: [{ id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' }],
  });
});

for (const mode of ['harness', 'global'] as const)
  test(`a new chat starts in ${mode} Auto when new chats use it`, async () => {
    set((s: any) => ({ prefs: { ...s.prefs, autoRouteNewChats: mode } }));
    assert.equal(await S.sendMessage(null, 'Fix it'), true);
    const [, text, , opts] = callsOf('proxy.send')[0];
    assert.equal(text, 'Fix it');
    assert.equal(opts.autoMode, mode);
    assert.equal(st().chatConfig['cx-/w/p'].autoRoute, mode);
  });

test('a new chat picks by hand when new chats do, and a chat already started carries nothing', async () => {
  set((s: any) => ({ prefs: { ...s.prefs, autoRouteNewChats: null } }));
  await S.sendMessage(null, 'Fix it');
  assert.equal(callsOf('proxy.send')[0][3].autoMode, undefined);
  assert.equal(st().chatConfig['cx-/w/p']?.autoRoute, undefined);
  set((s: any) => ({ prefs: { ...s.prefs, autoRouteNewChats: 'harness' } }));
  await S.sendMessage('cx-/w/p', 'More');
  assert.equal(callsOf('proxy.send').at(-1)![3].autoMode, undefined);
});
