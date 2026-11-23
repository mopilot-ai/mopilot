// Scheduler identity admission precedes ledger claims and native marks, without blocking other due tasks.
import { test, assert, setup, base, writeTask, fakeDesktop, require } from './support/automation-store/fixture.ts';
const { Scheduler } = require('../../../electron/platform/scheduler.cjs');
const NOW = Date.UTC(2030, 0, 1, 9, 0, 30);

for (const harness of ['claude', 'acp:x']) {
  for (const newest of ['codex', 'mopilot']) {
    test(`scheduler leaves both ${harness}/Codex identities unclaimed with ${newest} newest`, async (t) => {
      const s = setup(t, fakeDesktop({ installed: false }));
      for (const home of ['codex', 'mopilot'])
        await writeTask(home === 'codex' ? s.store.o.codexDir() : s.store.o.mopilotDir(), {
          ...base,
          id: 'shared',
          harness: home === 'codex' ? 'codex' : harness,
          created_at: 1,
          rrule: 'FREQ=MINUTELY',
          updated_at: home === newest ? 20 : 10,
        });
      await writeTask(s.store.o.mopilotDir(), { ...base, id: 'healthy', harness: 'acp:x', created_at: 1, rrule: 'FREQ=MINUTELY' });
      const effects: any[] = [];
      const logs: string[] = [];
      const scheduler = new Scheduler({
        enabled: () => true,
        list: async () => (await s.store.list()).tasks,
        run: async (a: any) => {
          effects.push(['run', a.id]);
          return 'healthy-chat';
        },
        sessions: { all: () => [] },
        ledger: {
          baseline: async () => 1,
          latest: async (id: string) => {
            effects.push(['latest', id]);
            return 0;
          },
          lastRun: async () => null,
          claim: async (id: string) => {
            effects.push(['claim', id]);
            return true;
          },
          update: async (id: string) => {
            effects.push(['update', id]);
          },
        },
        natives: {
          'codex-app': {
            installed: () => true,
            running: async () => false,
            read: () => ({ ok: true, tasks: new Map([['shared', { through: 0 }]]) }),
            markHandled: (id: string) => {
              effects.push(['markHandled', id]);
              return true;
            },
          },
        },
        now: () => NOW,
        tickMs: 0,
        log: (m: string) => logs.push(m),
      });
      await scheduler.tick();
      assert.deepEqual(effects, [
        ['latest', 'healthy'],
        ['claim', 'healthy'],
        ['run', 'healthy'],
        ['update', 'healthy'],
      ]);
      assert.equal(logs.filter((line) => /shared.*ambiguous/.test(line)).length, 2);
    });
  }
}

test('scheduler rechecks authorization after validation and retries healthy work after disabled validation', async () => {
  let release!: () => void;
  let validation: Promise<void> | null = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enabled = true;
  const effects: string[] = [];
  const task = { ...base, id: 'task', created_at: 1, rrule: 'FREQ=MINUTELY' };
  const scheduler = new Scheduler({
    enabled: () => enabled,
    list: async () => [task],
    validate: async () => {
      await validation;
      return task;
    },
    run: async () => {
      effects.push('run');
      return 'chat';
    },
    sessions: { all: () => [] },
    ledger: {
      baseline: async () => 1,
      latest: async () => 0,
      lastRun: async () => null,
      claim: async () => {
        effects.push('claim');
        return true;
      },
      update: async () => {},
    },
    now: () => NOW,
    tickMs: 0,
  });
  const pending = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  enabled = false;
  release();
  await pending;
  assert.deepEqual(effects, []);
  enabled = true;
  scheduler.resumedAt = 0;
  validation = null;
  await scheduler.tick();
  assert.deepEqual(effects, ['claim', 'run']);
});

for (const phase of ['starting', 'missed', 'previous-running']) {
  test(`scheduler abandons changed task after awaited reads before a ${phase} claim`, async () => {
    const task = {
      ...base,
      id: 'changing',
      created_at: 1,
      rrule: phase === 'missed' ? 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1' : 'FREQ=MINUTELY',
    };
    const healthy = { ...base, id: 'healthy', created_at: 1, rrule: 'FREQ=MINUTELY' };
    let changed = false;
    const claims: any[] = [];
    const scheduler = new Scheduler({
      enabled: () => true,
      list: async () => [task, healthy],
      validate: async (a: any) => (a.id === 'changing' && changed ? { ...a, status: 'PAUSED' } : a),
      sessions: { all: () => [], has: () => true, get: () => ({ turn: 'running' }) },
      ledger: {
        baseline: async () => 1,
        latest: async (id: string) => {
          if (id === 'changing') changed = true;
          return 0;
        },
        lastRun: async (id: string) => (id === 'changing' && phase === 'previous-running' ? { status: 'started', chatId: 'busy' } : null),
        claim: async (id: string) => {
          claims.push(id);
          return true;
        },
        update: async () => {},
      },
      run: async () => 'chat',
      now: () => (phase === 'missed' ? Date.UTC(2030, 0, 20, 9, 0, 30) : NOW),
      tickMs: 0,
    });
    await scheduler.tick();
    assert.deepEqual(claims, ['healthy']);
  });
}

test('scheduler rechecks authorization after final identity validation', async () => {
  let enabled = true;
  let reads = 0;
  const effects: string[] = [];
  const task = { ...base, id: 'task', created_at: 1, rrule: 'FREQ=MINUTELY' };
  const scheduler = new Scheduler({
    enabled: () => enabled,
    list: async () => [task],
    validate: async () => {
      if (++reads === 2) enabled = false;
      return task;
    },
    sessions: { all: () => [] },
    ledger: {
      baseline: async () => 1,
      latest: async () => 0,
      lastRun: async () => null,
      claim: async () => {
        effects.push('claim');
        return true;
      },
    },
    run: async () => {
      effects.push('run');
      return 'chat';
    },
    now: () => NOW,
    tickMs: 0,
  });
  await scheduler.tick();
  assert.deepEqual(effects, []);
});
