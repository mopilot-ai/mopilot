// electron/platform/pty.cjs with a fake node-pty: loading node-pty per platform, the platform:pty:*
// IPC (per-window ids, coalesced output, exit reporting, cleanup) and write/resize/kill.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { tick } from './support/async-scenarios.ts';

type Proc = {
  pid: number;
  file: string;
  args: string[];
  opts: any;
  written: string[];
  sizes: number[][];
  killed: number;
  data: (d: string) => void;
  exit: (e: any) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
  onData: (f: (d: string) => void) => void;
  onExit: (f: (e: any) => void) => void;
};
const procs: Proc[] = [];
let resizeThrows = false;
let killThrows = false;
const fakePty = {
  spawn(file: string, args: string[], opts: any) {
    const p: Proc = {
      pid: 100 + procs.length,
      file,
      args,
      opts,
      written: [],
      sizes: [],
      killed: 0,
      data: () => {},
      exit: () => {},
      write: (d) => p.written.push(d),
      resize: (c, r) => {
        if (resizeThrows) throw new Error('closed');
        p.sizes.push([c, r]);
      },
      kill: () => {
        p.killed++;
        if (killThrows) throw new Error('gone');
      },
      onData: (f) => {
        p.data = f;
      },
      onExit: (f) => {
        p.exit = f;
      },
    };
    procs.push(p);
    return p;
  },
};
mock.module('node-pty', { defaultExport: fakePty, namedExports: fakePty });

const require = createRequire(import.meta.url);
const pty = require('../electron/platform/pty.cjs');

const last = () => procs[procs.length - 1];

test('loginShell: Windows is PowerShell; else passwd shell, then $SHELL, then zsh', (t) => {
  assert.equal(pty.loginShell({}, 'win32'), 'powershell.exe');
  const ui = t.mock.method(os, 'userInfo', () => ({ shell: '/bin/fish' }));
  assert.equal(pty.loginShell({ SHELL: '/bin/bash' }, 'darwin'), '/bin/fish');
  ui.mock.mockImplementation(() => ({ shell: null }) as any);
  assert.equal(pty.loginShell({ SHELL: '/bin/bash' }, 'darwin'), '/bin/bash');
  ui.mock.mockImplementation(() => {
    throw new Error('no passwd');
  });
  assert.equal(pty.loginShell({}, 'darwin'), '/bin/zsh');
});

test('spawnSpec defaults: a nonexistent cwd is home; no PATH still gets the GUI-safe one; Windows keeps PATH', () => {
  const s = pty.spawnSpec({ cwd: '/definitely/not/here/xyz' }, { env: {}, home: '/h', shell: '/bin/sh' });
  assert.equal(s.cwd, '/h');
  assert.equal(s.env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  const w = pty.spawnSpec({}, { env: { Path: 'C:\\x' }, home: 'C:\\h', platform: 'win32' });
  assert.equal(w.file, 'powershell.exe');
  assert.deepEqual(w.args, ['-NoLogo']);
  assert.equal(w.env.PATH, undefined);
  assert.equal(w.env.SHELL, undefined);
  assert.equal(pty.spawnSpec({ cwd: os.tmpdir() }, { env: {}, shell: '/bin/sh' }).cwd, os.tmpdir());
});

test('openPty on Windows loads the unpacked directory when it exists, else node-pty', () => {
  const loaded: string[] = [];
  const load = (p: string) => (loaded.push(p), { p });
  assert.deepEqual(pty.openPty({ platform: 'win32', dir: 'D:\\pty', load, fsm: { existsSync: () => true } }), { p: 'D:\\pty' });
  assert.deepEqual(pty.openPty({ platform: 'win32', dir: 'D:\\pty', load, fsm: { existsSync: () => false } }), { p: 'node-pty' });
});

test('openPty elsewhere makes spawn-helper executable only when it is not', () => {
  const chmods: [string, number][] = [];
  const base = { constants: { X_OK: 1 }, chmodSync: (p: string, m: number) => chmods.push([p, m]) };
  const load = () => 'mod';
  assert.equal(pty.openPty({ platform: 'darwin', arch: 'arm64', dir: '/p', load, fsm: { ...base, accessSync: () => {} } }), 'mod');
  assert.deepEqual(chmods, []);
  pty.openPty({
    platform: 'darwin',
    arch: 'arm64',
    dir: '/p',
    load,
    fsm: {
      ...base,
      accessSync: () => {
        throw new Error('EACCES');
      },
    },
  });
  assert.deepEqual(chmods, [['/p/prebuilds/darwin-arm64/spawn-helper', 0o755]]);
  // a read-only install: chmod failing is ignored
  const failing = {
    ...base,
    accessSync: () => {
      throw new Error('EACCES');
    },
    chmodSync: () => {
      throw new Error('EROFS');
    },
  };
  assert.equal(pty.openPty({ platform: 'linux', arch: 'x64', dir: '/p', load, fsm: failing }), 'mod');
});

test('write, resize and kill reach the pty; bad sizes and unknown ids are ignored; errors swallowed', () => {
  pty.spawn('w1', { command: ['/bin/cat'] });
  const p = last();
  assert.equal(p.file, '/bin/cat');
  assert.equal(p.opts.useConptyDll, undefined);
  pty.write('w1', 42);
  pty.write('nope', 'x');
  assert.deepEqual(p.written, ['42']);
  pty.resize('w1', 100.7, 40.2);
  pty.resize('w1', 0, 40);
  pty.resize('nope', 10, 10);
  assert.deepEqual(p.sizes, [[100, 40]]);
  resizeThrows = true;
  pty.resize('w1', 10, 10);
  resizeThrows = false;
  killThrows = true;
  assert.equal(pty.kill('w1'), true);
  killThrows = false;
  assert.equal(pty.kill('w1'), false);
  assert.equal(pty.has('w1'), false);
});

test('killAll kills every pty', () => {
  pty.spawn('a1', { command: ['x'] });
  const a = last();
  pty.spawn('a2', { command: ['y'] });
  const b = last();
  pty.killAll();
  assert.equal(a.killed + b.killed, 2);
  assert.equal(pty.has('a1') || pty.has('a2'), false);
});

test('spawn on Windows asks for the bundled conpty dll', (t) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', orig));
  pty.spawn('win', { command: ['cmd.exe'] });
  assert.equal(last().opts.useConptyDll, true);
  pty.kill('win');
});

function fakeIpc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return {
    handlers,
    handle: (ch: string, f: any) => handlers.set(ch, f),
    on: (ch: string, f: any) => handlers.set(ch, f),
  };
}
function fakeSender(id: number) {
  const s = Object.assign(new EventEmitter(), {
    id,
    destroyed: false,
    sent: [] as any[],
    isDestroyed: () => s.destroyed,
    send: (ch: string, m: any) => s.sent.push([ch, m]),
  });
  return s;
}

test('IPC: buffered output is discarded when a terminal is killed, replaced or navigated away', async () => {
  const ipc = fakeIpc();
  pty.register(ipc);
  const sender = fakeSender(20);
  const spawn = ipc.handlers.get('platform:pty:spawn')!;
  for (const action of ['kill', 'replace', 'navigate']) {
    spawn({ sender }, 'term', {});
    const old = last();
    old.data('stale');
    if (action === 'kill') ipc.handlers.get('platform:pty:kill')!({ sender }, 'term');
    else if (action === 'replace') {
      spawn({ sender }, 'term', {});
      last().data('fresh');
    } else sender.emit('did-navigate');
    await tick();
    assert.deepEqual(sender.sent, action === 'replace' ? [['platform:pty:event', { id: 'term', type: 'data', data: 'fresh' }]] : []);
    sender.sent.length = 0;
    old.exit({ exitCode: 0, signal: 15 });
  }
  pty.killAll();
});

test('IPC: ids are scoped per window, output is coalesced per tick, exit is reported after a flush', async () => {
  const ipc = fakeIpc();
  pty.register(ipc);
  const s1 = fakeSender(1);
  const res = ipc.handlers.get('platform:pty:spawn')!({ sender: s1 }, 'term', { command: ['/bin/sh'] });
  assert.equal(res.file, '/bin/sh');
  assert.equal(typeof res.pid, 'number');
  const p = last();
  assert.equal(pty.has('wc1:term'), true);
  p.data('a');
  p.data('b');
  await tick();
  assert.deepEqual(s1.sent, [['platform:pty:event', { id: 'term', type: 'data', data: 'ab' }]]);
  ipc.handlers.get('platform:pty:write')!({ sender: s1 }, 'term', 'ls\n');
  ipc.handlers.get('platform:pty:resize')!({ sender: s1 }, 'term', 90, 30);
  assert.deepEqual(p.written, ['ls\n']);
  assert.deepEqual(p.sizes, [[90, 30]]);
  p.data('tail');
  p.exit({ exitCode: 1, signal: 0 });
  assert.deepEqual(s1.sent.slice(1), [
    ['platform:pty:event', { id: 'term', type: 'data', data: 'tail' }],
    ['platform:pty:event', { id: 'term', type: 'exit', exitCode: 1, signal: null }],
  ]);
  assert.equal(pty.has('wc1:term'), false);
  await tick(); // the scheduled flush finds nothing left
  assert.equal(s1.sent.length, 3);
});

test('IPC: a killed or replaced pty sends no exit; output after kill is dropped; destroyed senders get nothing', async () => {
  const ipc = fakeIpc();
  pty.register(ipc);
  const s = fakeSender(2);
  ipc.handlers.get('platform:pty:spawn')!({ sender: s }, 'k', {});
  const p = last();
  assert.equal(await ipc.handlers.get('platform:pty:kill')!({ sender: s }, 'k'), true);
  p.data('late');
  p.exit({ exitCode: 0, signal: 15 });
  await tick();
  assert.deepEqual(s.sent, []);

  ipc.handlers.get('platform:pty:spawn')!({ sender: s }, 'd', {});
  const q = last();
  s.destroyed = true;
  q.exit({ exitCode: 0 });
  assert.deepEqual(s.sent, []);
});

test('IPC: navigating or destroying a window kills its ptys only, and it is watched once', () => {
  const ipc = fakeIpc();
  pty.register(ipc);
  const s3 = fakeSender(3);
  const s4 = fakeSender(4);
  const spawn = ipc.handlers.get('platform:pty:spawn')!;
  spawn({ sender: s3 }, 'x', {});
  spawn({ sender: s3 }, 'y', {});
  spawn({ sender: s4 }, 'x', {});
  assert.equal(s3.listenerCount('did-navigate'), 1);
  s3.emit('did-navigate');
  assert.equal(pty.has('wc3:x') || pty.has('wc3:y'), false);
  assert.equal(pty.has('wc4:x'), true);
  spawn({ sender: s3 }, 'z', {});
  s3.emit('destroyed');
  assert.equal(pty.has('wc3:z'), false);
  // watched again after it was destroyed
  spawn({ sender: s3 }, 'again', {});
  assert.equal(s3.listenerCount('did-navigate'), 2);
  pty.killAll();
});

test('info: recent output is kept (bounded), the user’s typing is told from the view’s own replies, running is the foreground', async () => {
  const ipc = fakeIpc();
  pty.register(ipc);
  const s = fakeSender(31);
  assert.equal(pty.info('wc31:t'), null);
  ipc.handlers.get('platform:pty:spawn')!({ sender: s }, 't', { command: ['/bin/sh'] });
  const p = last();
  assert.deepEqual(pty.info('wc31:t'), { tail: '', outputAt: pty.info('wc31:t').outputAt, typed: false, running: false });
  p.data('hello');
  assert.equal(pty.info('wc31:t').tail, 'hello');
  p.data('x'.repeat(70000));
  assert.equal(pty.info('wc31:t').tail.length, 65536, 'only the newest 64 KiB');
  // answers to the shell's queries are not typing; keys and a bracketed paste are
  for (const data of ['\x1b[1;1R', '\x1b[I', '\x1b[?1;2c', '\x1b]11;rgb:0/0/0\x07'])
    ipc.handlers.get('platform:pty:write')!({ sender: s }, 't', data);
  assert.equal(pty.info('wc31:t').typed, false);
  for (const data of ['\x1b[A', '\x1b[200~paste\x1b[201~']) {
    ipc.handlers.get('platform:pty:write')!({ sender: s }, 't', data);
    assert.equal(pty.info('wc31:t').typed, true, JSON.stringify(data));
    ipc.handlers.get('platform:pty:spawn')!({ sender: s }, 't', { command: ['/bin/sh'] });
  }
  ipc.handlers.get('platform:pty:spawn')!({ sender: s }, 't', { command: ['/bin/sh'] });
  assert.equal(pty.info('wc31:t').typed, false, 'a new shell under the same id starts clean');
  ipc.handlers.get('platform:pty:write')!({ sender: s }, 't', 'ls\r');
  assert.equal(pty.info('wc31:t').typed, true);
  // a write to a pty nobody started changes nothing
  ipc.handlers.get('platform:pty:write')!({ sender: s }, 'other', 'ls\r');
  (last() as any).process = '/bin/sleep';
  assert.equal(pty.info('wc31:t').running, true);
  pty.killAll();
});
