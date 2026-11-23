// recovery automation store cases using shared sandbox and Desktop fixtures.
import { test, assert, fs, path, writeTask, fakeDesktop, setup, base } from './fixture.ts';

export function registerRecovery() {
  test('removing a failed transfer deletes both copies and cannot resurrect on sync', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'delete-transfer', harness: 'codex' });
    const mocked = t.mock.method(fs.promises, 'rm', async () => {
      throw new Error('cleanup denied');
    });
    await assert.rejects(m.store.save({ ...original, harness: 'acp:opencode' }), /cleanup denied/);
    mocked.mock.restore();
    await m.store.remove('delete-transfer');
    await m.store.sync();
    assert.equal(m.has('codex', 'delete-transfer'), false);
    assert.equal(m.has('mopilot', 'delete-transfer'), false);
    assert.equal(await m.store.get('delete-transfer'), null);
  });

  for (const action of ['edit', 'delete']) {
    test(`a ${action} during transfer recovery cannot be overwritten or resurrected`, async (t) => {
      const m = setup(t);
      const original = await m.store.save({ ...base, id: 'racing', harness: 'codex' });
      const denied = t.mock.method(fs.promises, 'rm', async () => {
        throw new Error('cleanup denied');
      });
      await assert.rejects(m.store.save({ ...original, harness: 'claude' }), /cleanup denied/);
      denied.mock.restore();
      const remove = fs.promises.rm;
      let signal!: () => void;
      const entered = new Promise<void>((resolve) => {
        signal = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.mock.method(fs.promises, 'rm', async (folder: any, options: any) => {
        if (folder === path.join(m.root, 'codex', 'racing')) {
          signal();
          await gate;
        }
        return remove(folder, options);
      });
      const recovering = m.store.sync();
      await entered;
      const snapshot = await m.store.get('racing');
      const pending =
        action === 'delete' ? m.store.remove('racing') : m.store.save({ ...snapshot, harness: 'acp:opencode', prompt: 'Latest edit' });
      release();
      await Promise.all([recovering, pending]);
      if (action === 'delete') {
        assert.equal(await m.store.get('racing'), null);
        assert.equal(m.desktop.tasks.length, 0);
      } else {
        const current = await m.store.get('racing');
        assert.equal(current.harness, 'acp:opencode');
        assert.equal(current.prompt, 'Latest edit');
        assert.equal(current.status, 'ACTIVE');
        assert.equal(current.transfer_from, undefined);
        assert.equal(current.transfer_status, undefined);
        assert.equal(current.transfer_claude, undefined);
        assert.equal(m.desktop.tasks.length, 0);
      }
      await m.store.sync();
      if (action === 'delete') assert.equal(await m.store.get('racing'), null);
    });
  }

  test('the pending destination owns edits even when its old Codex source remains', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'retarget', harness: 'codex' });
    const mocked = t.mock.method(fs.promises, 'rm', async () => {
      throw new Error('cleanup denied');
    });
    await assert.rejects(m.store.save({ ...original, harness: 'claude' }), /cleanup denied/);
    mocked.mock.restore();
    const current = await m.store.get('retarget');
    assert.equal(current.harness, 'claude');
    assert.equal(current.status, 'ACTIVE');
    const edited = await m.store.save({ ...current, harness: 'codex', status: 'ACTIVE', prompt: 'Latest Codex edit' });
    assert.equal(edited.harness, 'codex');
    assert.equal(edited.status, 'ACTIVE');
    await m.store.sync();
    assert.equal(m.has('mopilot', 'retarget'), false);
    assert.equal(m.read('codex', 'retarget').prompt, 'Latest Codex edit');
  });

  test('editing a pending task preserves its requested status without an explicit resume', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'keep-status', harness: 'claude' });
    m.desktop.open = true;
    const waiting = await m.store.save({ ...original, harness: 'acp:opencode' });
    await m.store.save({ ...waiting, prompt: 'New text' });
    assert.equal(m.read('mopilot', 'keep-status').transfer_status, 'ACTIVE');
    m.desktop.open = false;
    await m.store.sync();
    assert.equal(m.read('mopilot', 'keep-status').status, 'ACTIVE');
  });

  test('a newly allocated task uses the same mutation identity as removal', async (t) => {
    const m = setup(t);
    let signal!: () => void;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(m.desktop, 'running', async () => {
      signal();
      await gate;
      return false;
    });
    const saving = m.store.save({ ...base, name: 'New task', harness: 'claude' });
    await entered;
    const task = (await m.store.list()).tasks[0];
    const removing = m.store.remove(task.id);
    release();
    await Promise.all([saving, removing]);
    assert.equal(await m.store.get(task.id), null);
    assert.equal(m.desktop.tasks.length, 0);
  });

  test('native sync rechecks a pending file deleted after its initial read', async (t) => {
    const m = setup(t, fakeDesktop({ running: true }));
    await m.store.save({ ...base, id: 'vanished', harness: 'claude' });
    m.desktop.open = false;
    const file = path.join(m.root, 'mopilot', 'vanished', 'automation.toml');
    const read = fs.promises.readFile;
    let reads = 0;
    t.mock.method(fs.promises, 'readFile', async (name: any, options: any) => {
      const text = await read(name, options);
      if (name === file && ++reads === 2) fs.unlinkSync(file);
      return text;
    });
    await m.store.sync();
    assert.equal(await m.store.get('vanished'), null);
    assert.deepEqual(m.desktop.calls, []);
  });

  test('explicit pause of a pending transfer stays paused after recovery', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'explicit-pause', harness: 'claude' });
    m.desktop.open = true;
    const waiting = await m.store.save({ ...original, harness: 'acp:opencode' });
    assert.equal(waiting.status, 'ACTIVE');
    const paused = await m.store.save({ ...waiting, status: 'PAUSED' });
    assert.equal(paused.status, 'PAUSED');
    m.desktop.open = false;
    await m.store.sync();
    assert.equal(m.read('mopilot', 'explicit-pause').status, 'PAUSED');
  });

  test('a pending native transfer keeps its new prompt and requested status', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'native-retarget', harness: 'claude' });
    m.desktop.open = true;
    const waiting = await m.store.save({ ...original, harness: 'codex' });
    const denied = t.mock.method(fs.promises, 'rm', async () => {
      throw new Error('cleanup denied');
    });
    await assert.rejects(m.store.save({ ...waiting, harness: 'claude', prompt: 'Latest prompt', status: 'PAUSED' }), /cleanup denied/);
    denied.mock.restore();
    const latest = await m.store.get('native-retarget');
    assert.equal(latest.prompt, 'Latest prompt');
    assert.equal(latest.status, 'PAUSED');
    assert.equal(latest.native_app, 'claude-desktop');
    assert.equal(latest.runs_in.transfer, 'pending');
  });

  test('migration does not overwrite a task changed after discovery', async (t) => {
    const m = setup(t);
    await writeTask(path.join(m.root, 'codex'), { ...base, id: 'changed-migration', harness: 'claude' });
    const file = path.join(m.root, 'codex', 'changed-migration', 'automation.toml');
    const read = fs.promises.readFile;
    let reads = 0;
    t.mock.method(fs.promises, 'readFile', async (name: any, options: any) => {
      const text = await read(name, options);
      if (name === file && ++reads === 1)
        await writeTask(path.join(m.root, 'codex'), { ...base, id: 'changed-migration', harness: 'codex', prompt: 'Latest' });
      return text;
    });
    assert.deepEqual(await m.store.migrate(), []);
    assert.equal(m.read('codex', 'changed-migration').prompt, 'Latest');
    assert.equal(m.has('mopilot', 'changed-migration'), false);
  });

  test('a stale pending-task payload cannot replay a completed transfer', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'stale-intent', harness: 'claude' });
    m.desktop.open = true;
    const pending = await m.store.save({ ...original, harness: 'acp:opencode' });
    m.desktop.open = false;
    await m.store.sync();
    const edited = await m.store.save({ ...pending, prompt: 'Later edit' });
    assert.equal(edited.transfer_from, undefined);
    assert.equal(edited.transfer_status, undefined);
    assert.equal(edited.transfer_claude, undefined);
    assert.equal(edited.status, 'ACTIVE');
    await m.store.sync();
    assert.equal(m.read('mopilot', 'stale-intent').prompt, 'Later edit');
  });
}
