// Scheduled tasks that run on a remote machine in the store (electron/platform/automationStore.cjs): kept in MoPilot's folder on every harness, never given to the Codex app or Claude Desktop (which would run them on this Mac), moved out of a native app's hands when a task moves to a machine, and a heartbeat's chat dropped when the machine changes.
import { test, assert, fs, path, writeTask, setup, base } from './support/automation-store/fixture.ts';

test('a machine task on any harness lives in MoPilot’s folder and is run by MoPilot alone', async (t) => {
  const m = setup(t);
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    const id = `on-box-${harness.replace(':', '-')}`;
    const saved = await m.store.save({ ...base, id, harness, host_id: 'box', cwds: ['/srv/app'], execution_environment: 'worktree' });
    assert.equal(saved.home, 'mopilot', harness);
    assert.equal(saved.native_app, null, harness);
    assert.deepEqual(saved.runs_in, { apps: ['mopilot'] }, harness);
    assert.equal(saved.claude_desktop, undefined, harness);
    assert.equal(m.has('codex', id), false, harness);
    assert.equal(m.read('mopilot', id).host_id, 'box');
    // a machine run uses its folder there, whatever asked for a worktree (a chat tool)
    assert.equal(saved.execution_environment, 'local');
  }
  assert.deepEqual(m.desktop.calls, []);
});

test('a task that moves from this Mac to a machine leaves the Codex app and Claude Desktop first', async (t) => {
  const m = setup(t);
  const codex = await m.store.save({ ...base, id: 'codex-task', harness: 'codex' });
  assert.equal(codex.home, 'codex');
  const moved = await m.store.save({ ...codex, host_id: 'box' });
  assert.equal(moved.home, 'mopilot');
  assert.equal(moved.status, 'ACTIVE');
  assert.equal(m.has('codex', 'codex-task'), false);
  const claude = await m.store.save({ ...base, id: 'claude-task', harness: 'claude' });
  assert.equal(claude.native_app, 'claude-desktop');
  assert.ok(m.desktop.tasks.some((d: any) => d.id === 'claude-task'));
  const away = await m.store.save({ ...claude, host_id: 'box' });
  assert.equal(away.native_app, null);
  assert.equal(away.claude_desktop, undefined);
  assert.equal(
    m.desktop.tasks.some((d: any) => d.id === 'claude-task'),
    false,
  );
  // and back to this Mac: the Codex app has it again
  const back = await m.store.update('codex-task', { host_id: undefined });
  assert.equal(back.home, 'codex');
  assert.equal(m.has('mopilot', 'codex-task'), false);
});

test('a heartbeat’s chat stays with the machine it started on: a move drops it, an edit on the same machine keeps it', async (t) => {
  const m = setup(t);
  const hb = await m.store.save({ ...base, id: 'hb', kind: 'heartbeat', harness: 'acp:kimi', target_thread_id: 'acp:kimi:local-chat' });
  const moved = await m.store.update('hb', { host_id: 'box' });
  assert.equal(moved.target_thread_id, undefined);
  assert.equal(await m.store.rememberChat(moved, 'acp:kimi:on-box'), true);
  const edited = await m.store.update('hb', { prompt: 'changed' });
  assert.equal(edited.target_thread_id, 'acp:kimi:on-box');
  // a chat started for the task on this Mac is not remembered once it runs on a machine
  await m.store.update('hb', { host_id: 'other', target_thread_id: undefined });
  assert.equal(await m.store.rememberChat(hb, 'acp:kimi:late'), false);
});

test('migrate moves a machine task out of the Codex app’s folder and leaves the Codex app’s own tasks', async (t) => {
  const m = setup(t);
  await writeTask(path.join(m.root, 'codex'), { ...base, id: 'old-box', harness: 'codex', host_id: 'box' });
  await writeTask(path.join(m.root, 'codex'), { ...base, id: 'own', harness: 'codex' });
  await writeTask(path.join(m.root, 'codex'), { ...base, id: 'bare' });
  assert.deepEqual(await m.store.migrate(), ['old-box']);
  assert.equal(m.read('mopilot', 'old-box').host_id, 'box');
  assert.ok(fs.existsSync(path.join(m.root, 'codex', 'own')));
  assert.ok(fs.existsSync(path.join(m.root, 'codex', 'bare')));
});
