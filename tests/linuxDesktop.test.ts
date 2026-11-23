// Linux Open in discovery uses executable paths, preserves literal file names and reports launch failures without waiting for a terminal to close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { createLinuxDesktop } = createRequire(import.meta.url)('../electron/app/linuxDesktop.cjs');
const { createEditorLauncher } = createRequire(import.meta.url)('../electron/platform/editorLauncher.cjs');

function fixture(programs: string[], options: { failure?: string; isDirectory?: boolean } = {}) {
  const calls: any[] = [];
  const which = (name: string) => (programs.includes(name) ? `/usr/bin/${name}` : null);
  const exists = (name: string) => programs.some((p) => name === `/usr/bin/${p}`);
  const run = async (...args: any[]) => (calls.push(args), { ok: true, stderr: '' });
  const spawn = (file: string, args: string[], opts: any) => {
    calls.push([file, args, opts]);
    if (options.failure === 'throw') throw new Error('spawn threw');
    const child = Object.assign(new EventEmitter(), { unref: () => calls.push(['unref']) });
    queueMicrotask(() => (options.failure ? child.emit('error', new Error('cannot launch')) : child.emit('spawn')));
    return child;
  };
  return {
    calls,
    which,
    exists,
    run,
    desktop: createLinuxDesktop({ which, exists, run, spawn, isDirectory: () => options.isDirectory ?? true }),
  };
}

test('Linux discovers code editors on PATH and opens literal file positions through their CLI', async () => {
  const f = fixture(['code', 'cursor', 'windsurf', 'zed']);
  const editor = createEditorLauncher({ platform: 'linux', which: f.which, exists: f.exists, run: f.run });
  assert.deepEqual(editor.installed(), ['vscode', 'cursor', 'windsurf', 'zed']);
  await editor.open('vscode', '/a b/$(literal).ts', 3, 4);
  await editor.open('zed', '/a b/x.ts', 2);
  assert.deepEqual(f.calls, [
    ['/usr/bin/code', ['--goto', '/a b/$(literal).ts:3:4']],
    ['/usr/bin/zed', ['/a b/x.ts:2']],
  ]);
  assert.equal(editor.program('unknown'), null);
  assert.deepEqual(await editor.open('unknown', '/a'), { ok: false });
  assert.deepEqual(fixture([]).desktop.installed(), {
    finder: true,
    vscode: false,
    cursor: false,
    windsurf: false,
    zed: false,
    terminal: false,
  });
  assert.deepEqual(f.desktop.paths(), {
    vscode: '/usr/bin/code',
    cursor: '/usr/bin/cursor',
    windsurf: '/usr/bin/windsurf',
    zed: '/usr/bin/zed',
    terminal: null,
  });
  assert.deepEqual(await f.desktop.open('cursor', '/a b'), { ok: true });
  assert.equal((await f.desktop.open('xcode', '/a')).ok, false);
  assert.equal((await fixture([]).desktop.open('terminal', '/a')).ok, false);
});

test('Linux terminal choices start detached in the requested folder and return on spawn', async () => {
  for (const name of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    for (const isDirectory of [false, true]) {
      const f = fixture([name], { isDirectory });
      assert.equal(f.desktop.installed().terminal, true);
      assert.deepEqual(await f.desktop.open('terminal', '/space dir/project'), { ok: true });
      const cwd = isDirectory ? '/space dir/project' : '/space dir';
      assert.deepEqual(f.calls, [
        [
          `/usr/bin/${name}`,
          name === 'gnome-terminal' ? ['--working-directory', cwd] : name === 'konsole' ? ['--workdir', cwd] : [],
          { cwd, detached: true, stdio: 'ignore' },
        ],
        ['unref'],
      ]);
    }
  }
  for (const failure of ['throw', 'error']) {
    const f = fixture(['xterm'], { failure });
    const result = await f.desktop.open('terminal', '/a');
    assert.equal(result.ok, false);
    assert.match(result.stderr, /spawn threw|cannot launch/);
    assert.equal(
      f.calls.some((c) => c[0] === 'unref'),
      false,
    );
  }
});
