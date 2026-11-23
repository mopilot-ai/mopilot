// Deletion owns one canonical task, fails closed on unreadable state, and retires only its runners.
import { test, assert, fs, path, fakeDesktop, setup, base, writeTask } from './support/automation-store/fixture.ts';
import { deferred } from './support/async-scenarios.ts';

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`deletion rejects corrupt ${harness} targets and preserves their bytes`, async (t) => {
    const s = setup(t);
    await s.store.save({ ...base, id: 'target', harness });
    const home = harness === 'codex' ? 'codex' : 'mopilot';
    const file = path.join(s.root, home, 'target', 'automation.toml');
    fs.writeFileSync(file, 'id = "unfinished');
    await assert.rejects(s.store.remove('target'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'id = "unfinished');
    assert.equal(
      s.desktop.calls.some((call: string[]) => call[0] === 'remove'),
      false,
    );
  });
  test(`deletion removes a healthy ${harness} target and tolerates missing targets and unrelated corruption`, async (t) => {
    const s = setup(t);
    await s.store.save({ ...base, id: 'target', harness });
    await writeTask(s.store.o.codexDir(), { ...base, id: 'unrelated' });
    fs.writeFileSync(path.join(s.root, 'codex', 'unrelated', 'automation.toml'), '[');
    await s.store.remove('target');
    await s.store.remove('missing');
    assert.equal(s.has(harness === 'codex' ? 'codex' : 'mopilot', 'target'), false);
    assert.equal(s.has('codex', 'unrelated'), true);
    assert.equal(s.desktop.tasks.length, 0);
  });
}

test('deletion rejects an unreadable target directory and can retry after recovery', async (t) => {
  const s = setup(t);
  await s.store.save({ ...base, id: 'target' });
  const read = fs.promises.readdir;
  const fault = t.mock.method(fs.promises, 'readdir', async (...args: any[]) => {
    if (args[0] === s.store.o.codexDir()) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return (read as any)(...args);
  });
  await assert.rejects(s.store.remove('target'), /denied/);
  assert.equal(s.has('codex', 'target'), true);
  fault.mock.restore();
  await s.store.remove('target');
  assert.equal(s.has('codex', 'target'), false);
});

test('deletion rejects native load failure before any local removal', async (t) => {
  const s = setup(t, fakeDesktop({ tasks: [{ ...base, id: 'native', harness: 'claude' }] }));
  s.desktop.list = (_onError: any, strictId: string) => {
    if (strictId === 'native') throw new Error('native unreadable');
    return [];
  };
  await assert.rejects(s.store.remove('native'), /native unreadable/);
  assert.deepEqual(s.desktop.calls, []);
});

test('deletion refuses unrelated canonical tasks sharing an id without deleting either', async (t) => {
  const s = setup(t, fakeDesktop({ tasks: [{ ...base, id: 'same', harness: 'claude' }] }));
  await writeTask(s.store.o.codexDir(), { ...base, id: 'same', harness: 'codex' });
  await assert.rejects(s.store.remove('same'), /ambiguous/i);
  assert.equal(s.has('codex', 'same'), true);
  assert.equal(s.desktop.tasks.length, 1);
  assert.deepEqual(s.desktop.calls, []);
});

test('deletion rejects ambiguous local homes too', async (t) => {
  const s = setup(t);
  await writeTask(s.store.o.codexDir(), { ...base, id: 'same', harness: 'codex' });
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'same', harness: 'acp:opencode' });
  await assert.rejects(s.store.remove('same'), /ambiguous/i);
  assert.equal(s.has('codex', 'same'), true);
  assert.equal(s.has('mopilot', 'same'), true);
});

test('deletion retires both copies of an explicitly linked pending transfer', async (t) => {
  const s = setup(t);
  await writeTask(s.store.o.codexDir(), { ...base, id: 'transfer', harness: 'codex' });
  await writeTask(s.store.o.mopilotDir(), {
    ...base,
    id: 'transfer',
    harness: 'acp:opencode',
    transfer_from: 'codex',
    transfer_status: 'ACTIVE',
  });
  await s.store.remove('transfer');
  assert.equal(s.has('codex', 'transfer'), false);
  assert.equal(s.has('mopilot', 'transfer'), false);
});

test('deletion rejects invalid folder identities', async (t) => {
  const s = setup(t);
  for (const id of ['', '..', 'a/b', 'a\\b']) await assert.rejects(s.store.remove(id), /isn't a task id/);
});

test('queued deletion sees the latest accepted edit, and a later update cannot resurrect it', async (t) => {
  const s = setup(t);
  await s.store.save({ ...base, id: 'target' });
  const gate = deferred<void>();
  const blocking = s.store.mutate('target', () => gate.promise);
  const edit = s.store.update('target', { prompt: 'new' });
  const deletion = s.store.remove('target');
  const late = s.store.update('target', { name: 'late' });
  gate.resolve();
  await blocking;
  assert.equal((await edit).prompt, 'new');
  await deletion;
  assert.equal(await late, null);
  assert.equal(s.has('codex', 'target'), false);
});

test('deletion preserves hidden unrelated Desktop tasks sharing an ACP task id', async (t) => {
  const s = setup(t, fakeDesktop({ tasks: [{ ...base, id: 'same', harness: 'claude' }] }));
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'same', harness: 'acp:opencode' });
  await s.store.remove('same');
  assert.equal(s.has('mopilot', 'same'), false);
  assert.equal(s.desktop.tasks.length, 1);
  assert.deepEqual(s.desktop.calls, []);
});

test('deletion rejects a corrupt source copy of a pending transfer before removing its destination', async (t) => {
  const s = setup(t);
  await writeTask(s.store.o.codexDir(), { ...base, id: 'transfer' });
  await writeTask(s.store.o.mopilotDir(), {
    ...base,
    id: 'transfer',
    harness: 'acp:opencode',
    transfer_from: 'codex',
    transfer_status: 'ACTIVE',
  });
  fs.writeFileSync(path.join(s.root, 'codex', 'transfer', 'automation.toml'), '[');
  await assert.rejects(s.store.remove('transfer'));
  assert.equal(s.has('codex', 'transfer'), true);
  assert.equal(s.has('mopilot', 'transfer'), true);
});

test('deletion reports filesystem removal failures and releases its queue for retry', async (t) => {
  const s = setup(t);
  await s.store.save({ ...base, id: 'target' });
  const rm = fs.promises.rm;
  const fault = t.mock.method(fs.promises, 'rm', async (...args: any[]) => {
    if (args[0] === path.join(s.root, 'codex', 'target')) throw new Error('remove failed');
    return (rm as any)(...args);
  });
  await assert.rejects(s.store.remove('target'), /remove failed/);
  assert.equal(s.has('codex', 'target'), true);
  fault.mock.restore();
  await s.store.remove('target');
  assert.equal(s.has('codex', 'target'), false);
});

test('an empty task folder is absence for strict updates and does not recreate a deleted task', async (t) => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.root, 'codex', 'gone'), { recursive: true });
  assert.equal(await s.store.update('gone', { prompt: 'late' }), null);
  assert.equal(fs.existsSync(path.join(s.root, 'codex', 'gone', 'automation.toml')), false);
});
