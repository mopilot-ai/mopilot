// The dev host's small parts: the LAN address, the scratch folder and its safeStorage, the repository, the log lines and the terminal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { until } from './support/mobileStack.ts';
import { lanAddress } from '../scripts/mobile-dev-host/lan.mjs';
import { defaultScratch, scratchDir, scratchSafeStorage } from '../scripts/mobile-dev-host/scratch.mjs';
import { ensureRepo } from '../scripts/mobile-dev-host/repo.mjs';
import { brief, eventLine, explainEvent, explainRequest, line, replyLine, requestLine } from '../scripts/mobile-dev-host/format.mjs';
import { createPty, repairSpawnHelper } from '../scripts/mobile-dev-host/pty.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-parts-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const nic = (address: string, o: object = {}) => ({ address, family: 'IPv4', internal: false, ...o }) as any;

test('the LAN address is the first private IPv4 that is up, Wi-Fi first', () => {
  assert.equal(
    lanAddress({ lo0: [nic('127.0.0.1', { internal: true })], en5: [nic('10.0.0.9')], en0: [nic('192.168.86.228')] }),
    '192.168.86.228',
  );
  assert.equal(lanAddress({ en5: [nic('fe80::1', { family: 'IPv6' }), nic('172.20.1.1')] }), '172.20.1.1');
  assert.equal(lanAddress({ utun: [nic('8.8.8.8')], gone: undefined }), null);
  assert.equal(lanAddress({}), null);
  const here = lanAddress();
  assert.ok(here === null || /^\d+\.\d+\.\d+\.\d+$/.test(here));
});

test('the scratch folder is private and its safeStorage round-trips across a restart', () => {
  const dir = scratchDir(path.join(scratch, 'one', 'two'));
  assert.equal(statSync(dir).mode & 0o077, 0, 'owner only');
  assert.ok(defaultScratch().endsWith('.mopilot-mobile-dev-host'));
  const safe = scratchSafeStorage(dir);
  assert.equal(safe.isEncryptionAvailable(), true);
  const sealed = safe.encryptString('secret ✓');
  assert.ok(!sealed.includes('secret'));
  assert.notDeepEqual(safe.encryptString('secret ✓'), sealed, 'a fresh nonce each time');
  assert.equal(scratchSafeStorage(dir).decryptString(sealed), 'secret ✓');
  assert.throws(() => scratchSafeStorage(dir).decryptString(Buffer.concat([sealed.subarray(0, 40), Buffer.from('x')])));
  assert.equal(statSync(path.join(dir, 'safe.key')).mode & 0o077, 0);
});

test('the repository has a committed baseline and uncommitted edits, and a second call changes nothing', () => {
  const root = ensureRepo(path.join(scratch, 'repo-host'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root }).toString();
  assert.equal(git('log', '--format=%s').trim(), 'Initial price calculator');
  assert.deepEqual(git('status', '--short').split('\n').filter(Boolean).sort(), [' M .env', ' M src/price.ts', '?? notes/'].sort());
  writeFileSync(path.join(root, 'README.md'), 'edited by a chat\n');
  assert.equal(ensureRepo(path.join(scratch, 'repo-host')), root);
  assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), 'edited by a chat\n');
});

test('log lines are one readable line each, cut to a terminal', () => {
  assert.equal(brief({ a: 1 }), '{"a":1}');
  assert.equal(brief(undefined), 'null');
  assert.equal(brief({ text: 'x'.repeat(200) }).length <= 110, true);
  assert.match(brief({ text: 'x'.repeat(200) }), /…/);
  assert.equal(brief({ long: 'y'.repeat(300) }, 40).length, 40);
  assert.match(line(0, 'hello'), /^00:00:00\.000 hello$/);
  assert.equal(requestLine('p_abcdefghij', 'chat.follow', { chatId: 'c1' }), 'phone abcdef → chat.follow {"chatId":"c1"}');
  assert.equal(requestLine('p_abcdefghij', 'machine.hello', undefined), 'phone abcdef → machine.hello {}');
  assert.equal(replyLine('p_abcdefghij', 'chat.follow', 3, { ok: true, value: { rev: 1 } }), 'phone abcdef ← chat.follow 3ms ok {"rev":1}');
  assert.equal(replyLine('p_abcdefghij', 'x', 1, { ok: true }), 'phone abcdef ← x 1ms ok {}');
  assert.equal(
    replyLine('p_abcdefghij', 'card.answer', 2, { ok: false, error: { code: 'stale', message: 'gone' } }),
    'phone abcdef ← card.answer 2ms ERROR stale: gone',
  );
  const evt = { id: 'm_1', t: 1, kind: 'event', ev: 'session.patch', chatId: 'c1', rev: 4, patch: { turn: 'idle' } };
  assert.equal(eventLine('p_abcdefghij', evt), 'phone abcdef ← event session.patch chat=c1 rev=4 {"patch":{"turn":"idle"}}');
  assert.equal(eventLine('p_abcdefghij', { ev: 'machine.presence' }), 'phone abcdef ← event machine.presence {}');
  assert.equal(
    eventLine('p_abcdefghij', { ev: 'pty.data', stream: 's', at: 5, data: Buffer.from('hello').toString('base64') }),
    'phone abcdef ← event pty.data 5 bytes at 5',
  );
  assert.equal(eventLine('p_abcdefghij', { ev: 'pty.data', at: 0 }), 'phone abcdef ← event pty.data 0 bytes at 0');
});

/** A fake node-pty whose processes record what they are told. */
function fakePty(o: { fail?: boolean } = {}) {
  const procs: any[] = [];
  const mod = {
    spawn: (shell: string, args: string[], opts: any) => {
      if (o.fail) throw new Error('posix_spawnp failed.');
      const proc: any = { shell, args, opts, log: [] as any[], data: null, exit: null };
      proc.onData = (fn: any) => (proc.data = fn);
      proc.onExit = (fn: any) => (proc.exit = fn);
      for (const m of ['write', 'resize', 'kill', 'pause', 'resume']) proc[m] = (...a: any[]) => proc.log.push([m, ...a]);
      procs.push(proc);
      return proc;
    },
  };
  return { mod, procs };
}

test('terminals run on node-pty, report exit, and stop on kill', () => {
  const { mod, procs } = fakePty();
  const pty = createPty({ load: () => mod, shell: '/bin/sh' });
  assert.equal(pty.real, true);
  const got: any[] = [];
  pty.spawn('k1', { cwd: '/repo', cols: 80, rows: 24 }, { onData: (d: string) => got.push(d), onExit: (e: any) => got.push(e) });
  assert.deepEqual(procs[0].opts, { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/repo', env: process.env });
  procs[0].data('hi');
  pty.write('k1', 'ls\n');
  pty.resize('k1', 100, 30);
  pty.pause('k1');
  pty.resume('k1');
  assert.deepEqual(procs[0].log, [['write', 'ls\n'], ['resize', 100, 30], ['pause'], ['resume']]);
  procs[0].exit({ exitCode: 0, signal: 0 });
  assert.deepEqual(got, ['hi', { exitCode: 0, signal: 0, killed: false }]);
  // a shell that ended is gone: a late kill does nothing
  pty.kill('k1');
  assert.deepEqual(procs[0].log.at(-1), ['resume']);
  // a killed shell reports it
  pty.spawn('k3', { cwd: '/', cols: 1, rows: 1 }, { onData() {}, onExit: (e: any) => got.push(e) });
  pty.kill('k3');
  pty.kill('k3');
  assert.deepEqual(procs[1].log.at(-1), ['kill']);
  procs[1].exit({ exitCode: null, signal: 15 });
  assert.equal((got.at(-1) as any).killed, true);
  // calls for a shell that is not there do nothing
  pty.write('none', 'x');
  pty.resize('none', 1, 1);
  pty.pause('none');
  pty.resume('none');
  pty.spawn('k2', { cwd: '/', cols: 1, rows: 1 }, { onData() {}, onExit() {} });
  pty.killAll();
  assert.deepEqual(procs[2].log.at(-1), ['kill']);
});

test('without node-pty, or when it cannot start a shell, a shell runs on plain pipes', async () => {
  const told: string[] = [];
  for (const way of ['missing', 'broken']) {
    const pty = createPty({
      load: () => {
        if (way === 'missing') throw new Error('Cannot find module');
        return fakePty({ fail: true }).mod;
      },
      shell: process.platform === 'win32' ? 'cmd' : '/bin/sh',
      onFallback: (why: string) => told.push(why),
    });
    assert.equal(pty.real, way === 'broken');
    const out: string[] = [];
    const exits: any[] = [];
    pty.spawn(`p-${way}`, { cwd: scratch, cols: 80, rows: 24 }, { onData: (d: string) => out.push(d), onExit: (e: any) => exits.push(e) });
    pty.write(`p-${way}`, 'echo piped-$((1+2))\n');
    pty.resize(`p-${way}`, 10, 10);
    pty.pause(`p-${way}`);
    pty.resume(`p-${way}`);
    await until(() => out.join('').includes('piped-3'), 'the shell output');
    pty.kill(`p-${way}`);
    await until(() => exits.length === 1, 'the shell to exit');
    assert.equal(exits[0].killed, true);
  }
  assert.deepEqual(told, ['posix_spawnp failed.']);
  // a shell that ends by itself reports it, with stderr read as output
  const pty = createPty({ load: () => null, shell: '/bin/sh' });
  const out: string[] = [];
  const exits: any[] = [];
  pty.spawn('self', { cwd: scratch, cols: 80, rows: 24 }, { onData: (d: string) => out.push(d), onExit: (e: any) => exits.push(e) });
  pty.write('self', 'echo oops 1>&2; exit 3\n');
  await until(() => exits.length === 1, 'the shell to exit by itself');
  assert.equal(exits[0].exitCode, 3);
  assert.equal(exits[0].killed, false);
  assert.ok(out.join('').includes('oops'));
});

test('the shell defaults to $SHELL, then zsh, and a failure to start one is reported even when nobody listens', () => {
  const before = process.env.SHELL;
  try {
    for (const [env, expected] of [
      ['/bin/custom', '/bin/custom'],
      [undefined, '/bin/zsh'],
    ] as const) {
      if (env === undefined) delete process.env.SHELL;
      else process.env.SHELL = env;
      const { mod, procs } = fakePty();
      createPty({ load: () => mod }).spawn('k', { cwd: '/', cols: 1, rows: 1 }, { onData() {}, onExit() {} });
      assert.equal(procs[0].shell, expected);
    }
  } finally {
    if (before === undefined) delete process.env.SHELL;
    else process.env.SHELL = before;
  }
  // node-pty failing with something that is not an Error, with no listener: the shell still starts, on pipes
  const spawned: string[] = [];
  const pipes = createPty({
    load: () => ({
      spawn: () => {
        throw 'refused';
      },
    }),
    spawnChild: ((shell: string) => {
      spawned.push(shell);
      return { stdout: null, stderr: null, stdin: null, on() {}, kill() {} };
    }) as any,
    shell: '/bin/sh',
  });
  pipes.spawn('k', { cwd: '/', cols: 1, rows: 1 }, { onData() {}, onExit() {} });
  pipes.write('k', 'x');
  pipes.pause('k');
  pipes.resume('k');
  pipes.kill('k');
  assert.deepEqual(spawned, ['/bin/sh']);
});

test('the default pty is built from the real node-pty, or from nothing when it cannot load', () => {
  const pty = createPty();
  assert.equal(typeof pty.real, 'boolean');
  pty.killAll();
});

test('a shell program that does not exist ends the terminal instead of crashing the host', async () => {
  const pty = createPty({ load: () => null, shell: '/no/such/shell' });
  const exits: any[] = [];
  pty.spawn('gone', { cwd: scratch, cols: 80, rows: 24 }, { onData() {}, onExit: (e: any) => exits.push(e) });
  await until(() => exits.length === 1, 'the failed start');
  assert.deepEqual(exits[0], { exitCode: null, signal: null, killed: false });
  pty.write('gone', 'x');
});

test('node-pty’s spawn-helper gets its execute bit back, once', () => {
  const root = path.join(scratch, 'node-pty');
  const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
  mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'spawn-helper');
  assert.equal(repairSpawnHelper({ root }), null, 'no helper, nothing to repair');
  writeFileSync(helper, '#!/bin/sh\n');
  chmodSync(helper, 0o644);
  assert.equal(repairSpawnHelper({ root }), helper);
  assert.ok(statSync(helper).mode & 0o111);
  assert.equal(repairSpawnHelper({ root }), null, 'already fine');
  // where node-pty is really installed, the call is safe whichever way it finds it
  const real = repairSpawnHelper();
  assert.ok(real === null || typeof real === 'string');
});

test('a shell starts after node-pty is repaired, and the repair is reported only when there was one', () => {
  const repaired: string[] = [];
  const { mod } = fakePty();
  createPty({ load: () => mod, repair: () => '/helper', onRepair: (h: string) => repaired.push(h) });
  createPty({ load: () => mod, repair: () => null, onRepair: (h: string) => repaired.push(`unexpected ${h}`) });
  createPty({
    load: () => {
      throw new Error('no node-pty');
    },
    repair: () => {
      throw new Error('repair must not run without node-pty');
    },
  });
  assert.deepEqual(repaired, ['/helper']);
  // the default report does nothing
  createPty({ load: () => mod, repair: () => '/helper' });
});

test('on pipes a Return key’s carriage return runs the line', async () => {
  const pty = createPty({ load: () => null, shell: '/bin/sh' });
  const out: string[] = [];
  pty.spawn('cr', { cwd: scratch, cols: 80, rows: 24 }, { onData: (d: string) => out.push(d), onExit() {} });
  pty.write('cr', 'echo carriage-$((20+1))\r');
  await until(() => out.join('').includes('carriage-21'), 'the line to run');
  pty.killAll();
});

test('every request and event the phone can meet is explained in one sentence', () => {
  const samples: [string, object][] = [
    ['machine.hello', {}],
    ['chats.recent', { archived: true }],
    ['chats.recent', {}],
    ['chats.pin', { chatId: 'c1', pinned: true }],
    ['chats.pin', { chatId: 'c1', pinned: false }],
    ['chats.rename', { chatId: 'c1', title: 'New' }],
    ['chat.sideChat', { chatId: 'c1' }],
    ['chats.archive', { chatId: 'c1', archived: true }],
    ['chats.archive', { chatId: 'c1', archived: false }],
    ['projects.list', {}],
    ['scheduled.list', {}],
    ['harnesses.list', {}],
    ['options.get', { harness: 'codex' }],
    ['options.get', {}],
    ['options.set', { value: 'auto-review' }],
    ['options.set', {}],
    ['commands.list', {}],
    ['dictation.engine', {}],
    ['chat.start', { harness: 'claude', text: 'fix the bug' }],
    ['chat.start', {}],
    ['chat.follow', { chatId: 'c1' }],
    ['chat.unfollow', { chatId: 'c1' }],
    ['chat.read', { chatId: 'c1' }],
    ['chat.send', { chatId: 'c1', text: 'hello' }],
    ['chat.send', { chatId: 'c1' }],
    ['chat.stop', { chatId: 'c1' }],
    ['chat.switch', { chatId: 'c1', harness: 'codex' }],
    ['card.answer', { chatId: 'c1', key: 'once' }],
    ['card.choose', {}],
    ['card.permit', { value: 'default' }],
    ['diff.list', { chatId: 'c1', scope: 'turn' }],
    ['diff.list', { chatId: 'c1' }],
    ['diff.read', { chatId: 'c1', path: 'a.ts' }],
    ['file.read', { chatId: 'c1', path: 'a.ts' }],
    ['pty.open', { chatId: 'c1', cols: 80, rows: 24 }],
    ['pty.write', {}],
    ['pty.resize', { cols: 100, rows: 30 }],
    ['pty.close', {}],
    ['frames.subscribe', { chatId: 'c1' }],
    ['frames.unsubscribe', { chatId: 'c1' }],
    ['device.unpair', {}],
    ['push.settings.get', {}],
    ['push.settings.set', {}],
  ];
  for (const [method, params] of samples) {
    const text = explainRequest(method, params);
    assert.match(text, /^the phone /, method);
    assert.ok(!text.includes('undefined'), `${method}: ${text}`);
  }
  assert.equal(
    explainRequest('chat.follow', undefined),
    'the phone opens chat ?: it gets the saved history, the open cards and then every live change',
  );
  assert.equal(explainRequest('momo.memory.list', {}), 'the phone calls momo.memory.list');
  assert.equal(explainRequest('toString', {}), 'the phone calls toString', 'a method is looked up by its own name only');

  for (const event of [
    { ev: 'session.patch', chatId: 'c1', patch: { turn: 'idle' } },
    { ev: 'session.patch', chatId: 'c1' },
    { ev: 'items.append', chatId: 'c1', items: [{}, {}] },
    { ev: 'items.append', chatId: 'c1' },
    { ev: 'items.replace', chatId: 'c1', items: [{}] },
    { ev: 'items.replace', chatId: 'c1' },
    { ev: 'turn.state', chatId: 'c1', started: true },
    { ev: 'turn.state', chatId: 'c1' },
    { ev: 'pty.exit' },
    { ev: 'momo.changed', area: 'brain' },
  ])
    assert.ok(explainEvent(event).length > 10, event.ev);
  assert.equal(explainEvent({ ev: 'items.delta', chatId: 'c1' }), '', 'a stream is not explained each time');
  assert.equal(explainEvent({ ev: 'pty.data' }), '');
  assert.equal(explainEvent({ ev: 'machine.presence' }), 'the Mac tells the phone: machine.presence');
});
