// Linux desktop IPC delegates executable discovery, file-kind checks and process launch through the shared platform boundaries.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/window.cjs');
const { createEditorLauncher } = require('../electron/platform/editorLauncher.cjs');
const { installProc } = require('../electron/platform/ports/proc.cjs');
const shellEnv = require('../electron/platform/env.cjs');

test('Linux IPC discovers real fixture executables, opens editors, and resolves directory, file and missing terminal targets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-desktop-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const programs: Record<string, string> = { code: path.join(root, 'code'), xterm: path.join(root, 'xterm') };
  for (const file of Object.values(programs)) fs.writeFileSync(file, 'fixture executable', { mode: 0o700 });
  const lookup = mock.method(shellEnv, 'which', (name: string) => programs[name] ?? null);
  t.after(() => lookup.mock.restore());
  const launches: any[] = [];
  const previousProc = installProc({
    ...childProcess,
    spawn: (file: string, args: string[], options: any) => {
      launches.push([file, args, options]);
      const child = Object.assign(new EventEmitter(), { unref: mock.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  t.after(() => installProc(previousProc));
  const handlers = new Map<string, Function>();
  const run = mock.fn(async (_file: string, _args: string[]) => ({ ok: true, stderr: '' }));
  const shellOpen = mock.fn(async () => 'opened');
  const getIcon = mock.fn(async () => ({ toDataURL: () => 'fixture-icon' }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    register(
      { handle: (name: string, handler: Function) => handlers.set(name, handler) },
      {
        isWin: false,
        run,
        shell: { openPath: shellOpen },
        app: { getFileIcon: getIcon },
        nativeTheme: new EventEmitter(),
        windows: [],
      },
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  const invoke = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
  assert.deepEqual(await invoke('app:installed'), {
    finder: true,
    vscode: true,
    cursor: false,
    windsurf: false,
    zed: false,
    terminal: true,
  });
  assert.equal(await invoke('app:icon', 'vscode'), 'fixture-icon');
  assert.deepEqual(getIcon.mock.calls[0].arguments, [programs.code, { size: 'normal' }]);
  assert.equal(await invoke('app:icon', 'unknown'), null);
  assert.equal(await invoke('shell:openIn', 'finder', root), 'opened');
  assert.deepEqual(await invoke('shell:openIn', 'vscode', '/project/a b.ts'), { ok: true });
  assert.deepEqual(run.mock.calls[0].arguments, [programs.code, ['/project/a b.ts']]);
  assert.equal((await invoke('shell:openIn', 'xcode', root)).ok, false);
  const directory = path.join(root, 'project');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'a b.ts');
  fs.writeFileSync(file, 'fixture');
  const missing = path.join(root, 'absent', 'file.ts');
  for (const [target, cwd] of [
    [directory, directory],
    [file, directory],
    [missing, path.dirname(missing)],
  ]) {
    assert.deepEqual(await invoke('shell:openIn', 'terminal', target), { ok: true });
    assert.deepEqual(launches.at(-1), [programs.xterm, [], { cwd, detached: true, stdio: 'ignore' }]);
  }
  const editor = createEditorLauncher({ platform: 'linux', exists: fs.existsSync, run });
  assert.equal(editor.program('vscode'), programs.code, 'the default collaborator uses the shared login-shell lookup');
  assert.deepEqual(await editor.open('vscode', '/project/b.ts', 7), { ok: true });
  assert.deepEqual(run.mock.calls.at(-1)!.arguments, [programs.code, ['--goto', '/project/b.ts:7']]);
});
