import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, change, flush, settingsStubs, fakeStore, rows, byText, reactProps } from './support/harness-ui-kit.ts';
import { iconStubs, mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (calls.push([name, ...a]), ret);
const store = fakeStore<any>({ home: '/Users/me', claudeAccounts: { active: 'default' }, auth: { mode: 'subscription' } });
let extras: () => Promise<any> = async () => ({ commands: [], mcp: [] });
let catalog: () => Promise<any> = async () => ({ plugins: [] });
let mcp: (argv: string[]) => Promise<string> = async () => '';
let settingsText: () => Promise<string | null> = async () => '';
let configRoots: () => Promise<any> = async () => ({ claudeRoot: '/Users/bob/.claude' });
let confirmAnswer = true;
(globalThis as any).confirm = (m: string) => (calls.push(['confirm', m]), confirmAnswer);
stubStore({
  currentCwdForNewChat: () => '/proj',
  navigate: rec('navigate'),
  openPaneTab: rec('openPaneTab'),
  toast: rec('toast'),
  useStore: store.useStore,
});
installNativeStub({
  claude: {
    extras: (b: string, c: string) => (calls.push(['extras', b, c]), extras()),
    catalog: (b: string, c: string) => (calls.push(['catalog', b, c]), catalog()),
    mcp: (b: string, argv: string[]) => (calls.push(['mcp', b, argv]), mcp(argv)),
  },
  fs: {
    configRoots: () => configRoots(),
    readText: (p: string) => (calls.push(['read', p]), settingsText()),
  },
});
mock.module('../src/session/open.ts', { namedExports: { openFile: rec('openFile') } });
mock.module('../src/session/harness/billing.ts', {
  namedExports: {
    useClaudeKey: () => store.useStore((s: any) => s.auth),
    refreshClaudeKey: async () => {},
  },
});
mock.module('../src/components/pages/Settings.tsx', {
  namedExports: { Group: settingsStubs.Group, Row: settingsStubs.Row, Select: settingsStubs.Select },
});
mockSource('src/components/ui/icons.tsx', iconStubs(undefined, { Spinner: () => h('span', { className: 'spin' }) }));
mockSource('src/components/panels/TerminalPanel.tsx', { TermView: () => null });
const { ClaudeExtensions, ClaudePlugins } = await import('../src/components/harness/claude/Extensions.tsx');

const group = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === title) as HTMLElement;
const preview = (host: HTMLElement) => host.querySelector('[aria-label="Command preview"]')?.textContent;
const field = (host: HTMLElement, label: string) => host.querySelector(`[aria-label="${label}"]`);

test('while loading every section says so, and the hooks file cannot be opened yet', async () => {
  extras = () => new Promise(() => {});
  catalog = () => new Promise(() => {});
  settingsText = () => new Promise(() => {});
  const r = await mount(h(ClaudeExtensions, { bin: '/bin/claude' }));
  assert.deepEqual(rows(r.host), ['Loading…', 'Loading…', 'Install a plugin', 'Available', 'Loading…', 'settings.json']);
  assert.equal(byText(group(r.host, 'Skills and commands'), '.row i', 'Loading…') !== undefined, true);
  assert.equal(byText(r.host, 'button', 'Open settings.json')?.hasAttribute('disabled'), true);
  assert.equal(group(r.host, 'Hooks').querySelectorAll('.row i').length, 0);
  await r.unmount();
});

test('servers needing authentication offer sign-in and source-specific management', async () => {
  extras = async () => ({
    commands: [],
    mcp: [
      { name: 'plugin:stripe:stripe', status: 'needs-auth', source: 'plugin', transport: 'http' },
      { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' },
    ],
  });
  catalog = async () => ({ plugins: [] });
  const r = await mount(h(ClaudeExtensions, { bin: '/bin/claude' }));
  assert.ok(byText(r.host, 'button', 'Sign in'));
  assert.ok(byText(r.host, 'button', 'Connect in Claude'));
  assert.equal(byText(r.host, 'button', 'Remove'), undefined);
  assert.match(r.host.textContent!, /Sign-in required/);
  await r.unmount();
});

test('loaded: servers with their status, plugins, commands capped at 24, and hooks', async () => {
  extras = async () => ({
    commands: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}` })),
    mcp: [
      { name: 'gh', status: 'connected' },
      { name: 'bad', status: 'failed' },
      { name: 'slow', status: 'pending' },
    ],
  });
  catalog = async () => ({
    plugins: [
      { name: 'p1', path: '/pl/p1' },
      { name: 'p2', path: null },
    ],
  });
  settingsText = async () =>
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }], Stop: [{ hooks: [{ type: 'prompt' }] }] },
    });
  calls.length = 0;
  const r = await mount(h(ClaudeExtensions, { bin: '/bin/claude' }));
  await flush();
  assert.deepEqual(calls.slice(0, 2), [
    ['extras', '/bin/claude', '/proj'],
    ['catalog', '/bin/claude', '/proj'],
  ]);
  assert.deepEqual(
    [...r.host.querySelectorAll('.hp-badge')].map((b) => [b.className, b.textContent]),
    [
      ['hp-badge ok', 'Connected'],
      ['hp-badge err', 'Connection failed'],
      ['hp-badge ', 'Connecting…'],
    ],
  );
  assert.deepEqual(rows(group(r.host, 'Plugins')), ['p1', 'p2', 'Install a plugin']);
  assert.equal(group(r.host, 'Plugins').querySelector('.row i')?.textContent, '/pl/p1');
  const cmds = group(r.host, 'Skills and commands').querySelector('.row i')!.textContent!;
  assert.match(cmds, /^\/c0 {2}\/c1 .*\/c23 {2}… 2 more$/);
  const hooks = group(r.host, 'Hooks');
  assert.deepEqual(rows(hooks), ['PreToolUse', 'Stop', 'settings.json']);
  assert.deepEqual(
    [...hooks.querySelectorAll('.row i')].map((i) => i.textContent),
    ['lint · matcher Bash', 'prompt', '~/.claude/settings.json'],
  );
  await click(byText(r.host, 'button', 'Open settings.json'));
  assert.deepEqual(calls.at(-1), ['openFile', '/Users/bob/.claude/settings.json']);
  await r.unmount();
});

test('nothing configured, read failures, and an invalid settings.json', async () => {
  extras = async () => {
    throw new Error("Error invoking remote method 'claude:extras': Error: no cli");
  };
  catalog = async () => {
    throw new Error('x');
  };
  settingsText = async () => '{bad';
  let r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.match(group(r.host, 'MCP servers').textContent!, /Couldn't read them: no cli/);
  // a plugin list that couldn't be read says so with Retry, not "No plugins installed"
  assert.equal(rows(group(r.host, 'Plugins'))[0], "Couldn't read the plugins");
  assert.equal(group(r.host, 'Plugins').querySelector('.row i')?.textContent, 'x');
  assert.equal(rows(group(r.host, 'Hooks'))[0], "settings.json isn't valid JSON");
  catalog = async () => ({ plugins: [] });
  await click(byText(group(r.host, 'Plugins'), 'button', 'Retry'));
  await flush();
  assert.equal(rows(group(r.host, 'Plugins'))[0], 'No plugins installed');
  await r.unmount();

  // settings.json that can't be found or read says so instead of loading forever
  configRoots = async () => {
    throw new Error('no home');
  };
  r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.equal(rows(group(r.host, 'Hooks'))[0], "Couldn't read settings.json: no home");
  await r.unmount();
  configRoots = async () => ({ claudeRoot: '/Users/bob/.claude' });

  extras = async () => ({ commands: [{ name: 'only' }], mcp: [] });
  catalog = async () => ({ plugins: [] });
  settingsText = async () => null;
  r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.equal(rows(group(r.host, 'MCP servers'))[0], 'None configured');
  assert.equal(group(r.host, 'Skills and commands').querySelector('.row i')?.textContent, '/only');
  assert.equal(rows(group(r.host, 'Hooks'))[0], 'No hooks configured');
  await r.unmount();

  extras = async () => ({ commands: [], mcp: [] });
  r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.equal(group(r.host, 'Skills and commands').querySelector('.row i')?.textContent, 'None');
  await r.unmount();

  // a server list Claude Code couldn't read says so instead of "None configured"; the commands still show
  extras = async () => ({ commands: [{ name: 'only' }], mcp: [], mcpError: 'Timed out' });
  r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.match(group(r.host, 'MCP servers').textContent!, /Couldn't read them: Timed out/);
  assert.equal(group(r.host, 'Skills and commands').querySelector('.row i')?.textContent, '/only');
  await r.unmount();

  // a read after a failed one starts clean: the old error doesn't hide what it finds
  extras = async () => {
    throw new Error('no cli');
  };
  r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.match(group(r.host, 'MCP servers').textContent!, /Couldn't read them: no cli/);
  extras = async () => ({ commands: [], mcp: [] });
  await r.render(h(ClaudeExtensions, { bin: '/b2' }));
  await flush();
  assert.equal(rows(group(r.host, 'MCP servers'))[0], 'None configured');
  await r.unmount();
});

test("another binary shows none of the last one's commands or plugins while its own are read", async () => {
  extras = async () => ({ commands: [{ name: 'old-command' }], mcp: [{ name: 'old-server', status: 'connected' }] });
  catalog = async () => ({ plugins: [{ id: 'old@m', name: 'old-plugin', enabled: true }] });
  const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  assert.match(r.host.textContent!, /old-command/);
  extras = () => new Promise(() => {});
  catalog = () => new Promise(() => {});
  await r.render(h(ClaudeExtensions, { bin: '/b2' }));
  assert.doesNotMatch(r.host.textContent!, /old-command|old-server|old-plugin/);
  await r.unmount();
  catalog = async () => ({ plugins: [] });
});

test('replies that land after unmount are dropped', async () => {
  for (const fail of [false, true]) {
    const pending: (() => void)[] = [];
    const late = () =>
      new Promise<any>((res, rej) => pending.push(() => (fail ? rej(new Error('late')) : res({ commands: [], mcp: [], plugins: [] }))));
    extras = late;
    catalog = late;
    configRoots = () => late().then(() => ({ claudeRoot: '/Users/bob/.claude' }));
    const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
    await r.unmount();
    pending.forEach((settle) => settle());
    await flush();
    assert.equal(pending.length, 3);
  }
  configRoots = async () => ({ claudeRoot: '/Users/bob/.claude' });
});

test('changing account or authentication mode retires old reads and shows only the new context', async () => {
  for (const field of ['account', 'mode']) {
    let settle!: (r: any) => void;
    extras = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    catalog = async () => ({ plugins: [] });
    const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
    const old = settle;
    extras = async () => ({ commands: [], mcp: [{ name: 'current', status: 'connected' }] });
    if (field === 'account') store.set({ claudeAccounts: { active: 'other' } });
    else store.set({ auth: { mode: 'apiKey' } });
    await flush();
    old({ commands: [{ name: 'retired' }], mcp: [{ name: 'retired', status: 'needs-auth' }] });
    await flush();
    assert.match(r.host.textContent!, /current/);
    assert.doesNotMatch(r.host.textContent!, /retired/);
    await r.unmount();
    store.set({ claudeAccounts: { active: 'default' }, auth: { mode: 'subscription' } });
  }
});

test('initial mode discovery and returning from the browser refresh authentication context', async () => {
  store.set({ auth: null });
  extras = async () => ({ commands: [], mcp: [] });
  const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  window.dispatchEvent(new Event('focus'));
  await flush();
  store.set({ auth: { mode: 'subscription' } });
  await r.unmount();
});

test('adding a server retains the current form when an obsolete write finishes or fails', async () => {
  for (const failure of [false, true]) {
    extras = async () => ({ commands: [], mcp: [] });
    const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
    await click(byText(r.host, 'button', 'Add server'));
    await change(field(r.host, 'MCP server name'), 'old');
    await change(field(r.host, 'MCP command'), 'npx');
    let resolve!: (s: string) => void, reject!: (e: unknown) => void;
    mcp = () =>
      new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
    await click(byText(r.host, 'button', 'Add server'));
    store.set({ auth: { mode: 'apiKey' } });
    await flush();
    await click(byText(r.host, 'button', 'Add server'));
    await change(field(r.host, 'MCP server name'), 'current');
    calls.length = 0;
    if (failure) reject(new Error('obsolete'));
    else resolve('Added old');
    await flush();
    assert.equal(
      calls.some((c) => c[0] === 'toast' || c[0] === 'extras'),
      false,
    );
    assert.equal((field(r.host, 'MCP server name') as HTMLInputElement).value, 'current');
    await r.unmount();
    store.set({ auth: { mode: 'subscription' } });
  }
  mcp = async () => '';
});

test('removing a server asks first, runs claude mcp remove and reloads, or shows the failure', async () => {
  extras = async () => ({ commands: [], mcp: [{ name: 'gh', status: 'connected', source: 'user' }] });
  catalog = async () => ({ plugins: [] });
  settingsText = async () => '';
  const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  calls.length = 0;
  confirmAnswer = false;
  await click(byText(r.host, 'button', 'Remove'));
  assert.deepEqual(calls, [['confirm', 'Run: /b mcp remove --scope user gh']]);
  confirmAnswer = true;
  calls.length = 0;
  await click(byText(r.host, 'button', 'Remove'));
  await flush();
  assert.deepEqual(calls.slice(0, 3), [
    ['confirm', 'Run: /b mcp remove --scope user gh'],
    ['mcp', '/b', ['mcp', 'remove', '--scope', 'user', 'gh']],
    ['extras', '/b', '/proj'],
  ]);
  mcp = async () => {
    throw 'denied';
  };
  calls.length = 0;
  await click(byText(r.host, 'button', 'Remove'));
  await flush();
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /denied/);
  await r.unmount();
});

test('adding a server previews the exact command and runs it only on Add server', async () => {
  extras = async () => ({ commands: [], mcp: [] });
  const r = await mount(h(ClaudeExtensions, { bin: '/b' }));
  await flush();
  await click(byText(r.host, 'button', 'Add server'));
  assert.equal(byText(r.host, 'button', 'Add server')?.className, 'btn primary sm');
  assert.deepEqual(rows(group(r.host, 'MCP servers')), []);
  const add = () => byText(r.host, 'button', 'Add server')!;
  assert.equal(preview(r.host), '# Name: letters, numbers, dot, dash and underscore only');
  assert.equal(add().hasAttribute('disabled'), true);
  await change(field(r.host, 'MCP server name'), 'gh');
  assert.equal(preview(r.host), '# Enter the command to run');
  await change(field(r.host, 'MCP command'), 'npx');
  await change(field(r.host, 'MCP arguments'), ' -y   srv ');
  const [envArea] = r.host.querySelectorAll('textarea');
  await change(envArea, 'A=1\n\n  B  \n');
  assert.equal(preview(r.host), 'claude mcp add --scope user --env A=1 --env B= gh -- npx -y srv');

  let release!: (v: string) => void;
  mcp = () => new Promise((res) => (release = res));
  calls.length = 0;
  const duplicateAdd = reactProps(add()).onClick;
  await click(add());
  assert.ok(r.host.querySelector('.mcp-form .spin'));
  await act(async () => duplicateAdd());
  assert.equal(calls.filter((c) => c[0] === 'mcp').length, 1);
  assert.deepEqual(calls[0], [
    'mcp',
    '/b',
    ['mcp', 'add', '--scope', 'user', '--env', 'A=1', '--env', 'B=', 'gh', '--', 'npx', '-y', 'srv'],
  ]);
  release('Added stdio MCP server gh\nmore');
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast'),
    [['toast', 'Added stdio MCP server gh']],
  );
  assert.equal(r.host.querySelector('.mcp-form'), null);
  assert.ok(calls.some((c) => c[0] === 'extras'));

  await click(byText(r.host, 'button', 'Add server'));
  await change(r.host.querySelector('select'), 'http');
  await change(field(r.host, 'MCP server name'), 'remote');
  assert.equal(preview(r.host), '# Enter a URL starting with http:// or https://');
  await change(field(r.host, 'MCP URL'), 'https://x/mcp');
  const [headers] = r.host.querySelectorAll('textarea');
  await change(headers, 'Authorization: Bearer t\nX-Plain');
  assert.equal(
    preview(r.host),
    "claude mcp add --scope user --transport http --header 'Authorization: Bearer t' --header 'X-Plain: ' remote https://x/mcp",
  );
  mcp = async () => {
    throw new Error("Error invoking remote method 'claude:mcp': exists");
  };
  calls.length = 0;
  await click(add());
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast'),
    [['toast', 'exists', 'error']],
  );
  assert.ok(r.host.querySelector('.mcp-form'));
  assert.equal(add().hasAttribute('disabled'), false);
  mcp = async () => '';
  calls.length = 0;
  await click(add());
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast'),
    [['toast', 'Added remote']],
  );

  await click(byText(r.host, 'button', 'Add server'));
  await click(byText(r.host, 'button', 'Cancel'));
  assert.equal(r.host.querySelector('.mcp-form'), null);
  await r.unmount();
});

test('installing a plugin opens a terminal with the command typed and goes home', async () => {
  calls.length = 0;
  const r = await mount(h(ClaudePlugins, { bin: '/opt/my claude', plugins: null, error: null }));
  assert.deepEqual(rows(r.host), ['Loading…', 'Install a plugin']);
  await click(byText(r.host, 'button', 'Install with claude plugin…'));
  store.set({ home: null });
  await flush(1);
  await click(byText(r.host, 'button', 'Install with claude plugin…'));
  assert.deepEqual(calls, [
    ['openPaneTab', 'terminal', { title: 'claude plugin', cwd: '/Users/me', input: "'/opt/my claude' plugin install " }],
    ['navigate', { name: 'home' }],
    ['openPaneTab', 'terminal', { title: 'claude plugin', cwd: undefined, input: "'/opt/my claude' plugin install " }],
    ['navigate', { name: 'home' }],
  ]);
  await r.unmount();
});
