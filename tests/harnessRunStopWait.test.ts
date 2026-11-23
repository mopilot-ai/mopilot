// Main's Stop response and shutdown drain retain package ownership until actual completion so follow-up methods cannot join a retiring run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick } from './support/async-scenarios.ts';
const { register, runsFor } = createRequire(import.meta.url)('../electron/app/ipc/harnessRuns.cjs');
const { HarnessRuns } = createRequire(import.meta.url)('../electron/harness/harnessRuns.cjs');
function fixture() {
  const handlers = new Map<string, Function>();
  const terminals: any[] = [];
  const refresh = deferred<void>();
  let kills = 0;
  const ipc = { handle: (name: string, fn: Function) => handlers.set(name, fn), on() {} };
  const app = {};
  const runs = register(
    ipc,
    { app, live: { acpAdmission: { refresh: () => refresh.promise } }, server: {}, shellEnv: { childEnv: () => ({}) }, broadcastAll() {} },
    {
      pty: {
        spawn: (_id: string, _o: any, handlers: any) => terminals.push(handlers),
        kill: () => {
          kills++;
        },
      },
      registerUpdates() {},
    },
  );
  const spec = { kind: 'acp:kimi', purpose: 'install', via: 'npm', command: 'first', argv: ['first'] };
  return { runs, spec, handlers, terminals, refresh, ipc, app, kills: () => kills };
}

test('the real IPC Stop response waits before another installation method starts', async (t) => {
  const f = fixture();
  assert.equal(runsFor(f.ipc), f.runs);
  assert.equal(runsFor(f.app), f.runs, 'quit and IPC use the same run manager');
  const run = f.runs.launch(f.spec).run;
  let followed = false;
  const stop = Promise.resolve(f.handlers.get('harnessRuns:stop')!({}, run.id));
  const next = stop.then(() => {
    followed = true;
    return f.runs.launch({ ...f.spec, command: 'second', argv: ['second'] });
  });
  t.after(async () => {
    f.terminals[0].onExit({ exitCode: 0 });
    f.refresh.resolve();
    await next;
  });
  await tick();
  assert.equal(followed, false, 'awaiting Stop must not rejoin the old run');
  assert.equal(f.kills(), 1);
  assert.equal(f.runs.list()[0].state, 'running');
  f.terminals[0].onExit({ exitCode: 0 });
  await tick();
  assert.equal(followed, false, 'admission refresh also belongs to completion');
  f.refresh.resolve();
  const result = await next;
  assert.equal(result.joined, false);
  assert.notEqual(result.run.id, run.id);
  assert.equal(result.run.command, 'second');
});

test('shutdown awaits an admission check already started and ignores missing or checked runs', async () => {
  const f = fixture();
  const first = f.runs.launch(f.spec).run;
  assert.equal(await f.runs.stopAndWait('missing'), false);
  f.terminals[0].onExit({ exitCode: 0 });
  const drain = f.runs.close();
  let done = false;
  drain.then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  assert.equal(f.kills(), 0, 'the process already retired');
  f.refresh.resolve();
  await drain;
  assert.equal(await f.runs.stopAndWait(first.id), false);
});

test('a failed stop unregisters only its waiter and a repeated shutdown can retry the same owner', async () => {
  const f = fixture();
  f.refresh.resolve();
  const run = f.runs.launch(f.spec).run;
  let attempts = 0;
  f.runs.o.pty.kill = () => {
    if (++attempts === 1) throw new Error('stop unavailable');
  };
  const initialListeners = f.runs.ended.size;
  await assert.rejects(f.runs.close(), /stop unavailable/);
  assert.equal(f.runs.ended.size, initialListeners);
  const retry = f.runs.close();
  f.terminals[0].onExit({ exitCode: 1 });
  await retry;
  assert.equal(attempts, 2);
  assert.equal(f.runs.attach(run.id).run.stopped, true);
  assert.equal(f.runs.ended.size, initialListeners);
});

test('shutdown drains every harness without starting new checks or app servers after retirement', async () => {
  const terminals = new Map<string, any>();
  const quiet: any[] = [];
  const checked: string[] = [];
  const killed: string[] = [];
  const runs = new HarnessRuns({
    home: () => '/tmp',
    broadcast() {},
    afterExit: async (kind: string) => {
      checked.push(kind);
    },
    pty: { spawn: (id: string, _opts: any, events: any) => terminals.set(id, events), kill: (id: string) => killed.push(id) },
    spawnQuiet: (_argv: string[], _opts: any, events: any) => {
      quiet.push(events);
      return { kill: () => killed.push('quiet') };
    },
  });
  const launch = (kind: string, quiet = false) =>
    runs.launch({ kind, purpose: 'update', via: 'native', command: 'update', argv: ['update'], quiet }).run;
  const codex = launch('codex');
  const claude = launch('claude');
  const acp = launch('acp:kimi', true);
  let ended = false;
  const drain = runs.close().then(() => {
    ended = true;
  });
  assert.equal(runs.close(), runs.draining, 'repeated quits share the same drain');
  assert.match(runs.launch({ kind: 'new', via: 'npm', argv: ['new'] }).message, /closing/);
  assert.deepEqual(
    killed.sort(),
    [codex.id, claude.id, 'quiet', codex.id, claude.id, 'quiet'].sort(),
    'a repeated shutdown re-requests cleanup; adapters coalesce pending work',
  );
  quiet[0].onExit({ exitCode: 0 });
  terminals.get(codex.id).onExit({ exitCode: 0 });
  await tick();
  assert.equal(ended, false);
  terminals.get(claude.id).onExit({ exitCode: 0 });
  await drain;
  assert.deepEqual(checked, [], 'shutdown cannot start an admission probe or restart the Codex server');
  assert.ok(runs.list().every((run: any) => run.state === 'exited' && run.checked && run.stopped));
  assert.equal(runs.list().find((run: any) => run.id === acp.id).code, null);
});
