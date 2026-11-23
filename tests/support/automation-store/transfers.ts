// transfers automation store cases using shared sandbox and Desktop fixtures.
import { test, assert, fs, path, writeTask, DESKTOP, fakeDesktop, setup, base } from './fixture.ts';

export function registerTransfers() {
  for (const from of ['codex', 'claude', 'acp:opencode']) {
    for (const to of ['codex', 'claude', 'acp:opencode']) {
      if (from === to) continue;
      test(`failed ${from} → ${to} destination save preserves the original task and native registration`, async (t) => {
        const m = setup(t);
        const original = await m.store.save({ ...base, id: 'transfer', name: 'Original', harness: from });
        const home = from === 'codex' ? 'codex' : 'mopilot';
        const before = fs.readFileSync(path.join(m.root, home, 'transfer', 'automation.toml'), 'utf8');
        const native = structuredClone(m.desktop.tasks);
        const calls = m.desktop.calls.length;
        const rename = fs.renameSync;
        const destination = path.join(m.root, to === 'codex' ? 'codex' : 'mopilot', 'transfer', 'automation.toml');
        const mocked = t.mock.method(fs, 'renameSync', (source: any, target: any) => {
          if (target === destination) throw new Error('destination denied');
          return rename(source, target);
        });
        await assert.rejects(m.store.save({ ...original, harness: to, prompt: 'Changed' }), /destination denied/);
        mocked.mock.restore();
        assert.equal(fs.readFileSync(path.join(m.root, home, 'transfer', 'automation.toml'), 'utf8'), before);
        assert.deepEqual(m.desktop.tasks, native);
        assert.equal(m.desktop.calls.length, calls, 'no native mutation before the destination is saved');
        assert.equal(m.read(home, 'transfer').harness, from);
      });
    }
  }

  test('failed Desktop-only task conversion preserves its native schedule', async (t) => {
    const original = { ...base, id: 'native-transfer', harness: 'claude', name: 'Original' };
    const m = setup(t, fakeDesktop({ tasks: [original] }));
    const native = structuredClone(m.desktop.tasks);
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('destination denied');
    });
    await assert.rejects(m.store.save({ ...original, harness: 'acp:opencode' }), /destination denied/);
    assert.deepEqual(m.desktop.tasks, native);
    assert.deepEqual(m.desktop.calls, []);
  });

  for (const failure of ['native', 'registration-write', 'source-cleanup']) {
    test(`a Claude transfer survives ${failure} failure and can recover`, async (t) => {
      const m = setup(t);
      const original = await m.store.save({ ...base, id: 'recovery', harness: 'codex' });
      const target = path.join(m.root, 'mopilot', 'recovery', 'automation.toml');
      let restore: () => void;
      if (failure === 'native') {
        const mocked = t.mock.method(m.desktop, 'upsert', () => {
          throw new Error('native failed');
        });
        restore = () => mocked.mock.restore();
      } else if (failure === 'registration-write') {
        const rename = fs.renameSync;
        let writes = 0;
        const mocked = t.mock.method(fs, 'renameSync', (source: any, destination: any) => {
          if (destination === target && ++writes === 2) throw new Error('registration-write failed');
          return rename(source, destination);
        });
        restore = () => mocked.mock.restore();
      } else {
        const remove = fs.promises.rm;
        const source = path.join(m.root, 'codex', 'recovery');
        const mocked = t.mock.method(fs.promises, 'rm', async (folder: any, options: any) => {
          if (folder === source) throw new Error('source-cleanup failed');
          return remove(folder, options);
        });
        restore = () => mocked.mock.restore();
      }
      await assert.rejects(m.store.save({ ...original, harness: 'claude', prompt: 'New prompt' }), /failed/);
      restore();
      assert.equal(m.read('mopilot', 'recovery').prompt, 'New prompt');
      assert.equal(m.read('mopilot', 'recovery').status, 'PAUSED');
      assert.equal(m.read('mopilot', 'recovery').transfer_status, 'ACTIVE');
      if (failure === 'source-cleanup') assert.equal(m.read('codex', 'recovery').harness, 'codex');
      await m.store.sync();
      assert.equal(m.read('mopilot', 'recovery').status, 'ACTIVE');
      assert.equal(m.read('mopilot', 'recovery').transfer_from, undefined);
      assert.equal(m.read('mopilot', 'recovery').claude_desktop, DESKTOP.registered);
      assert.equal(m.desktop.tasks.find((a: any) => a.id === 'recovery').prompt, 'New prompt');
    });
  }

  test('failed migration destination write preserves the old task', async (t) => {
    const m = setup(t);
    await writeTask(path.join(m.root, 'codex'), { ...base, id: 'legacy', harness: 'acp:opencode' });
    const file = path.join(m.root, 'codex', 'legacy', 'automation.toml');
    const original = fs.readFileSync(file, 'utf8');
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('migration denied');
    });
    await assert.rejects(m.store.migrate(), /migration denied/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  test('failed Claude edit leaves both saved and native prompts unchanged', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'edit', harness: 'claude', prompt: 'Original' });
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('edit denied');
    });
    await assert.rejects(m.store.save({ ...original, prompt: 'Changed' }), /edit denied/);
    assert.equal(m.read('mopilot', 'edit').prompt, 'Original');
    assert.equal(m.desktop.tasks.find((a: any) => a.id === 'edit').prompt, 'Original');
  });

  for (const to of ['codex', 'acp:opencode']) {
    test(`Claude → ${to} waits for native retirement before activating the destination`, async (t) => {
      const m = setup(t);
      const original = await m.store.save({ ...base, id: 'retire', harness: 'claude' });
      const mocked = t.mock.method(m.desktop, 'remove', () => {
        throw new Error('native retirement failed');
      });
      await assert.rejects(m.store.save({ ...original, harness: to }), /native retirement failed/);
      mocked.mock.restore();
      const home = to === 'codex' ? 'codex' : 'mopilot';
      assert.equal(m.read(home, 'retire').status, 'PAUSED');
      assert.equal((await m.store.get('retire')).status, 'ACTIVE');
      assert.equal(m.desktop.tasks.find((a: any) => a.id === 'retire').status, 'ACTIVE');
      await m.store.sync();
      assert.equal(m.read(home, 'retire').status, 'ACTIVE');
      assert.equal(m.read(home, 'retire').transfer_from, undefined);
      assert.equal(m.desktop.tasks.length, 0);
    });
  }

  test('a harness transfer waits while Desktop is open and resumes when it closes', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'wait', harness: 'claude' });
    m.desktop.open = true;
    const waiting = await m.store.save({ ...original, harness: 'acp:opencode' });
    assert.equal(waiting.status, 'ACTIVE');
    assert.equal(waiting.transfer_status, 'ACTIVE');
    await m.store.sync();
    assert.equal(m.read('mopilot', 'wait').status, 'PAUSED');
    assert.equal(m.desktop.tasks.length, 1);
    m.desktop.open = false;
    await m.store.sync();
    assert.equal(m.read('mopilot', 'wait').status, 'ACTIVE');
    assert.equal(m.desktop.tasks.length, 0);
  });

  test('a pending Claude edit retains native arbitration against its old Desktop copy', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'arbitrate', harness: 'claude' });
    m.desktop.open = true;
    const current = await m.store.save({ ...original, prompt: 'New prompt' });
    assert.equal(current.prompt, 'New prompt');
    assert.equal(current.claude_desktop, DESKTOP.pending);
    assert.equal(current.native_app, 'claude-desktop');
    assert.equal(m.desktop.tasks.find((a: any) => a.id === 'arbitrate').prompt, 'p');
  });

  test('edits cannot activate a transfer while Desktop retirement is pending', async (t) => {
    const m = setup(t);
    const original = await m.store.save({ ...base, id: 'edit-wait', harness: 'claude' });
    m.desktop.open = true;
    const waiting = await m.store.save({ ...original, harness: 'acp:opencode' });
    const edited = await m.store.save({ ...waiting, status: 'ACTIVE', prompt: 'Edited while waiting' });
    assert.equal(edited.status, 'ACTIVE');
    assert.equal(edited.transfer_status, 'ACTIVE');
    m.desktop.open = false;
    await m.store.sync();
    assert.equal(m.read('mopilot', 'edit-wait').status, 'ACTIVE');
    assert.equal(m.read('mopilot', 'edit-wait').prompt, 'Edited while waiting');
  });
}
