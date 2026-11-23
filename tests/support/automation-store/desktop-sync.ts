// desktop sync automation store cases using shared sandbox and Desktop fixtures.
import { test, assert, DESKTOP, fakeDesktop, setup, base } from './fixture.ts';

export function registerDesktopSync() {
  test('a Claude Code task is registered in Claude Desktop, and lists as running in either', async (t) => {
    const s = setup(t);
    const a = await s.store.save({ ...base, name: 'Claude daily', harness: 'claude', model: 'opus' });
    assert.deepEqual(s.desktop.calls, [['upsert', a.id]]);
    assert.equal(s.read('mopilot', a.id).claude_desktop, 'registered');
    assert.equal(a.native_app, 'claude-desktop');
    assert.deepEqual(a.runs_in, { apps: ['mopilot', 'claude-desktop'] });
    assert.equal(a.model, 'opus', 'MoPilot keeps the fields Desktop has no place for');
    // edited in Claude Desktop: its schedule and prompt win
    s.desktop.tasks = s.desktop.tasks.map((x: any) => ({ ...x, prompt: 'from desktop', rrule: 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=0' }));
    const b = await s.store.get(a.id);
    assert.equal(b.prompt, 'from desktop');
    assert.equal(b.rrule, 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=0');
    assert.equal(b.created_at, 1000, 'MoPilot keeps when it was made');
    // a schedule Desktop has and MoPilot can't read runs in Desktop only
    s.desktop.tasks = s.desktop.tasks.map((x: any) => ({ ...x, rrule: '' }));
    assert.deepEqual((await s.store.get(a.id)).runs_in, { apps: ['claude-desktop'] });
    // removed from Desktop: MoPilot keeps running it, and says so
    s.desktop.tasks = [];
    const c = await s.store.get(a.id);
    assert.equal(c.claude_desktop, 'missing');
    assert.equal(c.native_app, null);
    assert.deepEqual(c.runs_in, { apps: ['mopilot'], desktop: 'missing' });
  });

  test('with Claude Desktop open, registering and removing wait until it closes (sync)', async (t) => {
    const s = setup(t, fakeDesktop({ running: true }));
    const a = await s.store.save({ ...base, id: 'c', name: 'C', harness: 'claude' });
    assert.equal(a.claude_desktop, 'pending');
    assert.deepEqual(a.runs_in, { apps: ['mopilot'], desktop: 'pending' });
    assert.deepEqual(s.desktop.calls, []);
    await s.store.sync();
    assert.deepEqual(s.desktop.calls, [], 'still open: nothing yet');
    // tasks sync leaves alone: a basic one, and a Claude one already registered
    await s.store.save({ ...base, id: 'b', harness: 'acp:kimi' });
    s.desktop.open = false;
    await s.store.save({ ...base, id: 'r', harness: 'claude' });
    s.desktop.calls.length = 0;
    await s.store.sync();
    assert.deepEqual(s.desktop.calls, [['upsert', 'c']]);
    await s.store.remove('b');
    await s.store.remove('r');
    s.desktop.calls.length = 0;
    s.desktop.calls.push(['upsert', 'c']);
    assert.equal(s.read('mopilot', 'c').claude_desktop, 'registered');
    // a pending copy wins over Desktop's stale one until it is written
    s.desktop.open = true;
    await s.store.save({ ...(await s.store.get('c')), prompt: 'new' });
    assert.equal((await s.store.get('c')).prompt, 'new');
    assert.equal((await s.store.get('c')).claude_desktop, 'pending');
    await s.store.remove('c');
    assert.equal(s.has('mopilot', 'c'), false);
    assert.deepEqual(s.store.readPending(), ['c']);
    // the Desktop copy is not listed while its removal waits
    assert.deepEqual((await s.store.list()).tasks, []);
    s.desktop.open = false;
    await s.store.sync();
    assert.deepEqual(s.desktop.calls.at(-1), ['remove', 'c']);
    assert.deepEqual(s.store.readPending(), []);
    await s.store.sync();
    assert.equal(s.desktop.calls.length, 2, 'nothing left to do');
  });

  test('Claude Desktop that says no, or isn’t installed: the task runs from MoPilot, and why is kept', async (t) => {
    const s = setup(
      t,
      fakeDesktop({ upsert: (a: any) => (a.id === 'odd' ? { ok: false, reason: 'schedule' } : { ok: false, reason: 'store' }) }),
    );
    assert.equal(
      (await s.store.save({ ...base, id: 'odd', harness: 'claude', rrule: 'FREQ=MINUTELY;INTERVAL=7' })).claude_desktop,
      DESKTOP.schedule,
    );
    assert.deepEqual((await s.store.save({ ...base, id: 'other', harness: 'claude' })).runs_in, {
      apps: ['mopilot'],
      desktop: 'unavailable',
    });
    // pending ones that Desktop refuses on sync keep the reason
    const p = setup(t, fakeDesktop({ running: true, upsert: () => ({ ok: false, reason: 'store' }) }));
    await p.store.save({ ...base, id: 'later', harness: 'claude' });
    p.desktop.open = false;
    await p.store.sync();
    assert.equal(p.read('mopilot', 'later').claude_desktop, 'unavailable');
    const n = setup(t, fakeDesktop({ installed: false }));
    const a = await n.store.save({ ...base, id: 'x', harness: 'claude' });
    assert.equal(a.claude_desktop, undefined);
    assert.equal(n.read('mopilot', 'x').claude_desktop, undefined);
    await n.store.sync();
    // a Claude task that becomes a basic one has no Desktop copy to take out
    await n.store.save({ ...(await n.store.get('x')), harness: 'acp:kimi' });
    await n.store.remove('x');
    assert.deepEqual(n.desktop.calls, []);
  });

  test('changing harness moves the task: Codex ↔ MoPilot’s folder, and in and out of Claude Desktop', async (t) => {
    const s = setup(t);
    await s.store.save({ ...base, id: 'm', name: 'M' });
    assert.equal(s.has('codex', 'm'), true);
    await s.store.save({ ...(await s.store.get('m')), harness: 'claude' });
    assert.equal(s.has('codex', 'm'), false);
    assert.equal(s.has('mopilot', 'm'), true);
    assert.deepEqual(s.desktop.calls, [['upsert', 'm']]);
    await s.store.save({ ...(await s.store.get('m')), harness: 'acp:kimi' });
    assert.deepEqual(s.desktop.calls.at(-1), ['remove', 'm']);
    assert.equal(s.read('mopilot', 'm').claude_desktop, undefined);
    await s.store.save({ ...(await s.store.get('m')), harness: 'claude' });
    await s.store.save({ ...(await s.store.get('m')), harness: 'codex' });
    assert.equal(s.has('mopilot', 'm'), false);
    assert.equal(s.has('codex', 'm'), true);
    assert.equal(s.read('codex', 'm').claude_desktop, undefined);
    assert.deepEqual(s.desktop.calls.at(-1), ['remove', 'm']);
    // a basic task that becomes a Codex one leaves no Desktop call
    await s.store.save({ ...base, id: 'k', harness: 'acp:kimi' });
    const before = s.desktop.calls.length;
    await s.store.save({ ...(await s.store.get('k')), harness: undefined });
    assert.equal(s.desktop.calls.length, before);
    assert.equal(s.has('mopilot', 'k'), false);
  });

  test('Claude Desktop’s own tasks list as its; saving one makes it MoPilot’s too; deleting reaches Desktop', async (t) => {
    const s = setup(
      t,
      fakeDesktop({
        tasks: [
          {
            id: 'mine',
            name: 'Mine',
            prompt: 'x',
            rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
            status: 'ACTIVE',
            harness: 'claude',
            created_at: 3,
          },
        ],
      }),
    );
    const [a] = (await s.store.list()).tasks;
    assert.equal(a.home, 'claude-desktop');
    assert.equal(a.native_app, 'claude-desktop');
    assert.deepEqual(a.runs_in, { apps: ['mopilot', 'claude-desktop'] });
    await s.store.save({ ...a, model: 'opus' });
    const b = await s.store.get('mine');
    assert.equal(b.home, 'mopilot');
    assert.equal(b.model, 'opus');
    assert.equal(b.created_at, 3);
    await s.store.remove('mine');
    assert.deepEqual(s.desktop.calls.at(-1), ['remove', 'mine']);
    await s.store.remove('mine');
    assert.equal(s.desktop.calls.filter((c: any) => c[0] === 'remove').length, 1, 'gone already: nothing to do');
    // Desktop-only removal
    s.desktop.tasks = [{ id: 'only', name: 'O', prompt: '', rrule: '', status: 'ACTIVE', harness: 'claude' }];
    await s.store.remove('only');
    assert.deepEqual(s.desktop.calls.at(-1), ['remove', 'only']);
    // a Codex task's removal leaves Desktop alone
    await s.store.save({ ...base, id: 'cx' });
    const n = s.desktop.calls.length;
    await s.store.remove('cx');
    assert.equal(s.has('codex', 'cx'), false);
    assert.equal(s.desktop.calls.length, n);
  });
}
