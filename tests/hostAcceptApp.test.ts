// The app-side acceptance run (scripts/host-accept-app.mjs): every step against a stand-in machine and a stand-in remote Host that behave as the real ones do, and the failures each step reports (W: a wrong answer, A: connection loss, B: arguments and fallbacks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOT_VERIFIED, main, parseArgs, realDeps } from '../scripts/host-accept-app.mjs';
import { STEPS, cleanup } from '../scripts/host-accept-app/steps.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-app-test-')));

type Faults = Partial<{
  noIp: boolean;
  authorize: boolean;
  wrongSsh: boolean;
  addFails: boolean;
  unpaired: boolean;
  noTunnel: boolean;
  longSocket: boolean;
  wrongReply: boolean;
  wrongStop: boolean;
  noAutoResume: boolean;
  resumeByPatches: boolean;
  wrongCrash: boolean;
  notQueued: boolean;
  noMarker: boolean;
  noDelivery: boolean;
  noReplyAfter: boolean;
  linux: boolean;
  wrongBusy: boolean;
  stuckBusy: boolean;
  restartsEarly: boolean;
  neverRestarts: boolean;
  noWaiting: boolean;
  stuckUpdate: boolean;
  leftBehind: boolean;
  filesLeft: boolean;
  stillListed: boolean;
}>;

/** A remote Host the app follows: it answers as the real one does, with its events and its connection state. */
function world(f: Faults = {}) {
  const log: string[] = [];
  const patchFns: ((p: any) => void)[] = [];
  const resyncFns: ((p: any) => void)[] = [];
  const stateFns: ((s: string) => void)[] = [];
  let state = 'online';
  const items = new Map<string, any[]>();
  const queue: any[] = [];
  let pid = 100;
  let turnRunning = false;
  let updatePending = false;
  let updateState: string | undefined;
  let uninstalled = false;
  let removed = false;
  const setState = (s: string) => {
    state = s;
    for (const fn of stateFns) fn(s);
  };
  const say = (chatId: string, item: any) => {
    items.set(chatId, [...(items.get(chatId) ?? []), item]);
    for (const fn of patchFns) fn({ chatId, rev: 1, patch: { item } });
  };
  const assistant = (text: string, stopReason = 'end_turn') => ({ t: 'assistant', text, stopReason });
  const host = {
    state: () => state,
    onState: (fn: (s: string) => void) => (stateFns.push(fn), () => stateFns.splice(stateFns.indexOf(fn), 1)),
    events: {
      onPatch: (fn: any) => patchFns.push(fn),
      onResync: (fn: any) => resyncFns.push(fn),
    },
    async subscribe(chatId: string) {
      // a Host that came back without the stream resuming: asked again, its snapshot has the interrupted turn’s end
      const ended = (f.noAutoResume || f.resumeByPatches) && chatId.includes('crash') && state === 'online';
      // snapshot only (the Host lost patches), or the patches the app missed
      if (f.resumeByPatches && ended)
        return { snapshot: { rev: 3, items: [] }, patches: [{ rev: 4, patch: { item: assistant('', 'cancelled') } }], generation: 'gen-1' };
      return {
        snapshot: { rev: 3, items: ended ? [assistant('', 'cancelled')] : (items.get(chatId) ?? []) },
        patches: null,
        generation: 'gen-1',
      };
    },
    async start(chatId: string, item: any) {
      log.push(`start ${chatId} ${item.text}`);
      if (item.text.includes('SLOW')) turnRunning = true;
      if (!item.text.includes('SLOW')) say(chatId, assistant(f.wrongReply ? 'something else' : `fake-acp: ${item.text}`));
    },
    async send(chatId: string, item: any) {
      log.push(`send ${chatId} ${item.text}`);
      if (!f.noReplyAfter) say(chatId, assistant(`fake-acp: ${item.text}`));
    },
    async stop(chatId: string) {
      log.push(`stop ${chatId}`);
      turnRunning = false;
      // an idle Host with a staged update restarts into it
      if (updatePending && !f.neverRestarts) {
        updatePending = false;
        setState('offline');
        setTimeout(() => {
          pid++;
          if (!f.stuckUpdate) updateState = undefined;
          setState('online');
        }, 20);
      }
      say(chatId, assistant('', f.wrongStop ? 'end_turn' : 'cancelled'));
    },
  };
  const row = { id: 'ssh:admin@10.0.0.5', status: 'online', socketPath: '/Users/admin/Library/Application Support/mopilot-host/host.sock' };
  const machines = {
    async add() {
      return f.addFails
        ? { ok: false, paired: false, error: 'no space', id: row.id, steps: [] }
        : { ok: true, paired: !f.unpaired, error: '', id: row.id, steps: [{ id: 'status', state: 'ok' }] };
    },
    row: () => row,
    onRowChange: () => () => undefined,
    list: () => ({ machines: removed && !f.stillListed ? [] : [{ id: row.id, status: 'online', update: updateState }] }),
    async removePlan() {
      return { ssh: true, online: true, busy: f.stuckBusy ? 'yes' : f.wrongBusy ? 'no' : turnRunning ? 'yes' : 'no', daemon: false };
    },
    async updateHost() {
      updatePending = true;
      updateState = f.noWaiting ? undefined : 'waiting';
      if (f.restartsEarly) pid++;
      return { version: '9.9.9', output: '' };
    },
    async uninstallHost() {
      uninstalled = true;
      return { left: f.leftBehind ? 'daemon' : '' };
    },
    capabilities: () => ({ iab: true }),
    hostFor: () => host,
    connectedHost: () => (state === 'online' ? host : null),
    remove: () => ((removed = true), log.push('remove machine')),
    dispose: () => log.push('dispose machines'),
  };
  const commands: string[] = [];
  const m = {
    async run(command: string, input?: Buffer) {
      commands.push(command);
      const out = (stdout: string, code = 0) => ({ code, stdout, stderr: code ? 'denied' : '' });
      if (command === 'whoami') return out('admin\n');
      if (command.startsWith('uname -s')) return out(`${f.linux ? 'Linux' : 'Darwin'}\n/usr/bin/node\n`);
      if (command.includes('authorized_keys')) return out('', f.authorize ? 1 : 0);
      if (command.includes("pgrep -f '[f]ake-acp-agent'")) return out('777\n');
      if (command.startsWith("pgrep -f '[m]opilot-host.mjs serve'")) return out(uninstalled ? '' : `${pid}\n`);
      if (command.includes('/updates/versions')) return out('abc123\n');
      if (command.startsWith('test ! -e')) return out(f.filesLeft ? '' : 'gone\n');
      if (command.startsWith("kill -9 $(pgrep -f '[m]opilot-host.mjs serve'")) {
        // the Host dies, the supervisor brings it back, and the new one ends the interrupted turn
        setState('offline');
        turnRunning = false;
        setTimeout(() => {
          setState('online');
          if (!f.noAutoResume && !f.resumeByPatches) say(`acp:fake:crash-${nonce}`, assistant('', f.wrongCrash ? 'end_turn' : 'cancelled'));
        }, 30);
        return out('');
      }
      if (/launchctl bootout|systemctl --user stop/.test(command) && !command.includes('launchctl bootstrap'))
        return setState('offline'), out('');
      if (/launchctl bootstrap|systemctl --user start/.test(command)) {
        setTimeout(() => {
          setState('online');
          if (!f.noDelivery) {
            queue.splice(0);
            say(`acp:fake:outbox-${nonce}`, assistant('fake-acp: sent while away'));
          }
        }, 30);
        return out('');
      }
      if (input) commands.push(`(${input.length} bytes)`);
      return out('');
    },
  };
  let nonce = '';
  const deps = () => ({
    ...realDeps(),
    tartIp: () => (f.noIp ? '' : '10.0.0.5'),
    keygen: (file: string) => (fs.writeFileSync(file, 'key'), fs.writeFileSync(`${file}.pub`, 'pub')),
    ssh: () => (f.wrongSsh ? 'denied\n' : 'reached\n'),
    agentFiles: () => [{ rel: 'tests/fixtures/fake-acp-agent.mjs', data: Buffer.from('x') }],
    makeMachines: (ctx: any) => {
      nonce = ctx.nonce;
      return {
        machines,
        pool: {},
        tunnels: f.noTunnel ? [] : [{ localSocket: f.longSocket ? `/tmp/${'x'.repeat(120)}.sock` : '/tmp/mopilot-host-501-ab/4bcb.sock' }],
      };
    },
    makeSend: () => ({
      send: {
        begin: () => undefined,
        send: async () => {
          if (!f.notQueued) queue.push({ waitingFor: f.noMarker ? undefined : 'host' });
          return { action: f.notQueued ? 'started' : 'queued' };
        },
        dispose: () => log.push('dispose send'),
      },
      queue: () => queue,
    }),
  });
  return { m, log, commands, deps, host };
}

async function run(f: Faults = {}, args: string[] = ['--vm', 'mopilot-work'], patience?: number) {
  const w = world(f);
  const out: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), deps: w.deps as any, channelFor: () => w.m as any, patience });
  return { ...w, code, report: out[0] };
}

test('B: the command line names one machine; anything else is refused', () => {
  assert.deepEqual(parseArgs(['--vm', 'mopilot-work', '--out', 'r.md']), { vm: 'mopilot-work', ssh: '', out: 'r.md' });
  assert.deepEqual(parseArgs(['--ssh', 'mac-mini-test']), { vm: '', ssh: 'mac-mini-test', out: '' });
  assert.throws(() => parseArgs([]), /Name the machine/);
  assert.throws(() => parseArgs(['--vm', 'a', '--ssh', 'b']), /exactly one of/);
  assert.throws(() => parseArgs(['--vm', 'a', '--nope']), /Unknown option --nope/);
  assert.ok(NOT_VERIFIED.length > 0);
});

test('B: a physical machine named with --ssh is reported under its own name and reached through the deps and channel it was given', async () => {
  const seen: unknown[] = [];
  const w = world({});
  const out: string[] = [];
  const code = await main(['--ssh', 'mac-mini-test'], {
    out: (t) => out.push(t),
    deps: ((o: unknown) => (seen.push(['deps', o]), w.deps())) as any,
    channelFor: ((target: string, o: unknown) => (seen.push(['channel', target, o]), w.m)) as any,
  });
  assert.equal(code, 0, out[0]);
  assert.match(out[0], /on mac-mini-test \(the app’s side\)/);
  assert.deepEqual(seen[0], ['channel', 'mac-mini-test', { vm: '', ssh: 'mac-mini-test', out: '' }]);
  assert.deepEqual(seen[1], ['deps', { vm: '', ssh: 'mac-mini-test', out: '' }]);
});

test('I: every step passes against a machine and a Host that behave as the real ones, and the run cleans up', {
  timeout: 60_000,
}, async () => {
  const outFile = path.join(tmp, 'app.md');
  const r = await run({}, ['--vm', 'mopilot-work', '--out', outFile]);
  assert.equal(r.code, 0, r.report);
  assert.match(r.report, /\*\*10\/10 passed\*\*/);
  for (const s of STEPS) assert.ok(r.report.includes(`| ${s.id} `), s.id);
  assert.equal(fs.readFileSync(outFile, 'utf8'), r.report);
  assert.ok(r.log.includes('remove machine') && r.log.includes('dispose machines'), 'the app’s side is cleaned up');
  assert.match(r.commands.at(-1)!, /uninstall/, 'and so is the machine');
  // the fake agent was sent to the machine and the Host restarted to read it
  assert.ok(r.commands.some((c) => c.includes('harnesses.json')));
  assert.ok(r.commands.some((c) => c.includes('launchctl kickstart')));
});

test('I: on a Linux machine the Host is stopped and started with systemctl', { timeout: 60_000 }, async () => {
  const r = await run({ linux: true });
  assert.equal(r.code, 0, r.report);
  assert.ok(r.commands.includes('systemctl --user stop mopilot-host') && r.commands.includes('systemctl --user start mopilot-host'));
});

/** The row of a step in a report. */
const rowOf = (report: string, id: string) => report.split('\n').find((l) => l.startsWith(`| ${id} `)) ?? '';

test('W: each step reports what was wrong, and a failed required step skips the rest', { timeout: 120_000 }, async () => {
  const cases: [Faults, string, RegExp][] = [
    [{ noIp: true }, 'B1', /no address or user/],
    [{ authorize: true }, 'B1', /could not be authorized: denied/],
    [{ wrongSsh: true }, 'B1', /ssh answered "denied"/],
    [{ addFails: true }, 'B2', /Install failed, paired false: no space/],
    [{ unpaired: true }, 'B2', /Install worked, paired false/],
    [{ noTunnel: true }, 'B4', /No tunnel was made/],
    [{ longSocket: true }, 'B4', /The tunnel socket is \/tmp\/x+\.sock/],
    [{ wrongReply: true }, 'B5', /The reply was "something else"/],
    [{ wrongStop: true }, 'B6', /ended with end_turn/],
    [{ wrongCrash: true }, 'B7', /interrupted turn ended with end_turn/],
    [{ notQueued: true }, 'B8', /was started, not queued/],
    [{ noMarker: true }, 'B8', /not "Waiting for host"/],
    [{ wrongBusy: true }, 'B9', /said busy was "no" while a turn runs/],
    [{ noWaiting: true }, 'B9', /The row said "undefined" after the update was sent/],
    [{ restartsEarly: true }, 'B9', /restarted while a turn was running/],
    [{ neverRestarts: true }, 'B9', /Timed out waiting for the Host to restart into the update/],
    [{ stuckUpdate: true }, 'B9', /Timed out waiting for the row to drop the update state/],
    [{ stuckBusy: true }, 'B10', /Timed out waiting for the Host to say no turn runs/],
    [{ leftBehind: true }, 'B10', /Something was left: daemon/],
    [{ filesLeft: true }, 'B10', /files or socket are still on the machine/],
    [{ stillListed: true }, 'B10', /The machine is still listed/],
    [
      { noDelivery: true },
      'B8',
      /Timed out waiting for the queued message to be delivered\. \(connection online, registry row "online", queue \["host"\]\)/,
    ],
  ];
  for (const [fault, id, why] of cases) {
    const r = await run(fault, ['--vm', 'mopilot-work'], 0.05);
    assert.equal(r.code, 1, `${id} ${JSON.stringify(fault)}`);
    assert.match(rowOf(r.report, id), new RegExp(`\\| FAIL \\|.*`), id);
    assert.match(rowOf(r.report, id), why, `${id} ${JSON.stringify(fault)}`);
  }
  const skipped = await run({ noIp: true }, ['--vm', 'mopilot-work'], 0.05);
  assert.match(rowOf(skipped.report, 'B2'), /\| SKIP \|/);
});

test('A: after a kill the stream that does not resume by itself is read again from the revision it reached', {
  timeout: 60_000,
}, async () => {
  const r = await run({ noAutoResume: true }, ['--vm', 'mopilot-work'], 0.5);
  assert.equal(r.code, 0, r.report);
  assert.match(rowOf(r.report, 'B7'), /resubscribed by rev/);
});

test('A: a Host that answers nothing after the crash fails the step with what it waited for, not by hanging', {
  timeout: 120_000,
}, async () => {
  const r = await run({ noReplyAfter: true }, ['--vm', 'mopilot-work'], 0.05);
  assert.equal(r.code, 1);
  assert.match(rowOf(r.report, 'B7'), /FAIL.*the next reply/);
});

test('A: or from the patches it missed', { timeout: 60_000 }, async () => {
  const r = await run({ resumeByPatches: true }, ['--vm', 'mopilot-work'], 0.5);
  assert.equal(r.code, 0, r.report);
  assert.match(rowOf(r.report, 'B7'), /resubscribed by rev/);
});

test('W: cleanup frees the app’s side even when removing the machine throws', async () => {
  const log: string[] = [];
  const state = {
    id: 'x',
    machines: {
      remove: () => {
        throw new Error('gone');
      },
      dispose: () => log.push('dispose'),
    },
  };
  const m = { run: async (c: string) => (log.push(c), { code: 0, stdout: '', stderr: '' }) };
  await assert.rejects(cleanup({ m, state }), /gone/);
  assert.equal(log[0], 'dispose');
  assert.match(log[1], /uninstall/);
  await cleanup({ m, state: {} });
});

test('B: the deps build the app’s own modules, and the script run as a program refuses a bad command line', async () => {
  const d = realDeps();
  // the app's own modules, built with nothing connected: no ssh runs until a tunnel is asked for
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  fs.writeFileSync(path.join(bin, 'tart'), '#!/bin/sh\necho 192.168.64.9\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nshift $(($# - 1))\necho "ran $1"\n', { mode: 0o755 });
  const saved = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(tmp, 'app-'));
  try {
    process.env.PATH = `${bin}:${saved}`;
    assert.equal(d.tartIp('mopilot-work'), '192.168.64.9');
    // a name that walks out of its VM directory would ask for another VM's address
    assert.throws(() => d.tartIp('mopilot-work/../mopilot-bench'), /not a valid VM name/);
    d.keygen(path.join(dir, 'k'));
    assert.ok(fs.existsSync(path.join(dir, 'k.pub')));
    assert.equal(d.ssh(['-i', 'k'], 'admin@x', 'echo hi').trim(), 'ran echo hi');
  } finally {
    process.env.PATH = saved;
  }
  const ctx: any = { dir, state: { sshArgs: [], id: 'ssh:a', dataDir: '/d' } };
  const made = d.makeMachines(ctx);
  const t1 = made.pool.get({ destination: 'admin@x', remoteSocket: '/s' });
  assert.equal(made.pool.get({ destination: 'admin@x', remoteSocket: '/s' }), t1, 'one tunnel for one machine');
  assert.equal(made.tunnels.length, 1);
  assert.equal(made.machines.list().machines.length, 0);
  const listened: string[] = [];
  const away = { state: () => 'offline', onState: () => () => undefined, connect: async () => undefined };
  ctx.state.machines = {
    hostFor: () => away,
    row: () => undefined,
    onRowChange: () => (listened.push('on'), () => void listened.push('off')),
  };
  const sender = d.makeSend(ctx, 'acp:fake:q');
  assert.deepEqual(sender.queue('acp:fake:q'), []);
  // a message to a machine the app has no connection to waits in the outbox and shows in the chat's queue as waiting for the host
  sender.send.begin('acp:fake:q', { harness: 'acp:fake' });
  assert.equal((await sender.send.send('acp:fake:q', { text: 'one' }))?.action, 'queued');
  assert.equal((await sender.send.send('acp:fake:q', { id: crypto.randomUUID(), text: 'two' }))?.action, 'queued');
  assert.deepEqual(
    sender.queue('acp:fake:q').map((q: any) => q.waitingFor),
    ['host', 'host'],
  );
  assert.deepEqual(listened, ['on'], 'the outbox listens to the registry rows once a machine is followed');
  sender.send.dispose();
  assert.deepEqual(listened, ['on', 'off']);
  made.machines.dispose();
  assert.equal(typeof d.makeMachines, 'function');
  assert.ok(Buffer.isBuffer(d.readFile(path.join(ROOT, 'host/package.json'))));
  assert.ok(d.agentFiles().every((f) => Buffer.isBuffer(f.data)));
  // run for real against a `tart` that knows no machine: the first step fails, the rest are skipped, the table is printed
  fs.writeFileSync(path.join(bin, 'tart'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/host-accept-app.mjs'), '--vm', 'mopilot-none'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /\| B1 .*\| FAIL \|/);
  assert.match(run.stdout, /\| B2 .*\| SKIP \|/);
  // a physical machine: the address is what ssh resolves its alias to (ssh -G), else the alias itself, and the channel is ssh, not tart
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nif [ "$1" = -G ]; then echo "hostname 192.168.86.151"; exit 0; fi\nexit 1\n', {
    mode: 0o755,
  });
  const ssh = realDeps({ ssh: 'mac-mini-test' });
  const viaSsh = spawnSync(process.execPath, [path.join(ROOT, 'scripts/host-accept-app.mjs'), '--ssh', 'mac-mini-test'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(viaSsh.status, 1, viaSsh.stderr);
  assert.match(viaSsh.stdout, /on mac-mini-test \(the app’s side\)[\s\S]*\| B1 .*\| FAIL \|/);
  const saved2 = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${saved2}`;
    assert.equal(ssh.tartIp('mac-mini-test'), '192.168.86.151');
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "user x"\n', { mode: 0o755 });
    assert.equal(ssh.tartIp('user@10.0.0.9'), 'user@10.0.0.9', 'an alias ssh does not resolve stays as it was named');
  } finally {
    process.env.PATH = saved2;
  }
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts/host-accept-app.mjs'), '--bogus'], { encoding: 'utf8' });
  assert.deepEqual([bad.status, /host-accept-app: Unknown option --bogus/.test(bad.stderr)], [2, true]);
});
