// electron/platform/winbin.cjs process groups (#1347): spawnGroup starts a harness process in a group of its own, killTree ends
// the whole group (the commands the harness ran, not only the harness), and endGroup ends what a harness that exited on
// its own left running. Real POSIX processes (node and sleep) show the outcome; stand-ins cover the edges.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { launchSpec, spawnGroup, killTree, endGroup, GROUP_GRACE_MS } = require('../electron/platform/winbin.cjs');

const posix = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits up to `ms` for `pid` to be gone. */
async function gone(pid: number, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (!alive(pid)) return true;
  return false;
}

/** Every process a test started, killed when it ends whatever happened. */
const started = new Set<number>();
afterEach(() => {
  for (const pid of started)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ended already
    }
  started.clear();
});

/**
 * A harness stand-in: node that starts `sleep 30` (its command) and prints the command's pid, then either stays
 * (`stay`) or exits at once, leaving the command behind. `ignoreTerm` makes the command ignore SIGTERM. `plain`
 * spawns it as MoPilot did before #1347: no group of its own. `ownGroup` runs the command in a process group of its
 * own, as Codex and Claude Code do; `hung` makes the harness ignore SIGTERM (a hang restart SIGKILLs it); `member`
 * has the harness start the command through a child of its own, which stays when the harness exits.
 */
async function harness(o: { stay: boolean; ignoreTerm?: boolean; plain?: boolean; ownGroup?: boolean; hung?: boolean; member?: boolean }) {
  const cmd = o.ignoreTerm ? `"trap '' TERM; sleep 30"` : '"exec sleep 30"';
  const start = `const c=require('child_process').spawn('sh',['-c',${cmd}],{stdio:'ignore',detached:${!!o.ownGroup}});console.log(c.pid);`;
  const body = o.member
    ? `const m=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`${start}setInterval(()=>{},1000)`)}],{stdio:['ignore','inherit','ignore']});`
    : start;
  const script = `${o.hung ? "process.on('SIGTERM',()=>{});" : ''}${body}${o.stay ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>process.exit(0),300)'}`;
  const args = ['-e', script];
  const options = { stdio: ['ignore', 'pipe', 'ignore'] };
  const proc: any = o.plain
    ? childProcess.spawn(process.execPath, args, options as any)
    : spawnGroup(childProcess.spawn, process.execPath, args, options);
  started.add(proc.pid);
  const exited = new Promise((r) => proc.once('exit', r));
  const command = await new Promise<number>((resolve) => proc.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
  started.add(command);
  return { proc, command, exited };
}

test('a group of its own on POSIX only: detached there, never on Windows (a console of its own)', () => {
  const io = { platform: 'darwin', env: {}, readFile: () => null, exists: () => false };
  assert.deepEqual(launchSpec('/b/codex', ['app-server'], { group: true, cwd: '/h' }, io).options, { cwd: '/h', detached: true });
  assert.deepEqual(launchSpec('/b/codex', [], { cwd: '/h' }, io).options, { cwd: '/h' });
  const win = launchSpec('C:\\b\\codex.exe', [], { group: true }, { ...io, platform: 'win32' }).options;
  assert.deepEqual(win, { windowsHide: true });
});

test('spawnGroup asks for a group and marks only a real child: a stand-in is never signalled as a group', () => {
  const seen: any[] = [];
  const fake: any = { pid: 4242 };
  const out = spawnGroup(
    () => fake,
    '/b/agent',
    ['--acp'],
    { cwd: '/h' },
    (b: string, a: string[], o: any) => (seen.push([b, a, o]), [b, a, o]),
  );
  assert.equal(out, fake);
  assert.deepEqual(seen, [['/b/agent', ['--acp'], { cwd: '/h', group: true }]]);
  assert.equal(fake.group, undefined, 'a made-up pid must never reach process.kill(-pid)');
  assert.equal(
    spawnGroup(
      () => null,
      '/b/x',
      [],
      {},
      (b: string, a: string[], o: any) => [b, a, o],
    ),
    null,
  );
  // stopping the stand-in signals it alone
  let kills = 0;
  const stub: any = { pid: 4242, group: undefined, kill: () => (kills++, true) };
  killTree(stub);
  assert.equal(kills, 1);
  assert.equal(endGroup(stub), false);
});

test('stopping a harness ends the command it is running too, where a plain kill left it behind', { skip: !posix }, async () => {
  // before: the command outlived its harness (#1347)
  const plain = await harness({ stay: true, plain: true });
  assert.equal(plain.proc.group, undefined, 'not a group of its own');
  plain.proc.kill();
  assert.equal(await gone(plain.proc.pid), true);
  await sleep(300);
  assert.equal(alive(plain.command), true, 'a kill of the harness alone leaves its command running');

  const h = await harness({ stay: true });
  assert.equal(h.proc.group, true);
  assert.equal(killTree(h.proc), true);
  assert.equal(h.proc.stopped, true);
  assert.equal(await gone(h.command), true, 'the command went with the harness');
  assert.equal(await gone(h.proc.pid), true);
  assert.equal(endGroup(h.proc), false, 'a stopped harness was handled by killTree');
});

test('a harness that exits on its own takes its leftover commands with it', { skip: !posix }, async () => {
  const h = await harness({ stay: false });
  await h.exited;
  assert.equal(alive(h.command), true, 'left running when its harness exited');
  assert.equal(await endGroup(h.proc), true);
  assert.equal(await gone(h.command), true);
  // nothing of the group is left: nothing to signal, and the caller is told so
  assert.equal(await endGroup(h.proc), false);
});

test('a command that ignores SIGTERM is killed once the grace period is over', { skip: !posix }, async () => {
  const h = await harness({ stay: true, ignoreTerm: true });
  await sleep(200);
  killTree(h.proc);
  await sleep(500);
  assert.equal(alive(h.command), true, 'still there during the grace period');
  assert.equal(await gone(h.command, GROUP_GRACE_MS + 3000), true, 'SIGKILL after the grace period');
});

test('only a group spawnGroup made is signalled, never pid 0 or 1, and not on Windows', () => {
  let kills = 0;
  const one: any = { pid: 1, group: true, kill: () => (kills++, true) };
  killTree(one);
  assert.equal(kills, 1, 'pid 1 is signalled alone, never as a group');
  assert.equal(endGroup({ pid: 0, group: true } as any), false);
  assert.equal(endGroup(null), false);
  const real = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(endGroup({ pid: 4242, group: true } as any), false);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
});

test('a pid the system handed to another process after the harness exited is never signalled as a group', { skip: !posix }, async () => {
  // the stand-in "new owner" of the pid: a plain child, not a group leader, so a wrong signal could reach nothing
  const decoy = childProcess.spawn('sleep', ['30'], { stdio: 'ignore' });
  started.add(decoy.pid as number);
  const exited: any = { pid: decoy.pid, group: true, exitCode: 0, signalCode: null, kill: () => true };
  assert.equal(endGroup(exited), false, 'its harness exited and the pid answers again: it is someone else');
  assert.equal(alive(decoy.pid as number), true);
  // after a stop: the grace period's SIGKILL checks again before it fires
  const h = await harness({ stay: true });
  killTree(h.proc);
  assert.equal(await gone(h.proc.pid), true);
  h.proc.pid = decoy.pid;
  await sleep(GROUP_GRACE_MS + 400);
  assert.equal(alive(decoy.pid as number), true);
  // another user's process at the pid (EPERM) counts as taken too
  const rootPid = Number(
    childProcess
      .execFileSync('ps', ['-U', '0', '-o', 'pid='], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .find((s) => Number(s) > 1) ?? 0,
  );
  if (process.getuid?.() !== 0 && rootPid > 1)
    assert.equal(endGroup({ pid: rootPid, group: true, exitCode: 0, signalCode: null } as any), false);
});

test('a command in a process group of its own (as Codex and Claude Code run them) goes with its harness', { skip: !posix }, async () => {
  const h = await harness({ stay: true, ownGroup: true });
  killTree(h.proc);
  assert.equal(await gone(h.command), true, 'found through the process tree, not the harness group');
  assert.equal(await gone(h.proc.pid), true);
});

test('a hung harness that ignores SIGTERM is SIGKILLed with its commands after the grace period', { skip: !posix }, async () => {
  const h = await harness({ stay: true, ownGroup: true, hung: true });
  await sleep(200);
  killTree(h.proc);
  await sleep(500);
  assert.equal(alive(h.proc.pid), true, 'it ignored SIGTERM');
  assert.equal(await gone(h.proc.pid, GROUP_GRACE_MS + 3000), true);
  assert.equal(await gone(h.command), true, 'its command, in a group of its own, went too');
});

test('a harness that exits on its own: what its children started, in groups of their own, is ended too', { skip: !posix }, async () => {
  const h = await harness({ stay: false, ownGroup: true, member: true });
  await h.exited;
  assert.equal(alive(h.command), true, 'left running by the harness that exited');
  assert.equal(await endGroup(h.proc), true);
  assert.equal(await gone(h.command), true);
});

test('stopping a harness that already exited, with nothing of it left, falls back to the child alone', { skip: !posix }, async () => {
  const h = await harness({ stay: false });
  await h.exited;
  process.kill(h.command, 'SIGKILL');
  assert.equal(await gone(h.command), true);
  let kills = 0;
  const kill = h.proc.kill.bind(h.proc);
  h.proc.kill = (...a: any[]) => (kills++, kill(...a));
  assert.equal(killTree(h.proc), true);
  for (const end = Date.now() + 3000; !kills && Date.now() < end; ) await sleep(20);
  assert.equal(kills, 1, 'its tree was gone, so the child itself was signalled');
});

test('spawnGroup records what a real child starts, and stops recording when it exits (#1486)', { skip: !posix }, async () => {
  const h = await harness({ stay: true });
  const watch = h.proc.watch;
  assert.equal(watch.root, h.proc.pid);
  assert.equal(watch.stopped, false);
  killTree(h.proc);
  assert.equal(await gone(h.proc.pid), true);
  await waitFor(() => watch.stopped, 'the watcher to stop');
  assert.equal(watch.stopped, true);
});

test('a recorded command is still ended when the harness pid has been handed to another process', { skip: !posix }, async () => {
  const decoy = childProcess.spawn('sleep', ['30'], { stdio: 'ignore' });
  const orphan = childProcess.spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
  started.add(decoy.pid as number);
  started.add(orphan.pid as number);
  const exited: any = {
    pid: decoy.pid,
    group: true,
    exitCode: 0,
    signalCode: null,
    watch: { known: new Map([[orphan.pid as number, orphan.pid as number]]) },
  };
  const ended = endGroup(exited);
  assert.ok(ended, 'its commands are recorded: they are ours although the pid is not');
  assert.equal(await ended, true);
  assert.equal(await gone(orphan.pid as number), true);
  assert.equal(alive(decoy.pid as number), true, 'the stranger at the harness pid is left alone');
});
