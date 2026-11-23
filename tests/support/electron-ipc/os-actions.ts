// Electron IPC os-actions unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { calls, ready } from './fixture';

export function registerOsActionsCases() {
  test('context menu: items, checkboxes, submenus; resolves with the chosen id', async () => {
    const h = await ready();
    const p = h.invoke('menu:popup', [
      { id: 'a', label: 'A' },
      { type: 'separator' },
      { id: 'b', label: 'B', enabled: false, checked: false, accelerator: 'X' },
      { id: 'sub', label: 'More', submenu: [{ id: 'c', label: 'C', checked: true }] },
    ]);
    const menu = h.electron.Menu.buildFromTemplate.mock.calls.at(-1).result;
    const t = menu.template;
    assert.deepEqual(
      t.map((i: any) => [i.type, i.label, i.enabled, i.checked]),
      [
        ['normal', 'A', true, false],
        ['separator', undefined, undefined, undefined],
        ['checkbox', 'B', false, false],
        ['normal', 'More', true, false],
      ],
    );
    assert.equal(t[3].click, undefined);
    assert.equal(t[3].submenu[0].type, 'checkbox');
    t[3].submenu[0].click();
    const [opts] = calls(menu.popup)[0];
    assert.equal(opts.window, h.windows[0]);
    opts.callback();
    mock.timers.tick(0);
    assert.equal(await p, 'c');
    const q = h.invoke('menu:popup', [{ id: 'a', label: 'A' }]);
    calls(h.electron.Menu.buildFromTemplate.mock.calls.at(-1).result.popup)[0][0].callback();
    mock.timers.tick(0);
    assert.equal(await q, null, 'dismissed');
  });

  test('dialogs: folders, files and saving text', async () => {
    const h = await ready();
    const d = h.electron.dialog;
    assert.equal(await h.invoke('dialog:openFolder'), null);
    d.showOpenDialog.mock.mockImplementation(async () => ({ canceled: false, filePaths: ['/a', '/b'] }));
    assert.equal(await h.invoke('dialog:openFolder'), '/a');
    assert.equal(calls(d.showOpenDialog)[1][0], h.windows[0]);
    assert.deepEqual(await h.invoke('dialog:openFiles', { images: true, defaultPath: '/d' }), ['/a', '/b']);
    assert.deepEqual(calls(d.showOpenDialog)[2][1], {
      properties: ['openFile', 'multiSelections'],
      defaultPath: '/d',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    await h.handlers.get('dialog:openFiles')!(h.event());
    assert.equal(calls(d.showOpenDialog)[3][1].filters, undefined);
    d.showOpenDialog.mock.mockImplementation(async () => ({ canceled: true }));
    assert.deepEqual(await h.invoke('dialog:openFiles', {}), []);
    assert.equal(await h.invoke('dialog:saveText', 'n.txt', 'x'), null);
    d.showSaveDialog.mock.mockImplementation(async () => ({ canceled: false }));
    assert.equal(await h.invoke('dialog:saveText', 'n.txt', 'x'), null, 'no path');
    const f = path.join(h.tmp, 'out.txt');
    d.showSaveDialog.mock.mockImplementation(async () => ({ canceled: false, filePath: f }));
    assert.equal(await h.invoke('dialog:saveText', 'n.txt', 'hello'), f);
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
  });

  test('shell, clipboard and "open in" on macOS', async () => {
    const h = await ready({ platform: 'darwin' });
    const sh = h.electron.shell;
    await h.invoke('shell:openExternal', 'https://x');
    await h.invoke('shell:openPath', '/p');
    await h.invoke('shell:reveal', '/p');
    await h.invoke('clipboard:write', 't');
    assert.deepEqual(
      [calls(sh.openExternal), calls(sh.openPath), calls(sh.showItemInFolder), calls(h.electron.clipboard.writeText)],
      [[['https://x']], [['/p']], [['/p']], [['t']]],
    );
    await h.invoke('shell:openIn', 'finder', '/dir');
    assert.deepEqual(calls(sh.openPath).at(-1), ['/dir']);
    h.cp.exec = () => ({ stdout: 'ok' });
    assert.deepEqual(await h.invoke('shell:openIn', 'vscode', '/dir'), { ok: true, code: 0, stdout: 'ok', stderr: '' });
    await h.invoke('shell:openIn', 'Sublime Text', '/dir');
    assert.deepEqual(
      h.cp.execCalls.map((c: any) => [c.cmd, c.args]),
      [
        ['open', ['-a', 'Visual Studio Code', '/dir']],
        ['open', ['-a', 'Sublime Text', '/dir']],
      ],
    );
    assert.equal(h.cp.execCalls[0].opts.windowsHide, true);
  });

  test('"open in" on Windows: Windows Terminal or PowerShell, editors from their install folders', async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'local-'));
    const pf = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
    const exe = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, ''), p);
    const code = exe(path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    const cursor = exe(path.join(pf, 'Cursor', 'Cursor.exe'));
    const h = await ready({ platform: 'win32', env: { LOCALAPPDATA: local, ProgramFiles: pf, SystemRoot: path.join(pf, 'Windows') } });
    const dir = path.join(h.tmp, 'proj');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, '');
    assert.deepEqual(await h.invoke('shell:openIn', 'terminal', file), { ok: true, code: 0, stdout: '', stderr: '' });
    assert.deepEqual(calls(h.cp.spawn)[0].slice(0, 2), ['powershell.exe', ['-NoExit']]);
    assert.equal(calls(h.cp.spawn)[0][2].cwd, dir, "a file's folder");
    await h.invoke('shell:openIn', 'vscode', dir);
    assert.deepEqual(calls(h.cp.spawn)[1].slice(0, 2), [code, [dir]]);
    await h.invoke('shell:openIn', 'cursor', file);
    assert.deepEqual(calls(h.cp.spawn)[2].slice(0, 2), [cursor, [file]]);
    // not installed: the default app
    assert.deepEqual(await h.invoke('shell:openIn', 'zed', file), { ok: true, code: 0, stdout: '', stderr: '' });
    h.electron.shell.openPath.mock.mockImplementation(async () => 'no app');
    assert.deepEqual(await h.invoke('shell:openIn', 'xcode', file), { ok: false, code: 1, stdout: '', stderr: 'no app' });
    // a spawn that fails, or throws
    h.cp.spawn.mock.mockImplementation(() => {
      const c: any = new EventEmitter();
      queueMicrotask(() => c.emit('error', new Error('ENOENT')));
      return c;
    });
    assert.deepEqual(await h.invoke('shell:openIn', 'vscode', dir), { ok: false, code: 1, stdout: '', stderr: 'ENOENT' });
    h.cp.spawn.mock.mockImplementation(() => {
      throw new Error('EPERM');
    });
    assert.deepEqual(await h.invoke('shell:openIn', 'vscode', dir), { ok: false, code: 1, stdout: '', stderr: 'EPERM' });
    // Windows Terminal, when installed
    exe(path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe'));
    h.cp.spawn.mock.mockImplementation(() => {
      const c: any = new EventEmitter();
      c.unref = () => {};
      queueMicrotask(() => c.emit('spawn'));
      return c;
    });
    await h.invoke('shell:openIn', 'iterm', dir);
    assert.deepEqual(calls(h.cp.spawn).at(-1).slice(0, 2), [path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe'), ['-d', dir]]);
    // app icons and what is installed
    const installed = await h.invoke('app:installed');
    assert.deepEqual(installed, { finder: false, vscode: true, cursor: true, zed: false, terminal: true });
    assert.equal(await h.invoke('app:icon', 'vscode'), `icon:${code}`);
  });

  test('"open in" on Windows with the default folders', async () => {
    const h = await ready({ platform: 'win32', env: { LOCALAPPDATA: undefined, ProgramFiles: undefined, SystemRoot: undefined } });
    const lstat = mock.method(fs, 'lstatSync', (p: string) => {
      if (String(p).endsWith('wt.exe')) return {} as any;
      throw new Error('ENOENT');
    });
    try {
      const installed = await h.invoke('app:installed');
      assert.deepEqual(
        installed,
        { finder: false, vscode: false, cursor: false, zed: false, terminal: true },
        'an app alias stat cannot follow still counts',
      );
    } finally {
      lstat.mock.restore();
    }
    await h.invoke('shell:openIn', 'finder', '/x');
    assert.deepEqual(calls(h.electron.shell.openPath).at(-1), ['/x']);
  });

  test('app icons and installed apps on macOS', async () => {
    const h = await ready({ platform: 'darwin' });
    assert.equal(await h.invoke('app:icon', 'nope'), null);
    assert.equal(await h.invoke('app:icon', 'vscode'), null, 'not installed');
    h.exists.add('/Applications/Visual Studio Code.app');
    assert.equal(await h.invoke('app:icon', 'vscode'), 'icon:/Applications/Visual Studio Code.app');
    h.app.getFileIcon.mock.mockImplementation(async () => {
      throw new Error('x');
    });
    assert.equal(await h.invoke('app:icon', 'vscode'), null);
    const installed = await h.invoke('app:installed');
    assert.equal(installed.vscode, true);
    assert.equal(installed.xcode, false);
  });
}
