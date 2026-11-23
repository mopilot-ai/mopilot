// ID-only automation reads and edits reject unrelated canonical tasks while preserving native mirrors and transfers.
import { test, assert, fs, path, writeTask, setup, base, fakeDesktop, require } from './support/automation-store/fixture.ts';

for (const harness of ['claude', 'acp:x']) {
  for (const newest of ['codex', 'mopilot']) {
    test(`ambiguous ${harness} and Codex IDs reject reads and edits with ${newest} newest`, async (t) => {
      const s = setup(t, fakeDesktop({ installed: false }));
      for (const home of ['codex', 'mopilot'])
        await writeTask(path.join(s.root, home), {
          ...base,
          id: 'shared',
          name: home,
          prompt: home,
          harness: home === 'codex' ? 'codex' : harness,
          updated_at: home === newest ? 20 : 10,
        });
      const files = ['codex', 'mopilot'].map((home) => path.join(s.root, home, 'shared', 'automation.toml'));
      const before = files.map((file) => fs.readFileSync(file, 'utf8'));
      assert.equal((await s.store.list()).tasks.length, 2);
      for (const strict of [false, true]) await assert.rejects(s.store.get('shared', strict), /ambiguous/i);
      await assert.rejects(s.store.update('shared', { prompt: 'edited' }), /ambiguous/i);
      await assert.rejects(s.store.save({ ...base, id: 'shared', harness, prompt: 'edited' }), /ambiguous/i);
      assert.deepEqual(
        files.map((file) => fs.readFileSync(file, 'utf8')),
        before,
      );
      assert.deepEqual(s.desktop.calls, []);
    });
  }
}

test('real Desktop and Codex tasks with the same native ID reject an edit of the Desktop row', async (t) => {
  const s = setup(t);
  const appData = path.join(s.root, 'desktop');
  fs.mkdirSync(path.join(appData, 'claude-code-sessions', 'account', 'org'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'account' }));
  const { claudeDesktop } = require('../../../electron/platform/nativeSchedulers.cjs');
  const desktop = claudeDesktop({ appData: () => appData, tasksDir: () => path.join(s.root, 'skills'), processes: async () => '' });
  s.store.o.desktop = desktop;
  assert.equal(desktop.upsert({ ...base, id: 'daily-review', name: 'Desktop', prompt: 'native', harness: 'claude' }).ok, true);
  await writeTask(path.join(s.root, 'codex'), { ...base, id: 'daily-review', name: 'Codex', prompt: 'codex', updated_at: 10 });
  const selected = (await s.store.list()).tasks.find((a: any) => a.home === 'claude-desktop');
  await assert.rejects(s.store.update(selected.id, { prompt: 'edited native' }), /ambiguous/i);
  assert.equal(s.read('codex', selected.id).prompt, 'codex');
  assert.equal(desktop.list(() => {}).find((a: any) => a.id === selected.id).prompt, 'native');
});

test('registered native mirror is one canonical task and remains editable', async (t) => {
  const s = setup(t);
  await s.store.save({ ...base, id: 'mirror', harness: 'claude', prompt: 'original' });
  assert.equal((await s.store.list()).tasks.length, 1);
  await s.store.update('mirror', { prompt: 'edited' });
  assert.equal(s.read('mopilot', 'mirror').prompt, 'edited');
  assert.equal(s.desktop.tasks[0].prompt, 'edited');
});

test('explicit transfer records resolve to the destination before editing', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  await writeTask(path.join(s.root, 'codex'), { ...base, id: 'moving', prompt: 'source' });
  await writeTask(path.join(s.root, 'mopilot'), {
    ...base,
    id: 'moving',
    harness: 'acp:x',
    prompt: 'destination',
    transfer_from: 'codex',
    transfer_status: 'ACTIVE',
  });
  assert.equal((await s.store.list()).tasks.length, 1);
  assert.equal((await s.store.get('moving')).prompt, 'destination');
  await s.store.update('moving', { prompt: 'edited' });
  assert.equal(s.read('mopilot', 'moving').prompt, 'edited');
  assert.equal(s.has('codex', 'moving'), false);
});

test('missing targets stay absent and corrupt matching files reject mutation without overwrite', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  assert.equal(await s.store.get('missing'), null);
  assert.equal(await s.store.update('missing', { prompt: 'edited' }), null);
  await writeTask(path.join(s.root, 'codex'), { ...base, id: 'bad' });
  const file = path.join(s.root, 'codex', 'bad', 'automation.toml');
  fs.writeFileSync(file, 'broken = [');
  await assert.rejects(s.store.update('bad', { prompt: 'edited' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken = [');
});

for (const harness of ['codex', 'claude', 'acp:x']) {
  test(`new ${harness} task creation tolerates an unrecognized installed Desktop store`, async (t) => {
    const s = setup(t);
    const appData = path.join(s.root, 'desktop');
    fs.mkdirSync(path.join(appData, 'claude-code-sessions'), { recursive: true });
    const { claudeDesktop } = require('../../../electron/platform/nativeSchedulers.cjs');
    s.store.o.desktop = claudeDesktop({
      appData: () => appData,
      tasksDir: () => path.join(s.root, 'skills'),
      processes: async () => '',
    });
    const created = await s.store.save({ ...base, harness, name: 'New task' });
    assert.equal(created.name, 'New task');
    assert.equal(s.read(harness === 'codex' ? 'codex' : 'mopilot', created.id).name, 'New task');
  });
}
