// A pty no interactive terminal view answers for answers ConPTY's device-attributes question on Windows itself, which a view answers for the
// ptys it shows: unanswered, ConPTY held every `!cmd`, setup script and agent terminal command about 3 s (electron/platform/pty.cjs).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// the renderer's PtySpawnOptions declares `selfAnswer` (src/lib/native/contracts/platform.ts)
import type { PtySpawnOptions } from '../src/lib/native/contracts/platform.ts';
import '../src/lib/native/contracts/platform.ts';

const procs: any[] = [];
const fakePty = {
  spawn(file: string, args: string[], opts: object) {
    const p: any = {
      pid: 1,
      file,
      args,
      opts,
      written: [] as string[],
      write: (d: string) => p.written.push(d),
      kill: () => p.exit?.({ exitCode: 0 }),
      onData: (f: any) => (p.data = f),
      onExit: (f: any) => (p.exit = f),
    };
    procs.push(p);
    return p;
  },
};
mock.module('node-pty', { defaultExport: fakePty, namedExports: fakePty });
const require = createRequire(import.meta.url);
const pty = require('../electron/platform/pty.cjs');

/** Runs `fn` as if on `platform` (spawn reads process.platform), putting the real one back after. */
function on<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

const QUESTION = '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h';

const oneShot: PtySpawnOptions = { command: ['powershell.exe', '-Command', 'echo x'], selfAnswer: true };

test("on Windows a self-answering pty answers ConPTY's device-attributes question once it is asked, as xterm.js does, and only that one", () => {
  const heard: string[] = [];
  on('win32', () => pty.spawn('h1', oneShot, { onData: (d: string) => heard.push(d) }));
  const p = procs.at(-1);
  p.data('starting');
  assert.deepEqual(p.written, [], 'nothing before the question');
  p.data(QUESTION);
  assert.deepEqual(p.written, [pty.DEVICE_ATTRIBUTES_REPLY]);
  assert.equal(pty.DEVICE_ATTRIBUTES_REPLY, '\x1b[?1;2c');
  // the output still reaches its reader, question and all
  assert.deepEqual(heard, ['starting', QUESTION]);
  pty.kill('h1');
});

test("a later ESC[c in a self-answering pty's output is the program's, and gets no answer that would arrive as typed input", () => {
  const heard: string[] = [];
  on('win32', () => pty.spawn('h4', oneShot, { onData: (d: string) => heard.push(d) }));
  const p = procs.at(-1);
  p.data(QUESTION);
  p.data('output\x1b[c');
  p.data('\x1b[0c');
  p.data(QUESTION);
  assert.deepEqual(p.written, [pty.DEVICE_ATTRIBUTES_REPLY], 'only the start-up question is answered');
  assert.deepEqual(heard, [QUESTION, 'output\x1b[c', '\x1b[0c', QUESTION]);
  pty.kill('h4');
});

test('a pty an interactive view answers for, and any pty off Windows, leaves the question to the view or the program', () => {
  for (const [platform, selfAnswer] of [
    ['win32', false],
    ['darwin', true],
    ['linux', true],
  ] as const) {
    on(platform, () => pty.spawn('h2', { command: ['sh', '-c', 'true'], selfAnswer }));
    const p = procs.at(-1);
    p.data(QUESTION);
    assert.deepEqual(p.written, [], `${platform}, selfAnswer ${selfAnswer}`);
    pty.kill('h2');
  }
});

test('a replaced pty answers nothing more', () => {
  on('win32', () => pty.spawn('h3', { command: ['cmd'], selfAnswer: true }));
  const old = procs.at(-1);
  on('win32', () => pty.spawn('h3', { command: ['cmd'], selfAnswer: true }));
  old.data(QUESTION);
  assert.deepEqual(old.written, []);
  pty.kill('h3');
});
