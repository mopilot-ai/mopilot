import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { defaultShell, defaultShellName, modKey, revealLabel, shellScript, shortcutLabel, terminalTitle } from '../src/lib/platform.ts';

test('primary shortcut modifier follows the platform', () => {
  for (const metaKey of [false, true])
    for (const ctrlKey of [false, true]) {
      assert.equal(modKey({ metaKey, ctrlKey }, true), metaKey);
      assert.equal(modKey({ metaKey, ctrlKey }, false), ctrlKey);
    }
  assert.equal(modKey({ metaKey: true, ctrlKey: false }), true);
});

test('shortcut labels translate, deduplicate and order modifiers', () => {
  for (const [input, expected] of [
    ['⇧◆D', 'Shift+Super+D'],
    ['⇧⌘A', 'Ctrl+Shift+A'],
    ['⌥Space', 'Alt+Space'],
    ['⌘⌃⇧⌥ A ', 'Ctrl+Alt+Shift+A'],
    ['⌘', 'Ctrl'],
    ['⌃N', 'Ctrl+N'],
    ['⇧Tab', 'Shift+Tab'],
    ['Enter', 'Enter'],
    ['', ''],
  ]) {
    assert.equal(shortcutLabel(input, false), expected);
    assert.equal(shortcutLabel(input, true), input);
  }
  assert.equal(shortcutLabel('⌘N'), '⌘N');
});

test('shell selection and script invocation preserve the command', () => {
  assert.deepEqual(defaultShell(), ['/bin/zsh', '-l']);
  assert.deepEqual(defaultShell(false), ['/bin/zsh', '-l']);
  assert.deepEqual(defaultShell(true), ['powershell.exe', '-NoLogo']);
  assert.equal(defaultShellName(), 'zsh');
  assert.equal(defaultShellName(true), 'powershell');
  const script = 'echo "hello world"';
  assert.deepEqual(shellScript(script), ['/bin/zsh', '-lc', script]);
  assert.deepEqual(shellScript(script, true), ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', script]);
});

test('terminal titles handle POSIX, drive and UNC paths and empty folders', () => {
  for (const [cwd, expected] of [
    ['/home/user/project', 'project'],
    ['C:\\work\\project\\', 'project'],
    ['C:/work/project/', 'project'],
    ['\\\\server\\share\\project\\', 'project'],
    ['C:', 'C:'],
  ])
    assert.equal(terminalTitle(cwd), expected);
  assert.equal(terminalTitle(''), 'zsh');
  assert.equal(terminalTitle('/', true), 'powershell');
});

const REGISTER = new URL('./support/register.ts', import.meta.url).href;

test('the renderer reads its native platform and falls back before the bridge is ready', async () => {
  // Platform constants are evaluated at import time. Isolate each installed bridge in a Node process.
  for (const [native, expected] of [
    [undefined, 'darwin'],
    [{}, 'darwin'],
    [{ platform: 'win32' }, 'win32'],
    [{ platform: 'linux' }, 'linux'],
  ] as const) {
    const source = `const { installNative } = await import(${JSON.stringify(new URL('../src/lib/native.ts', import.meta.url).href)});
      installNative(${JSON.stringify(native ?? null)});
      const loaded = await import(${JSON.stringify(new URL('../src/lib/platform.ts', import.meta.url).href)});
      console.log(JSON.stringify([loaded.platform, loaded.isMac, loaded.isWin,
        loaded.modKey({ ctrlKey: true, metaKey: false }), loaded.defaultShellName(), loaded.defaultShell(), loaded.shellScript('echo ok')]));`;
    const result = JSON.parse(
      // the tests' loader, which resolves the app's extensionless imports (platform.ts imports ./native)
      execFileSync(
        process.execPath,
        ['--import', REGISTER, '--input-type=module', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '-e', source],
        {
          encoding: 'utf8',
        },
      ),
    );
    assert.deepEqual(result, [
      expected,
      expected === 'darwin',
      expected === 'win32',
      expected !== 'darwin',
      expected === 'win32' ? 'powershell' : expected === 'linux' ? 'sh' : 'zsh',
      expected === 'win32' ? ['powershell.exe', '-NoLogo'] : [expected === 'linux' ? '/bin/sh' : '/bin/zsh', '-l'],
      expected === 'win32'
        ? ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', 'echo ok']
        : [expected === 'linux' ? '/bin/sh' : '/bin/zsh', '-lc', 'echo ok'],
    ]);
  }
});

test('showing a file is named for the file manager it opens in', () => {
  assert.equal(revealLabel('darwin'), 'Show in Finder');
  assert.equal(revealLabel('win32'), 'Show in Explorer');
  assert.equal(revealLabel('linux'), 'Show in folder');
  assert.equal(revealLabel(), 'Show in Finder', 'the renderer outside Electron reads as macOS');
});
