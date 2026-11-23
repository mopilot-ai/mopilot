// The new-chat composer's side of prewarm (src/store/prewarm.ts, #1664) over the real store: what each family's
// new chat would start, a spec sent once per change and again as a heartbeat, null on leaving Home, and the first
// send taking what main warmed (a Codex thread, a Claude session id) or starting cold when there is none.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const P = await import('../src/store/prewarm.ts');
const { codexThreadParams } = await import('../src/store/projects.ts');

const PROJECT = { id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' };
const onClaude = () =>
  set({ prefs: { ...st().prefs, defaultHarness: 'claude' }, claude: { status: { state: 'apikey' } as any, models: [] } });

beforeEach(() => {
  resetState();
  resetAll();
  set({ conn: 'ready', home: '/home/me', route: { name: 'home' } });
});

test('what each family would start: Claude needs a known folder; Codex warms its app-server without one; ACP its process', () => {
  set({ newChatProjectId: 'none' });
  assert.deepEqual(P.prewarmSpec(), { kind: 'codex', params: null });
  set({ newChatProjectId: 'p', savedProjects: [PROJECT] as any });
  assert.deepEqual(P.prewarmSpec(), {
    kind: 'codex',
    params: codexThreadParams(st().prefs, { cwd: '/w/p', projectId: 'cxp' }),
  });
  // a worktree's folder is made on send
  S.setNewChatWorktree(true);
  assert.deepEqual(P.prewarmSpec(), { kind: 'codex', params: null });
  // a folder picked outside any project, in a worktree, too
  set({ newChatCwd: '/else', newChatProjectId: null });
  assert.deepEqual(P.prewarmSpec(), { kind: 'codex', params: null });
  S.setNewChatWorktree(false);
  onClaude();
  assert.deepEqual(P.prewarmSpec(), { kind: 'claude', cwd: '/else' });
  set({ newChatProjectId: 'none', newChatCwd: null });
  assert.equal(P.prewarmSpec(), null, 'a projectless Claude chat gets its folder on send');
  set({ prefs: { ...st().prefs, defaultHarness: 'acp:opencode' }, basicHarnesses: [{ id: 'opencode', state: 'admitted' }] as any });
  assert.deepEqual(P.prewarmSpec(), { kind: 'acp:opencode' });
  // nothing for a temporary chat, or off Home
  set({ newChatTemporary: true });
  assert.equal(P.prewarmSpec(), null);
  set({ newChatTemporary: false, route: { name: 'thread', id: 'x' } as any });
  assert.equal(P.prewarmSpec(), null);
});

test('the composer tells main once per change, again every minute while in front, and null when it leaves Home', async () => {
  set({ newChatCwd: '/w', newChatProjectId: null, focused: true });
  const stop = P.startPrewarm();
  try {
    const sent = () => callsOf('session.prewarm').map(([spec]) => spec);
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].params.cwd, '/w');
    // a change that leaves the spec as it is sends nothing
    set({ toasts: [] });
    set({ savedProjects: [] });
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().length, 1);
    // (the settle a heartbeat schedules fires on its own tick)
    mock.timers.tick(P.HEARTBEAT_MS);
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().length, 2, 'the heartbeat');
    // behind other windows it goes quiet, so main lets the entry go idle
    set({ focused: false });
    mock.timers.tick(P.HEARTBEAT_MS);
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().length, 2);
    set({ focused: true });
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().length, 3, 'back in front after a while: warm again');
    set({ prefs: { ...st().prefs, model: 'gpt-6-mini' } });
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().at(-1).params.model, 'gpt-6-mini');
    set({ route: { name: 'thread', id: 'n1' } as any });
    mock.timers.tick(P.SETTLE_MS);
    assert.equal(sent().at(-1), null);
  } finally {
    stop();
  }
});

test("a new Codex chat's first send takes the warmed thread with the same params; without one it starts its own", async () => {
  set({ newChatCwd: '/w', newChatProjectId: null });
  impl['session.prewarmTake'] = async () => ({ thread: { id: 'warm-1', cwd: '/w' } });
  assert.equal(await S.createChatThread('hi'), 'warm-1');
  assert.deepEqual(callsOf('session.prewarmTake')[0], [{ kind: 'codex', params: codexThreadParams(st().prefs, { cwd: '/w' }) }]);
  assert.equal(callsOf('codex.startThread').length, 0);
  // nothing warm (or a take that failed): thread/start as before
  impl['session.prewarmTake'] = async () => null;
  impl['codex.startThread'] = async () => ({ thread: { id: 'cold-1', cwd: '/w' } });
  assert.equal(await S.createChatThread('hi'), 'cold-1');
  impl['session.prewarmTake'] = () => Promise.reject(new Error('main went away'));
  assert.equal(await S.createChatThread('hi'), 'cold-1');
  // a temporary chat takes nothing
  const takes = callsOf('session.prewarmTake').length;
  set({ newChatTemporary: true });
  await S.createChatThread('hi');
  assert.equal(callsOf('session.prewarmTake').length, takes);
});

test("a new Claude chat runs under the warmed CLI's session id, or a new one; a temporary chat takes nothing", async () => {
  onClaude();
  set({ newChatCwd: '/w', newChatProjectId: null });
  impl['session.prewarmTake'] = async () => ({ id: 'sid-warm' });
  await S.createChatThread('hi');
  assert.deepEqual(callsOf('session.prewarmTake').at(-1), [{ kind: 'claude', cwd: '/w' }]);
  assert.equal(callsOf('claude.startClaudeThread').at(-1)![0].sid, 'sid-warm');
  for (const answer of [null, { id: 7 }]) {
    impl['session.prewarmTake'] = async () => answer;
    await S.createChatThread('hi');
    assert.equal('sid' in callsOf('claude.startClaudeThread').at(-1)![0], false);
  }
  impl['session.prewarmTake'] = () => Promise.reject(new Error('gone'));
  assert.deepEqual(await P.takeClaudeSession('/w'), {});
  const takes = callsOf('session.prewarmTake').length;
  set({ newChatTemporary: true });
  await S.createChatThread('hi');
  await flush();
  assert.equal(callsOf('session.prewarmTake').length, takes);
  assert.equal('sid' in callsOf('claude.startClaudeThread').at(-1)![0], false);
});
