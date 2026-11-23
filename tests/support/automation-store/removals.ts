// removals automation store cases using shared sandbox and Desktop fixtures.
import { test, assert, fs, fakeDesktop, setup, base } from './fixture.ts';

export function registerRemovals() {
  test('failed Desktop removals retain durable intent until the native store accepts them', async (t) => {
    const desktop = fakeDesktop({ tasks: [{ ...base, id: 'd', harness: 'claude', home: 'claude-desktop' }] });
    const s = setup(t, desktop);
    const remove = desktop.remove;
    desktop.remove = () => false;
    await s.store.remove('d');
    assert.deepEqual(s.store.readPending(), ['d']);
    assert.deepEqual((await s.store.list()).tasks, [], 'a failed removal must not resurrect the deleted task');
    await s.store.sync();
    assert.deepEqual(s.store.readPending(), ['d'], 'a refused sync keeps the intent');
    desktop.remove = remove;
    await s.store.sync();
    assert.deepEqual(s.store.readPending(), []);
    assert.deepEqual(desktop.tasks, []);
  });

  test('a throwing Desktop removal keeps its durable retry intent', async (t) => {
    const desktop = fakeDesktop({ tasks: [{ ...base, id: 'd', harness: 'claude', home: 'claude-desktop' }] });
    const s = setup(t, desktop);
    desktop.remove = () => {
      throw new Error('native write failed');
    };
    await assert.rejects(s.store.remove('d'), /native write failed/);
    assert.deepEqual(s.store.readPending(), ['d']);
  });

  test('sync acknowledges successful Desktop removals and retains refused siblings', async (t) => {
    const desktop = fakeDesktop({
      tasks: [
        { ...base, id: 'a' },
        { ...base, id: 'b' },
      ],
    });
    const s = setup(t, desktop);
    await s.store.writePending(['a', 'b']);
    const remove = desktop.remove;
    desktop.remove = (id: string) => (id === 'a' ? remove(id) : false);
    await s.store.sync();
    assert.deepEqual(s.store.readPending(), ['b']);
    assert.deepEqual(
      desktop.tasks.map((task: any) => task.id),
      ['b'],
    );
    desktop.remove = remove;
    await s.store.sync();
    assert.deepEqual(s.store.readPending(), []);
  });

  test('a removal waiting for Desktop preserves other intents added while it waits', async (t) => {
    const desktop = fakeDesktop();
    const s = setup(t, desktop);
    let release!: (running: boolean) => void;
    let calls = 0;
    desktop.running = () =>
      ++calls === 1
        ? new Promise<boolean>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(true);
    const first = s.store.fromDesktop('a');
    await new Promise((resolve) => setImmediate(resolve));
    await s.store.fromDesktop('b');
    release(false);
    await first;
    assert.deepEqual(s.store.readPending(), ['b']);
  });

  test('new Desktop removal intents cannot overwrite an unreadable or malformed existing journal', async (t) => {
    const s = setup(t, fakeDesktop({ running: true }));
    await s.store.writePending(['earlier']);
    const file = s.store.pendingFile();
    const before = fs.readFileSync(file, 'utf8');
    fs.chmodSync(file, 0o200);
    try {
      await assert.rejects(s.store.fromDesktop('later'), /EACCES/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    for (const invalid of ['{ torn', 'null', '{"remove":"x"}']) {
      fs.writeFileSync(file, invalid);
      await assert.rejects(s.store.fromDesktop('later'));
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
    }
  });

  test('sync acknowledges an earlier successful removal even when a later native removal throws', async (t) => {
    const desktop = fakeDesktop();
    const s = setup(t, desktop);
    await s.store.writePending(['a', 'b']);
    const failure = new Error('native write failed');
    desktop.remove = (id: string) => {
      if (id === 'b') throw failure;
      return true;
    };
    await assert.rejects(s.store.sync(), (error: unknown) => error === failure);
    assert.deepEqual(s.store.readPending(), ['b']);
  });

  test('pending-intent mutations retain non-Error read failures while snapshots stay tolerant', async (t) => {
    const s = setup(t);
    const original = fs.readFileSync;
    const reader = t.mock.method(fs, 'readFileSync', (...args: any[]) => {
      if (args[0] === s.store.pendingFile()) throw undefined;
      return (original as any)(...args);
    });
    try {
      assert.throws(
        () => s.store.readPending(true),
        (error: unknown) => error === undefined,
      );
      assert.deepEqual(s.store.readPending(), []);
    } finally {
      reader.mock.restore();
    }
  });

  test('recreating a task acknowledges the old removal only after Desktop accepts the replacement', async (t) => {
    const desktop = fakeDesktop({ running: true, tasks: [{ ...base, id: 'd', harness: 'claude' }] });
    const s = setup(t, desktop);
    await s.store.remove('d');
    desktop.open = false;
    await s.store.save({ ...base, id: 'd', harness: 'claude', prompt: 'replacement' });
    assert.deepEqual(s.store.readPending(), []);
    await s.store.sync();
    assert.equal(desktop.tasks.find((task: any) => task.id === 'd')?.prompt, 'replacement');
  });

  test('a refused replacement cannot acknowledge the old Desktop removal', async (t) => {
    const s = setup(t, fakeDesktop({ upsert: () => ({ ok: false, reason: 'store' }) }));
    await s.store.writePending(['d']);
    await s.store.save({ ...base, id: 'd', harness: 'claude' });
    assert.deepEqual(s.store.readPending(), ['d']);
  });

  test('a removal waiting for Desktop cannot delete a replacement that acknowledged its intent', async (t) => {
    const desktop = fakeDesktop();
    const s = setup(t, desktop);
    let release!: (running: boolean) => void;
    let checks = 0;
    desktop.running = () =>
      ++checks === 1
        ? new Promise<boolean>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(false);
    const removal = s.store.fromDesktop('d');
    await new Promise((resolve) => setImmediate(resolve));
    await s.store.save({ ...base, id: 'd', harness: 'claude', prompt: 'replacement' });
    release(false);
    await removal;
    assert.equal(desktop.tasks.find((task: any) => task.id === 'd')?.prompt, 'replacement');
  });

  test('sync skips intents superseded while acknowledging an earlier sibling and deduplicates legacy entries', async (t) => {
    const desktop = fakeDesktop();
    const s = setup(t, desktop);
    await s.store.writePending(['a', 'b']);
    fs.writeFileSync(s.store.pendingFile(), '{"remove":["a","a","b"]}');
    const finish = s.store.finishRemovals.bind(s.store);
    s.store.finishRemovals = async (ids: Set<string>) => {
      await finish(ids);
      if (ids.has('a')) await s.store.save({ ...base, id: 'b', harness: 'claude', prompt: 'replacement' });
    };
    await s.store.sync();
    assert.equal(desktop.calls.filter((call: any[]) => call[0] === 'remove' && call[1] === 'a').length, 1);
    assert.equal(desktop.tasks.find((task: any) => task.id === 'b')?.prompt, 'replacement');
  });
}
