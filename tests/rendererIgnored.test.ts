// src/lib/ignored.ts: a renderer's ignored errors reach main's ring (electron/ignored.cjs) for Copy diagnostics.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNative } from '../src/lib/native.ts';

const require = createRequire(import.meta.url);
const { noteIgnored, ignoring, describeError, errorText } = await import('../src/lib/ignored.ts');
const { decodeOrRaw } = await import('../src/lib/paths.ts');
const main = require('../electron/ignored.cjs');
const { register } = require('../electron/app/ipc/app.cjs');

const g = globalThis as any;
beforeEach(() => {
  delete g.window;
  main.clearIgnored();
});

function debugLines(run: () => void): string[] {
  const lines: string[] = [];
  const debug = mock.method(console, 'debug', (...a: unknown[]) => void lines.push(a.join(' ')));
  try {
    run();
  } finally {
    debug.mock.restore();
  }
  return lines;
}

test('errorText drops the wrapper Electron puts around an error main threw, and keeps any other text', () => {
  assert.equal(errorText(new Error("Error invoking remote method 'git:worktreeList': Error: no git")), 'no git');
  assert.equal(errorText(new Error("Error invoking remote method 'fs:read': EACCES: denied")), 'EACCES: denied');
  assert.equal(errorText(new TypeError('bad')), 'TypeError: bad');
  assert.equal(errorText('plain'), 'plain');
});

test("errorText reads a thrown object's message, and falls back to the value when there is none or it can't be read", () => {
  assert.equal(errorText({ code: -32600, message: 'thread not found' }), 'thread not found');
  assert.equal(errorText({ message: "Error invoking remote method 'x': Error: gone" }), 'gone');
  assert.equal(errorText({ message: 42 }), '[object Object]');
  assert.equal(errorText(null), 'null');
  const hostile = {
    get message(): string {
      throw new Error('no');
    },
  };
  assert.equal(errorText(hostile), '[object Object]');
});

test('describeError names a typed error, keeps a plain one, and never throws', () => {
  assert.equal(describeError(new TypeError('bad')), 'TypeError: bad');
  assert.equal(describeError(new Error('plain')), 'plain');
  const unnamed = new Error('no name');
  unnamed.name = '';
  assert.equal(describeError(unnamed), 'no name');
  assert.equal(describeError('text'), 'text');
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(
    describeError({
      toString() {
        throw new Error('hostile');
      },
    }),
    'unprintable error',
  );
});

test('without a bridge (tests, the web build) it is a console.debug line', () => {
  assert.deepEqual(
    debugLines(() => noteIgnored('close a tab', new Error('gone'))),
    ['[ignored] close a tab: gone'],
  );
  installNative(null);
  assert.deepEqual(
    debugLines(() => noteIgnored('close a tab', 'x')),
    ['[ignored] close a tab: x'],
  );
  installNative({ app: { ignored: 'not a function' } } as any);
  assert.equal(debugLines(() => noteIgnored('c', 'x')).length, 1);
});

test('with the bridge it goes to main, once, and nothing is logged here', () => {
  const sent: unknown[][] = [];
  installNative({ app: { ignored: (...a: unknown[]) => void sent.push(a) } } as any);
  assert.deepEqual(
    debugLines(() => noteIgnored('read the caps', new RangeError('late'))),
    [],
  );
  assert.deepEqual(sent, [['read the caps', 'RangeError: late']]);
});

test('an expected code is not recorded; any other one is', () => {
  const sent: unknown[][] = [];
  installNative({ app: { ignored: (...a: unknown[]) => void sent.push(a) } } as any);
  noteIgnored('read a file', Object.assign(new Error('missing'), { code: 'ENOENT' }), ['ENOENT']);
  noteIgnored('read a file', Object.assign(new Error('denied'), { code: 'EACCES' }), ['ENOENT']);
  noteIgnored('read a file', Object.assign(new Error('odd'), { code: 7 }), ['ENOENT']);
  noteIgnored('read a file', null, ['ENOENT']);
  const hostile = new Error('hostile code');
  Object.defineProperty(hostile, 'code', {
    get() {
      throw new Error('no code');
    },
  });
  noteIgnored('read a file', hostile, ['ENOENT']);
  assert.deepEqual(
    sent.map((a) => a[1]),
    ['denied', 'odd', 'null', 'hostile code'],
  );
});

test('ignoring is noteIgnored as a rejection handler, expected codes included', async () => {
  const sent: unknown[][] = [];
  installNative({ app: { ignored: (...a: unknown[]) => void sent.push(a) } } as any);
  await Promise.reject(new Error('offline')).catch(ignoring('refresh the usage'));
  await Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })).catch(ignoring('read a file', ['ENOENT']));
  assert.deepEqual(sent, [['refresh the usage', 'offline']]);
});

test('a bridge that throws falls back to console.debug and never loops', () => {
  let calls = 0;
  installNative({
    app: {
      ignored: () => {
        calls++;
        throw new Error('IPC closed');
      },
    },
  } as any);
  assert.deepEqual(
    debugLines(() => noteIgnored('stop the voice session', new Error('gone'))),
    ['[ignored] report an ignored error to main: IPC closed', '[ignored] stop the voice session: gone'],
  );
  assert.equal(calls, 1);
});

test("main keeps a window's ignored error with its own, prefixed renderer:", () => {
  const on = new Map<string, Function>();
  register(
    { on: (ch: string, h: Function) => on.set(ch, h), handle: () => {} },
    { app: { on: () => {}, isPackaged: false }, live: {}, handle: () => {} },
  );
  const handler = on.get('app:ignored')!;
  const debug = mock.method(console, 'debug', () => {});
  try {
    handler({}, 'close a tab', 'gone');
    handler({}, { not: 'text' }, 42);
  } finally {
    debug.mock.restore();
  }
  assert.deepEqual(
    main.recentIgnored().map((e: any) => [e.context, e.message, e.count]),
    [
      ['renderer: close a tab', 'gone', 1],
      ['renderer: unknown', 'unknown', 1],
    ],
  );
});

test('decodeOrRaw decodes, keeps a malformed escape as written, and rethrows anything else', () => {
  assert.equal(decodeOrRaw('/a%20b'), '/a b');
  assert.equal(decodeOrRaw('/100%'), '/100%');
  assert.equal(decodeOrRaw('/a%20b%2F', decodeURI), '/a b%2F');
  assert.throws(
    () =>
      decodeOrRaw('x', () => {
        throw new TypeError('broken decoder');
      }),
    /broken decoder/,
  );
});
