// Keep queued automation refreshes linear in task count without reusing a stale discovery snapshot.
import { assert, base, fakeDesktop, fs, path, readFolder, setup, test, writeTask } from './support/automation-store/fixture.ts';

for (const operation of ['registration', 'transfer', 'migration']) {
  test(`${operation} refreshes only its own task after queue admission`, async (t) => {
    const m = setup(t, fakeDesktop());
    const count = 8;
    const home = operation === 'migration' ? 'codex' : 'mopilot';
    for (let i = 0; i < count; i++)
      await writeTask(path.join(m.root, home), {
        ...base,
        id: `task-${i}`,
        harness: operation === 'registration' ? 'claude' : 'acp:opencode',
        ...(operation === 'registration' ? { claude_desktop: 'pending' } : {}),
        ...(operation === 'transfer'
          ? {
              transfer_from: 'codex',
              transfer_status: 'ACTIVE',
              status: 'PAUSED',
            }
          : {}),
      });
    const read = fs.promises.readFile;
    let reads = 0;
    t.mock.method(fs.promises, 'readFile', async (file: any, options: any) => {
      if (String(file).endsWith('automation.toml')) reads++;
      return read(file, options);
    });
    const list = fs.promises.readdir;
    let lists = 0;
    t.mock.method(fs.promises, 'readdir', async (folder: any, options: any) => {
      lists++;
      return list(folder, options);
    });
    if (operation === 'migration') assert.equal((await m.store.migrate()).length, count);
    else await m.store.sync();
    assert.equal(reads, count * (operation === 'migration' ? 2 : 3), 'one exact-file refresh per queued task');
    assert.equal(lists, operation === 'migration' ? 1 : 3, 'only discovery enumerates the task folders');
    for (let i = 0; i < count; i++) {
      const task = m.read('mopilot', `task-${i}`);
      assert.equal(task.status, 'ACTIVE');
      assert.equal(task.transfer_from, undefined);
      if (operation === 'registration') assert.equal(task.claude_desktop, 'registered');
      if (operation === 'migration') assert.equal(m.has('codex', `task-${i}`), false);
    }
  });
}

for (const operation of ['registration', 'transfer', 'migration']) {
  for (const invalidation of ['delete', 'corrupt', 'file', 'symlink', 'cleared', ...(operation === 'transfer' ? [] : ['harness'])]) {
    test(`${operation} skips a task whose ${invalidation} invalidated discovery before queue admission`, async (t) => {
      const m = setup(t);
      const home = operation === 'migration' ? 'codex' : 'mopilot';
      const dir = path.join(m.root, home);
      const folder = path.join(dir, 'target');
      const file = path.join(folder, 'automation.toml');
      const original = {
        ...base,
        id: 'target',
        harness: operation === 'registration' ? 'claude' : 'acp:opencode',
        ...(operation === 'registration' ? { claude_desktop: 'pending' } : {}),
        ...(operation === 'transfer'
          ? {
              transfer_from: 'codex',
              transfer_status: 'ACTIVE',
              status: 'PAUSED',
            }
          : {}),
      };
      await writeTask(dir, original);
      const before = fs.readFileSync(file, 'utf8');
      const mutate = m.store.mutate.bind(m.store);
      let changed = false;
      t.mock.method(m.store, 'mutate', (id: string, action: () => Promise<any>) =>
        mutate(id, async () => {
          assert.equal(changed, false, 'the discovered task enters one mutation queue');
          changed = true;
          if (invalidation === 'delete') fs.rmSync(folder, { recursive: true });
          else if (invalidation === 'corrupt') fs.writeFileSync(file, 'prompt = [');
          else if (invalidation === 'file' || invalidation === 'symlink') {
            const outside = path.join(m.root, 'outside');
            fs.renameSync(folder, outside);
            if (invalidation === 'file') fs.writeFileSync(folder, 'keep');
            else fs.symlinkSync(outside, folder, 'dir');
          } else {
            const updated: any = { ...original, prompt: 'Latest edit' };
            if (operation === 'registration') {
              if (invalidation === 'cleared') updated.claude_desktop = 'registered';
              else updated.harness = 'acp:opencode';
            } else if (operation === 'transfer') delete updated.transfer_from;
            else if (invalidation === 'cleared') delete updated.harness;
            else updated.harness = 'codex';
            await writeTask(dir, updated);
          }
          return action();
        }),
      );
      if (operation === 'migration') assert.deepEqual(await m.store.migrate(), []);
      else await m.store.sync();
      assert.equal(changed, true);
      assert.deepEqual(m.desktop.calls, [], 'no stale native registration');
      if (operation === 'migration') assert.equal(m.has('mopilot', 'target'), false);
      if (invalidation === 'delete') assert.equal(fs.existsSync(folder), false);
      else if (invalidation === 'corrupt') {
        assert.equal(fs.readFileSync(file, 'utf8'), 'prompt = [');
        assert.equal(m.logs.length, 1, 'the failed current read is reported');
      } else if (invalidation === 'file') assert.equal(fs.readFileSync(folder, 'utf8'), 'keep');
      else if (invalidation === 'symlink') {
        assert.equal(fs.lstatSync(folder).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(path.join(m.root, 'outside', 'automation.toml'), 'utf8'), before);
      } else assert.equal(m.read(home, 'target').prompt, 'Latest edit');
    });
  }
}

for (const operation of ['registration', 'transfer', 'migration']) {
  test(`${operation} refresh uses the latest prompt and canonical folder id`, async (t) => {
    const m = setup(t);
    const home = operation === 'migration' ? 'codex' : 'mopilot';
    const dir = path.join(m.root, home);
    const task = {
      ...base,
      id: 'target',
      harness: operation === 'registration' ? 'claude' : 'acp:opencode',
      ...(operation === 'registration' ? { claude_desktop: 'pending' } : {}),
      ...(operation === 'transfer'
        ? {
            transfer_from: 'codex',
            transfer_status: 'ACTIVE',
            status: 'PAUSED',
          }
        : {}),
    };
    await writeTask(dir, task);
    const mutate = m.store.mutate.bind(m.store);
    t.mock.method(m.store, 'mutate', (id: string, action: () => Promise<any>) =>
      mutate(id, async () => {
        await writeTask(dir, {
          ...task,
          prompt: 'Latest prompt',
          extra: 'retained',
        });
        const file = path.join(dir, 'target', 'automation.toml');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('id = "target"', 'id = "other"'));
        return action();
      }),
    );
    if (operation === 'migration') assert.deepEqual(await m.store.migrate(), ['target']);
    else await m.store.sync();
    const saved = m.read('mopilot', 'target');
    assert.equal(saved.id, 'target');
    assert.equal(saved.prompt, 'Latest prompt');
    assert.equal(saved.extra, 'retained');
    assert.equal(m.has('mopilot', 'other'), false);
    if (operation === 'registration') assert.equal(m.desktop.tasks[0].prompt, 'Latest prompt');
  });
}

test('native refresh stays in its MoPilot folder when Codex owns the same local id', async (t) => {
  const m = setup(t);
  const codex = path.join(m.root, 'codex');
  await writeTask(codex, {
    ...base,
    id: 'shared',
    harness: 'codex',
    prompt: 'Codex prompt',
  });
  await writeTask(path.join(m.root, 'mopilot'), {
    ...base,
    id: 'shared',
    harness: 'claude',
    prompt: 'Claude prompt',
    claude_desktop: 'pending',
  });
  const original = fs.readFileSync(path.join(codex, 'shared', 'automation.toml'), 'utf8');
  await m.store.sync();
  assert.deepEqual(m.desktop.calls, [['upsert', 'shared']]);
  assert.equal(m.desktop.tasks[0].prompt, 'Claude prompt');
  assert.equal(fs.readFileSync(path.join(codex, 'shared', 'automation.toml'), 'utf8'), original);
});

test('strict task reads still reject malformed existing state and tolerate a vanished file', async (t) => {
  const m = setup(t);
  const dir = path.join(m.root, 'mopilot');
  const folder = path.join(dir, 'target');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'automation.toml');
  fs.writeFileSync(file, 'prompt = [');
  const errors: string[] = [];
  await assert.rejects(
    readFolder(dir, (message: string) => errors.push(message), 'target'),
    /TOML/,
  );
  assert.equal(errors.length, 0);
  fs.unlinkSync(file);
  assert.deepEqual(await readFolder(dir, (message: string) => errors.push(message), 'target'), []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /target.*ENOENT/);
});
