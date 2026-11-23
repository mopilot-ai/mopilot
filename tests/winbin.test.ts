// Finding and launching codex / claude on Windows (electron/platform/winbin.cjs), with the platform, env and
// file system faked, so it runs on any OS. Plus the platform helpers the renderer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { modKey, shortcutLabel, defaultShell, shellScript, terminalTitle } from '../src/lib/platform.ts';

const require = createRequire(import.meta.url);
const {
  pathLookup,
  windowsCandidates,
  shimTarget,
  cmdEscapeArg,
  launchSpec,
  resolveShim,
  psQuote,
} = require('../electron/platform/winbin.cjs');
const { loginCommand } = require('../electron/harness/claude/accounts.cjs');

const ENV = {
  Path: 'C:\\Windows\\system32;"C:\\Program Files\\nodejs";;C:\\Users\\bob\\AppData\\Roaming\\npm',
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF',
  USERPROFILE: 'C:\\Users\\bob',
  APPDATA: 'C:\\Users\\bob\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
};
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
const NATIVE_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;

function io(files: Record<string, string | true>, extra: Partial<{ platform: string; env: Record<string, string> }> = {}) {
  const lower = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: 'win32',
    env: ENV,
    execPath: 'C:\\Program Files\\MoPilot\\MoPilot.exe',
    readFile: (p: string) => (typeof lower[p.toLowerCase()] === 'string' ? (lower[p.toLowerCase()] as string) : null),
    exists: (p: string) => p.toLowerCase() in lower,
    ...extra,
  };
}

test('PATH lookup tries each runnable PATHEXT extension, case-insensitive env, quoted dirs', () => {
  const r = pathLookup('codex', ENV);
  assert.deepEqual(r.slice(0, 4), [
    'C:\\Windows\\system32\\codex.com',
    'C:\\Windows\\system32\\codex.exe',
    'C:\\Windows\\system32\\codex.bat',
    'C:\\Windows\\system32\\codex.cmd',
  ]);
  assert.ok(r.includes('C:\\Program Files\\nodejs\\codex.cmd'));
  assert.ok(r.includes('C:\\Users\\bob\\AppData\\Roaming\\npm\\codex.cmd'));
  // Windows Script Host extensions are not node scripts
  assert.ok(!r.some((p: string) => /\.(js|vbs|wsf)$/i.test(p)));
  // a name with an extension is looked up as is
  assert.deepEqual(pathLookup('node.exe', { PATH: 'C:\\a;C:\\b' }), ['C:\\a\\node.exe', 'C:\\b\\node.exe']);
});

test('Windows candidates: install locations first, then PATH, no duplicates', () => {
  const c = windowsCandidates('claude', ENV);
  assert.equal(c[0], 'C:\\Users\\bob\\.local\\bin\\claude.exe');
  assert.ok(c.includes('C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd'));
  assert.ok(c.includes('C:\\Users\\bob\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'));
  assert.ok(c.includes('C:\\Users\\bob\\scoop\\shims\\claude.exe'));
  assert.ok(c.includes('C:\\Users\\bob\\AppData\\Local\\Programs\\claude\\claude.exe'));
  assert.equal(new Set(c.map((p: string) => p.toLowerCase())).size, c.length);
  // the npm folder from APPDATA and from PATH is listed once
  assert.equal(c.filter((p: string) => p.toLowerCase() === 'c:\\users\\bob\\appdata\\roaming\\npm\\claude.cmd').length, 1);
});

test('npm, native and pnpm shims resolve to the program they run', () => {
  const dir = 'C:\\Users\\bob\\AppData\\Roaming\\npm';
  assert.equal(shimTarget(NPM_SHIM, `${dir}\\codex.cmd`), `${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`);
  assert.equal(shimTarget(NATIVE_SHIM, `${dir}\\claude.cmd`), `${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
  const pnpm =
    '@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=x"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)';
  assert.equal(shimTarget(pnpm, 'C:\\pnpm\\bin\\codex.cmd'), 'C:\\pnpm\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(shimTarget('@echo off\r\nsomething.exe %*', 'C:\\x\\a.cmd'), null);
});

test('launchSpec is the identity off Windows', () => {
  const s = launchSpec('/opt/homebrew/bin/codex', ['app-server'], { cwd: '/' }, io({}, { platform: 'darwin' }));
  assert.deepEqual(s, { command: '/opt/homebrew/bin/codex', args: ['app-server'], options: { cwd: '/' } });
});

test('launchSpec runs an .exe directly with a hidden console', () => {
  const s = launchSpec('C:\\bin\\codex.exe', ['app-server'], {}, io({}));
  assert.deepEqual(s, { command: 'C:\\bin\\codex.exe', args: ['app-server'], options: { windowsHide: true } });
});

test('launchSpec runs an npm shim’s .js with node from PATH, without cmd.exe', () => {
  const shim = 'C:\\Users\\bob\\AppData\\Roaming\\npm\\codex.cmd';
  const js = 'C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const args = ['app-server', '-c', 'openai_base_url="http://127.0.0.1:5000/x"'];
  const s = launchSpec(shim, args, { cwd: 'C:\\Users\\bob' }, io({ [shim]: NPM_SHIM, [js]: true, [node]: true }));
  assert.equal(s.command, node);
  assert.deepEqual(s.args, [js, ...args]);
  assert.equal(s.options.windowsVerbatimArguments, undefined);
  assert.equal(s.options.cwd, 'C:\\Users\\bob');
});

test('without node on PATH, a .js shim runs through cmd.exe (Electron is never used as node)', () => {
  const shim = 'C:\\npm\\codex.cmd';
  const js = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const s = launchSpec(shim, ['--version'], { env: { A: '1' } }, io({ [shim]: NPM_SHIM, [js]: true }));
  assert.match(s.command, /cmd\.exe$/i);
  assert.equal(s.options.windowsVerbatimArguments, true);
  assert.equal(s.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.throws(() => launchSpec(js, [], {}, io({ [js]: true })), /Node\.js is needed/);
});

test("npm's shim of a node script without an extension (cline's bin/cline) runs it with node; a bare binary runs as itself", () => {
  const shim = 'C:\\npm\\cline.cmd';
  const script = 'C:\\npm\\node_modules\\cline\\bin\\cline';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const text = NPM_SHIM.replace('@openai\\codex\\bin\\codex.js', 'cline\\bin\\cline');
  const s = launchSpec(shim, ['--acp'], {}, io({ [shim]: text, [script]: true, [node]: true }));
  assert.deepEqual([s.command, s.args], [node, [script, '--acp']]);
  // no node on PATH: cmd.exe, which finds the shim's own node or says why not
  assert.match(launchSpec(shim, ['--acp'], {}, io({ [shim]: text, [script]: true })).command, /cmd\.exe$/i);
  // a shim that names no node runs its extension-less target as it is
  const bare = '@ECHO off\r\n"%dp0%\\tools\\agent" %*\r\n';
  const tool = 'C:\\npm\\tools\\agent';
  assert.equal(launchSpec('C:\\npm\\agent.cmd', [], {}, io({ 'C:\\npm\\agent.cmd': bare, [tool]: true })).command, tool);
});

test('a shim for a native binary launches the binary', () => {
  const shim = 'C:\\npm\\claude.cmd';
  const exe = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const s = launchSpec(shim, ['auth', 'status', '--json'], {}, io({ [shim]: NATIVE_SHIM, [exe]: true }));
  assert.equal(s.command, exe);
  assert.deepEqual(s.args, ['auth', 'status', '--json']);
  assert.equal(resolveShim(shim, io({ [shim]: NATIVE_SHIM, [exe]: true })), exe);
  assert.equal(resolveShim('/usr/local/bin/claude', io({}, { platform: 'darwin' })), '/usr/local/bin/claude');
  // a shim whose target is missing stays a shim
  assert.equal(resolveShim(shim, io({ [shim]: NATIVE_SHIM })), shim);
});

test('an unreadable shim goes through cmd.exe with every argument escaped', () => {
  const shim = 'C:\\Program Files\\x\\codex.cmd';
  const s = launchSpec(shim, ['cloud', 'exec', 'fix "a" & b'], {}, io({ [shim]: '@echo off\r\nweird.exe %*' }));
  assert.equal(s.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(s.options.windowsVerbatimArguments, true);
  assert.equal(s.options.windowsHide, true);
  // the command line is wrapped in one pair of quotes; spaces and metacharacters are caret-escaped
  assert.match(s.args[3], /^"C:\\Program\^ Files\\x\\codex\.cmd /);
  assert.ok(s.args[3].endsWith('"'));
  assert.ok(!/[^^][&|<>]/.test(s.args[3].slice(1, -1).replace(/\^\^/g, '')), s.args[3]);
});

test('cmd.exe argument escaping', () => {
  assert.equal(cmdEscapeArg('plain', false), '^"plain^"');
  assert.equal(cmdEscapeArg('a b', false), '^"a^ b^"');
  assert.equal(cmdEscapeArg('say "hi"', false), '^"say^ \\^"hi\\^"^"');
  assert.equal(cmdEscapeArg('100%', false), '^"100^%^"');
  assert.equal(cmdEscapeArg('dir\\', false), '^"dir\\\\^"');
  assert.equal(cmdEscapeArg('a&b', true), '^^^"a^^^&b^^^"');
  assert.throws(() => cmdEscapeArg('two\nlines', false), /line break/);
});

test('Claude sign-in command: env on macOS, PowerShell on Windows', () => {
  assert.deepEqual(loginCommand('/usr/local/bin/claude', '/data/acc', 'darwin'), [
    '/usr/bin/env',
    'CLAUDE_CONFIG_DIR=/data/acc',
    '/usr/local/bin/claude',
    'auth',
    'login',
  ]);
  const w = loginCommand(
    "C:\\Users\\o'neil\\npm\\claude.cmd",
    "C:\\Users\\o'neil\\AppData\\Roaming\\MoPilot\\claude-accounts\\ab",
    'win32',
  );
  assert.deepEqual(w.slice(0, 4), ['powershell.exe', '-NoLogo', '-NoProfile', '-Command']);
  assert.equal(
    w[4],
    "$env:CLAUDE_CONFIG_DIR='C:\\Users\\o''neil\\AppData\\Roaming\\MoPilot\\claude-accounts\\ab'; & 'C:\\Users\\o''neil\\npm\\claude.cmd' auth login",
  );
  assert.equal(psQuote("it's"), "'it''s'");
});

test('shortcut labels: macOS glyphs, Ctrl/Alt/Shift elsewhere', () => {
  assert.equal(shortcutLabel('⇧⌘A', true), '⇧⌘A');
  assert.equal(shortcutLabel('⌘N', false), 'Ctrl+N');
  assert.equal(shortcutLabel('⇧⌘A', false), 'Ctrl+Shift+A');
  assert.equal(shortcutLabel('⌥⌘B', false), 'Ctrl+Alt+B');
  assert.equal(shortcutLabel('⌥Space', false), 'Alt+Space');
  assert.equal(shortcutLabel('⌃`', false), 'Ctrl+`');
  assert.equal(shortcutLabel('⌃⇧G', false), 'Ctrl+Shift+G');
  assert.equal(shortcutLabel('⌘1–9', false), 'Ctrl+1–9');
  assert.equal(shortcutLabel('⌘,', false), 'Ctrl+,');
  assert.equal(shortcutLabel('Enter', false), 'Enter');
  assert.equal(modKey({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(modKey({ metaKey: true, ctrlKey: false }, false), false);
  assert.equal(modKey({ metaKey: false, ctrlKey: true }, false), true);
});

test('terminal shell and titles per platform', () => {
  assert.deepEqual(defaultShell(false), ['/bin/zsh', '-l']);
  assert.deepEqual(defaultShell(true), ['powershell.exe', '-NoLogo']);
  assert.deepEqual(shellScript('npm test', false), ['/bin/zsh', '-lc', 'npm test']);
  assert.deepEqual(shellScript('npm test', true), ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', 'npm test']);
  assert.equal(terminalTitle('/Users/b/app', false), 'app');
  assert.equal(terminalTitle('/', false), 'zsh');
  assert.equal(terminalTitle('C:\\Users\\b\\app\\', true), 'app');
  assert.equal(terminalTitle('', true), 'powershell');
});

test('Windows terminals: PowerShell, the PATH left as Explorer gave it, no SHELL', () => {
  const { spawnSpec } = require('../electron/platform/pty.cjs');
  const s = spawnSpec({}, { platform: 'win32', env: { Path: 'C:\\Windows;C:\\npm', A: '1' }, home: 'C:\\Users\\b', isDir: () => false });
  assert.equal(s.file, 'powershell.exe');
  assert.deepEqual(s.args, ['-NoLogo']);
  assert.equal(s.cwd, 'C:\\Users\\b');
  assert.equal(s.env.Path, 'C:\\Windows;C:\\npm');
  assert.equal(s.env.PATH, undefined);
  assert.equal(s.env.SHELL, undefined);
});

test('Windows child env: no login-shell snapshot and no ":"-joined PATH', () => {
  const { childEnv } = require('../electron/platform/env.cjs');
  assert.deepEqual(childEnv({ Path: 'C:\\a;D:\\b', N: 1 }, { PATH: '/nvm/bin' }, 'win32'), { Path: 'C:\\a;D:\\b', N: '1' });
});

test('managed worktrees fold into their repo on both platforms', async () => {
  const { codexWorktreeRepo, chatFolder } = await import('../src/lib/paths.ts');
  assert.equal(codexWorktreeRepo('/Users/b/.mopilot/worktrees/ab12/app/src'), 'app');
  assert.equal(codexWorktreeRepo('C:\\Users\\b\\.mopilot\\worktrees\\ab12\\app'), 'app');
  assert.equal(chatFolder('C:\\Users\\b\\.mopilot\\worktrees\\1\\app', 'C:\\Users\\b', 'C:\\Users\\b\\Documents\\MoPilot'), null);
});

test('recorded shortcuts: Ctrl stands for ⌘ off macOS', async () => {
  const { comboFromEvent } = await import('../src/lib/format.ts');
  const e = { key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
  assert.equal(comboFromEvent(e, false), '⇧⌘K');
  assert.equal(comboFromEvent(e, true), '⌃⇧K');
});
