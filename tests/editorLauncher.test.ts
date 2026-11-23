// Opening a file in a code editor (electron/platform/editorLauncher.cjs): which editors are installed on each OS, a line and
// column through the editor's command line, and `open -a` when only the app is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEditorLauncher, EDITOR_IDS } = require('../electron/platform/editorLauncher.cjs');

const APP = '/Applications/Visual Studio Code.app';
const CODE = `${APP}/Contents/Resources/app/bin/code`;

function setup(
  platform: string,
  present: string[],
  runs: { ok: boolean; stderr: string } = { ok: true, stderr: '' },
  winPaths: Record<string, string> = {},
) {
  const calls: any[] = [];
  const launcher = createEditorLauncher({
    platform,
    exists: (p: string) => present.includes(p),
    run: async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), runs),
    winPaths,
    which: () => null,
  });
  return { launcher, calls };
}

test('the editors are VS Code, Cursor, Windsurf and Zed, named for the user', () => {
  assert.deepEqual(EDITOR_IDS, ['vscode', 'cursor', 'windsurf', 'zed']);
  const { launcher } = setup('darwin', []);
  assert.equal(launcher.label('zed'), 'Zed');
  assert.equal(launcher.label('other'), 'other');
});

test('installed: the apps on macOS, the executables on Windows, none when absent elsewhere', () => {
  assert.deepEqual(setup('darwin', [APP, '/Applications/Zed.app']).launcher.installed(), ['vscode', 'zed']);
  assert.deepEqual(setup('win32', ['C:\\Cursor.exe'], undefined, { cursor: 'C:\\Cursor.exe', zed: 'C:\\Zed.exe' }).launcher.installed(), [
    'cursor',
  ]);
  assert.deepEqual(setup('win32', ['x'], undefined, {}).launcher.installed(), []);
  assert.deepEqual(setup('linux', [APP]).launcher.installed(), []);
});

test('the command line takes the line and column: --goto for the VS Code family, path:line:col for Zed, the bare path without one', async () => {
  const t = setup('darwin', [APP, CODE, '/Applications/Zed.app', '/Applications/Zed.app/Contents/MacOS/cli']);
  assert.deepEqual(await t.launcher.open('vscode', '/p/a.ts', 3, 4), { ok: true });
  assert.deepEqual(await t.launcher.open('vscode', '/p/a.ts', 3), { ok: true });
  assert.deepEqual(await t.launcher.open('vscode', '/p/a.ts'), { ok: true });
  assert.deepEqual(await t.launcher.open('zed', '/p/a.ts', 7, 2), { ok: true });
  assert.deepEqual(t.calls, [
    [CODE, '--goto', '/p/a.ts:3:4'],
    [CODE, '--goto', '/p/a.ts:3'],
    [CODE, '/p/a.ts'],
    ['/Applications/Zed.app/Contents/MacOS/cli', '/p/a.ts:7:2'],
  ]);
});

test('without its command line macOS opens the app with the file; Windows runs the executable; nothing else can', async () => {
  const mac = setup('darwin', [APP]);
  assert.deepEqual(await mac.launcher.open('vscode', '/p/a.ts', 3), { ok: true });
  assert.deepEqual(mac.calls, [['open', '-a', 'Visual Studio Code', '/p/a.ts']]);
  const win = setup('win32', ['C:\\Code.exe'], undefined, { vscode: 'C:\\Code.exe' });
  await win.launcher.open('vscode', 'C:\\p\\a.ts', 2);
  assert.deepEqual(win.calls, [['C:\\Code.exe', '--goto', 'C:\\p\\a.ts:2']]);
  const missing = setup('win32', [], undefined, {});
  assert.deepEqual(await missing.launcher.open('vscode', 'C:\\a.ts'), { ok: false });
  assert.deepEqual((await setup('linux', []).launcher.open('zed', '/a')).ok, false);
});

test('a start that failed is reported as a failure, with what the program said kept for the log', async () => {
  assert.deepEqual(await setup('darwin', [APP], { ok: false, stderr: ' no display \n' }).launcher.open('vscode', '/p/a.ts'), { ok: false });
  assert.deepEqual(await setup('darwin', [APP], { ok: false, stderr: '' }).launcher.open('vscode', '/p/a.ts'), { ok: false });
});
