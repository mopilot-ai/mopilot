// storage automation store cases using shared sandbox and Desktop fixtures.
import {
  test,
  assert,
  fs,
  path,
  tornWrites,
  require,
  AutomationStore,
  readFolder,
  writeTask,
  runsIn,
  uniqueId,
  fakeDesktop,
  setup,
  base,
} from './fixture.ts';

export function registerStorage() {
  test('a task file cannot redirect save or deletion to a different folder id', async (t) => {
    for (const harness of ['codex', 'claude', 'acp:x'])
      await t.test(harness, async (s) => {
        const m = setup(s);
        const home = harness === 'codex' ? 'codex' : 'mopilot';
        await m.store.save({ ...base, id: 'actual', harness, name: 'Actual' });
        await m.store.save({ ...base, id: 'other', harness, name: 'Other' });
        const file = path.join(m.root, home, 'actual', 'automation.toml');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('id = "actual"', 'id = "other"'));
        const loaded = (await m.store.list()).tasks.find((a: any) => a.name === 'Actual');
        assert.equal(loaded.id, 'actual');
        await m.store.save({ ...loaded, name: 'Edited' });
        assert.equal(m.read(home, 'actual').name, 'Edited');
        assert.equal(m.read(home, 'other').name, 'Other');
        await m.store.remove('actual');
        assert.equal(m.has(home, 'actual'), false);
        assert.equal(m.has(home, 'other'), true);
      });
  });

  test('task migration uses the loaded folder owner even when its stored id names a parent', async (t) => {
    const s = setup(t);
    const folder = path.join(s.root, 'codex', 'actual');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'automation.toml'), 'id = ".."\nname = "Actual"\nharness = "acp:x"\n');
    const marker = path.join(s.root, 'outside.txt');
    fs.writeFileSync(marker, 'keep');
    assert.deepEqual(await s.store.migrate(), ['actual']);
    assert.equal(s.has('codex', 'actual'), false);
    assert.equal(s.read('mopilot', 'actual').id, 'actual');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  });

  test('deleting a Desktop-only task never removes a MoPilot task folder', async (t) => {
    const s = setup(t, fakeDesktop({ tasks: [{ ...base, id: 'native-only', harness: 'claude' }] }));
    const marker = path.join(s.root, 'mopilot', 'native-only', 'keep.txt');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'keep');
    await s.store.remove('native-only');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  });

  test('a Codex task goes to the Codex folder, a basic one to MoPilot’s; both list with where they run', async (t) => {
    const s = setup(t);
    const codex = await s.store.save({ ...base, name: 'Daily review' });
    assert.match(codex.id, /^daily-review-[a-f0-9-]{36}$/);
    assert.equal(codex.home, 'codex');
    assert.deepEqual(codex.runs_in, { apps: ['mopilot', 'codex-app'] });
    const saved = s.read('codex', codex.id);
    assert.equal(saved.created_at, 1000);
    assert.equal(saved.schedule_from, 1000);
    assert.equal(saved.home, undefined, 'listing keys never reach the file');
    const acp = await s.store.save({ ...base, name: 'Daily review', harness: 'acp:opencode' });
    assert.match(acp.id, /^daily-review-[a-f0-9-]{36}$/);
    assert.notEqual(acp.id, codex.id);
    assert.equal(acp.home, 'mopilot');
    assert.equal(acp.native_app, null);
    assert.deepEqual(acp.runs_in, { apps: ['mopilot'] });
    assert.equal(s.read('mopilot', acp.id).claude_desktop, undefined);
    assert.match((await s.store.save({ ...base, name: '!!!', harness: 'acp:opencode' })).id, /^task-[a-f0-9-]{36}$/);
    assert.equal(await s.store.get('nope'), null);
  });

  test('saving keeps when it was made; a new rule or a resume counts from now, an edit does not', async (t) => {
    const s = setup(t);
    await s.store.save({ ...base, id: 'x', name: 'X' });
    s.tick();
    await s.store.save({ ...(await s.store.get('x')), prompt: 'edited' });
    assert.equal(s.read('codex', 'x').schedule_from, 1000);
    assert.equal(s.read('codex', 'x').created_at, 1000);
    assert.equal(s.read('codex', 'x').updated_at, 1001);
    s.tick();
    await s.store.save({ ...(await s.store.get('x')), status: 'PAUSED' });
    assert.equal(s.read('codex', 'x').schedule_from, 1000);
    s.tick();
    await s.store.save({ ...(await s.store.get('x')), status: 'ACTIVE' });
    assert.equal(s.read('codex', 'x').schedule_from, 1003);
    s.tick();
    await s.store.save({ ...(await s.store.get('x')), rrule: 'FREQ=HOURLY' });
    assert.equal(s.read('codex', 'x').schedule_from, 1004);
    // a task that names when it was made keeps that
    await s.store.save({ ...base, id: 'old', name: 'Old', created_at: 5 });
    assert.equal(s.read('codex', 'old').created_at, 5);
    // a save that leaves it out keeps the saved one
    s.tick();
    await s.store.save({ ...base, id: 'old', name: 'Old again' });
    assert.equal(s.read('codex', 'old').created_at, 5);
  });

  test('ids that would leave the folder are refused; a task is needed', async (t) => {
    const s = setup(t);
    for (const id of ['a/b', 'a\\b', '.', '..']) await assert.rejects(s.store.save({ ...base, id }), /isn't a task id/);
    await assert.rejects(s.store.save(null), /is needed/);
    await assert.rejects(s.store.save('x'), /is needed/);
  });
}

export function registerStorageListings() {
  test('the list is newest first and reports files that did not load', async (t) => {
    const s = setup(t);
    await s.store.save({ ...base, id: 'a' });
    s.tick();
    await s.store.save({ ...base, id: 'b', harness: 'acp:x' });
    fs.mkdirSync(path.join(s.root, 'codex', 'broken'));
    fs.writeFileSync(path.join(s.root, 'codex', 'broken', 'automation.toml'), 'x = [');
    fs.writeFileSync(path.join(s.root, 'codex', 'loose.txt'), '');
    fs.mkdirSync(path.join(s.root, 'mopilot', '.hidden'));
    fs.mkdirSync(path.join(s.root, 'codex', 'noid'));
    fs.writeFileSync(path.join(s.root, 'codex', 'noid', 'automation.toml'), 'name = "n"');
    const { tasks, errors } = await s.store.list();
    assert.deepEqual(
      tasks.map((x: any) => x.id),
      ['b', 'a', 'noid'],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"broken"/);
    const e: string[] = [];
    fs.mkdirSync(path.join(s.root, 'codex', 'dir'));
    fs.mkdirSync(path.join(s.root, 'codex', 'dir', 'automation.toml'));
    await readFolder(path.join(s.root, 'codex'), (m: string) => e.push(m));
    assert.equal(e.length, 2);
    // a thrown non-Error is reported as text
    const fakeFs = require('node:fs');
    const orig = fakeFs.promises.readFile;
    fakeFs.promises.readFile = async () => {
      throw 'raw';
    };
    t.after(() => (fakeFs.promises.readFile = orig));
    const raw: string[] = [];
    await readFolder(path.join(s.root, 'codex'), (m: string) => raw.push(m));
    assert.ok(raw.every((m) => m.endsWith(': raw')));
  });

  test('a pending-removals file that is unreadable or malformed reads as none', async (t) => {
    const s = setup(t);
    assert.deepEqual(s.store.readPending(), []);
    fs.mkdirSync(path.join(s.root, 'mopilot'), { recursive: true });
    fs.writeFileSync(s.store.pendingFile(), '{"remove": "x"}');
    assert.deepEqual(s.store.readPending(), []);
    fs.writeFileSync(s.store.pendingFile(), '{"remove": ["x", 2]}');
    assert.deepEqual(s.store.readPending(), ['x', '2']);
  });

  test('tasks an older MoPilot put in the Codex folder for another harness move to MoPilot’s', async (t) => {
    const s = setup(t);
    await writeTask(path.join(s.root, 'codex'), { ...base, id: 'claude-one', harness: 'claude' });
    await writeTask(path.join(s.root, 'codex'), { ...base, id: 'codex-one', harness: 'codex' });
    await writeTask(path.join(s.root, 'codex'), { ...base, id: 'plain' });
    assert.deepEqual(await s.store.migrate(), ['claude-one']);
    assert.equal(s.has('codex', 'claude-one'), false);
    assert.equal(s.read('mopilot', 'claude-one').harness, 'claude');
    assert.equal(s.has('codex', 'codex-one'), true);
    assert.match(s.logs[0], /claude-one \(claude\) moved/);
    assert.deepEqual(await s.store.migrate(), []);
    // a broken file is skipped by the move and by sync (the list reports it)
    fs.mkdirSync(path.join(s.root, 'codex', 'broken'));
    fs.writeFileSync(path.join(s.root, 'codex', 'broken', 'automation.toml'), 'x = [');
    fs.mkdirSync(path.join(s.root, 'mopilot', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'mopilot', 'broken', 'automation.toml'), 'x = [');
    assert.deepEqual(await s.store.migrate(), []);
    await s.store.sync();
    assert.equal(s.has('codex', 'broken'), true);
    // with no logger the move is quiet
    const q = new AutomationStore({
      codexDir: () => path.join(s.root, 'none'),
      mopilotDir: () => path.join(s.root, 'm2'),
      codexApp: {},
      desktop: fakeDesktop(),
    });
    assert.deepEqual(await q.migrate(), []);
    q.log('x');
    assert.ok(q.now() > 0);
  });

  test('a write cut off halfway leaves the last whole task (the scheduler and the Codex app read these files)', async (t) => {
    const s = setup(t);
    await s.store.save({ ...base, id: 'nightly', name: 'N' });
    const file = path.join(s.root, 'codex', 'nightly', 'automation.toml');
    const before = fs.readFileSync(file, 'utf8');
    const restore = tornWrites(s.root);
    try {
      await assert.rejects(s.store.save({ ...(await s.store.get('nightly')), name: 'N2' }), /ENOSPC/);
    } finally {
      restore();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['automation.toml']);
  });

  test('ids and run locations', () => {
    assert.match(uniqueId('Hello, World!', new Set()), /^hello-world-[a-f0-9-]{36}$/);
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const ids = [first, second];
    assert.equal(
      uniqueId(undefined, new Set([`task-${first}`]), () => ids.shift()),
      `task-${second}`,
    );
    assert.deepEqual(runsIn({ home: 'mopilot' }), { apps: ['mopilot'] });
  });
}
