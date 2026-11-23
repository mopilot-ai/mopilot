// metadata automation store cases using shared sandbox and Desktop fixtures.
import { test, assert, fs, path, require, AutomationStore, writeTask, setup, base } from './fixture.ts';

export function registerMetadata() {
  for (const [first, second] of [
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['acp:opencode', 'acp:opencode'],
    ['codex', 'claude'],
    ['codex', 'acp:opencode'],
    ['claude', 'acp:opencode'],
  ]) {
    test(`concurrent ${first} and ${second} task creation preserves both same-name tasks`, async (t) => {
      const m = setup(t);
      const other = new AutomationStore(m.store.o);
      let reached = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      for (const store of [m.store, other]) {
        const list = store.list.bind(store);
        let firstRead = true;
        store.list = async () => {
          const rows = await list();
          if (firstRead) {
            firstRead = false;
            if (++reached === 2) release();
            await gate;
          }
          return rows;
        };
      }
      const [a, b] = await Promise.all([
        m.store.save({ ...base, name: 'Shared name', prompt: 'First prompt', harness: first }),
        other.save({ ...base, name: 'Shared name', prompt: 'Second prompt', harness: second }),
      ]);
      assert.notEqual(a.id, b.id);
      assert.equal((await m.store.get(a.id)).prompt, 'First prompt');
      assert.equal((await other.get(b.id)).prompt, 'Second prompt');
      assert.equal((await m.store.list()).tasks.length, 2);
    });
  }

  for (const harness of ['codex', 'claude', 'acp:opencode']) {
    test(`${harness} heartbeat remembering cannot overwrite an edit while persistence waits`, async (t) => {
      const m = setup(t);
      const a = await m.store.save({ ...base, id: 't', kind: 'heartbeat', harness });
      const { AutomationRunner } = require('../../../electron/platform/automationRun.cjs');
      const runner = new AutomationRunner({
        get: async () => a,
        save: (task: any) => m.store.save(task),
        remember: (task: any, id: string) => m.store.rememberChat(task, id),
      });
      const pending = runner.rememberChat(a, 'new-chat');
      // The old runner has finished its reread and entered save's asynchronous listing.
      await Promise.resolve();
      const home = harness === 'codex' ? 'codex' : 'mopilot';
      await writeTask(path.join(m.root, home), { ...a, kind: 'cron', prompt: 'Latest user edit' });
      await pending;
      const latest = m.read(home, a.id);
      assert.equal(latest.kind, 'cron');
      assert.equal(latest.prompt, 'Latest user edit');
      assert.equal(latest.target_thread_id, undefined);
    });
  }

  for (const harness of ['codex', 'claude', 'acp:opencode']) {
    test(`${harness} heartbeat metadata preserves current edits and native registrations`, async (t) => {
      const m = setup(t);
      const a = await m.store.save({ ...base, id: 't', kind: 'heartbeat', harness });
      const home = harness === 'codex' ? 'codex' : 'mopilot';
      await writeTask(path.join(m.root, home), { ...a, name: 'Latest name', prompt: 'Latest prompt', status: 'PAUSED', id: 't' });
      const registrations = m.desktop.calls.length;
      m.tick();
      assert.equal(await m.store.rememberChat(a, 'chat'), true);
      const current = m.read(home, 't');
      assert.deepEqual(
        [current.name, current.prompt, current.status, current.target_thread_id, current.updated_at],
        ['Latest name', 'Latest prompt', 'PAUSED', 'chat', 1001],
      );
      assert.equal(m.desktop.calls.length, registrations, 'local continuation metadata does not replace the native schedule');
      assert.equal(await m.store.rememberChat(a, 'other-chat'), false);
      assert.equal(m.read(home, 't').target_thread_id, 'chat');
      await m.store.remove('t');
      assert.equal(await m.store.rememberChat(a, 'late-chat'), false);
    });
  }

  test('heartbeat metadata rejects unsafe IDs and preserves unreadable task files', async (t) => {
    const m = setup(t);
    await assert.rejects(m.store.rememberChat({ id: '../outside' }, 'chat'), /isn't a task id/);
    await m.store.save({ ...base, id: 't', kind: 'heartbeat' });
    const file = path.join(m.root, 'codex', 't', 'automation.toml');
    fs.writeFileSync(file, '{ broken');
    await assert.rejects(m.store.rememberChat({ id: 't' }, 'chat'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  });
}
