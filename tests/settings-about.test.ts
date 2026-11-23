// Settings → About (updates, diagnostics, harness CLIs), the Codex runtime group and Codex Cloud environments.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  blur,
  calls,
  ctl,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  pick,
  options,
  setValue,
  flush,
  lastPrefs,
  toggle,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { useHarnessUpdates } = await import('../src/harness/harnessUpdates.ts');
/** main's update check of one harness's binary (harness/harnessUpdates.ts), as the version rows read it */
const checked = (over: any) => ({
  bin: '/x',
  installed: null,
  latest: null,
  via: 'unknown',
  from: '',
  command: null,
  updatable: false,
  blockedReason: null,
  latestStatus: null,
  checkedAt: null,
  state: 'idle',
  waitingFor: 0,
  runId: null,
  outcome: null,
  ...over,
});
const { Settings, CodexRuntime, CloudSettings } = await import('../src/components/pages/Settings.tsx');
const { harnessChecksText } = await import('../src/harness/harnessChecks.ts');
const { MATRIX } = await import('../src/harness/compat.ts');
// what Copy diagnostics copies: main's text, then the test machine's harness checks from the bundled matrix
const copied = (main: string) => `${main}\n\n${harnessChecksText(MATRIX)}\n`;

const section = (s: string) => render(h(Settings, { section: s }));
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  useHarnessUpdates.setState({ harnesses: [] });
});

test('about shows each update state with the matching action', async () => {
  const at = Date.UTC(2026, 0, 1, 12);
  const cases: [any, string, string][] = [
    [{ status: 'unsupported', version: '1.0.0' }, 'Updates are only available in release builds.', 'Check for updates'],
    [{ status: 'checking', version: '1.0.0' }, 'Checking for updates…', 'Check for updates'],
    [{ status: 'downloading', version: '1.0.0' }, 'Downloading an update…', 'Check for updates'],
    [
      { status: 'downloading', version: '1.0.0', progress: { version: '2.0.0', received: 14_200_000, total: 145_184_001 } },
      'Downloading version 2.0.0… 14 MB of 145 MB (9%)',
      'Check for updates',
    ],
    [
      { status: 'downloading', version: '1.0.0', progress: { version: '', received: 2_345_678, total: null } },
      'Downloading an update… 2.3 MB',
      'Check for updates',
    ],
    [
      { status: 'downloading', version: '1.0.0', preparing: true, progress: { version: '2.0.0', received: 5, total: 5 } },
      'Preparing version 2.0.0…',
      'Check for updates',
    ],
    [
      { status: 'ready', version: '1.0.0', available: { version: '2.0.0', notes: '' } },
      'Version 2.0.0 is ready. Restart to install it.',
      'Restart to update',
    ],
    [
      { status: 'ready', version: '1.0.0', available: { version: '2.0.0', notes: '' }, error: 'Squirrel failed' },
      'Version 2.0.0 is ready. Restart to install it. Squirrel failed',
      'Restart to update',
    ],
    [
      { status: 'ready', version: '1.0.0', available: { version: '2.0.0', notes: '' }, restartWhenIdle: true },
      'Version 2.0.0 is ready. MoPilot restarts to install it when idle.',
      'Restart to update',
    ],
    [{ status: 'installing', version: '1.0.0' }, 'Restarting to install the update…', 'Check for updates'],
    [
      { status: 'ready', version: '1.0.0', manual: true, available: { version: '2.0.0', notes: '' } },
      'Version 2.0.0 is available. Download and run its installer.',
      'Download update',
    ],
    [{ status: 'error', version: '1.0.0', error: 'boom' }, 'boom', 'Check for updates'],
    [{ status: 'error', version: '1.0.0' }, 'Update check failed.', 'Check for updates'],
    [{ status: 'idle', version: '1.0.0', checkedAt: at }, `Up to date · checked ${new Date(at).toLocaleTimeString()}`, 'Check for updates'],
    [{ status: 'idle', version: '' }, 'MoPilot', 'Check for updates'],
    [
      {
        status: 'ready',
        version: '2.0.0',
        available: { version: '1.9.0', notes: '', rollback: { fromVersion: '2.0.0', channel: 'stable', requestId: 'id' } },
      },
      'Release 2.0.0 was pulled back. Version 1.9.0 is ready. Restart to install it.',
      'Restart to roll back',
    ],
    [
      {
        status: 'ready',
        version: '2.0.0',
        manual: true,
        available: { version: '1.9.0', notes: '', rollback: { fromVersion: '2.0.0', channel: 'stable', requestId: 'id' } },
      },
      'Release 2.0.0 was pulled back. Version 1.9.0 is available. Download and run its installer.',
      'Download rollback',
    ],
  ];
  for (const [st, desc, action] of cases) {
    ctl.update = st;
    calls.length = 0;
    const { host, unmount } = await section('about');
    const r = row(host, 'Version');
    assert.equal(text(r.querySelector('.settings-row-title')), `Version ${st.version}`.trim());
    assert.equal(text(r.querySelector('.settings-row-desc')), desc);
    const b = button(r, action);
    assert.equal(b.disabled, ['unsupported', 'checking', 'downloading', 'installing'].includes(st.status));
    if (!b.disabled) {
      await click(b);
      const want = st.status !== 'ready' ? ['updates.check'] : st.manual ? ['updates.install'] : ['updates.install', { when: 'now' }];
      assert.deepEqual(calls.at(-1), want);
    }
    assert.equal(
      text(row(host, 'Update automatically').querySelector('.settings-row-desc')),
      st.manual ? 'Check for new versions in the background' : 'Download new versions in the background and install them on restart',
    );
    await unmount();
  }
});

test("a ready update's What's new opens and closes under its row; other states offer none", async () => {
  ctl.update = { status: 'ready', version: '1.0.0', available: { version: '2.0.0', notes: '  ## New\n- a thing  ' } };
  const { host, unmount } = await section('about');
  const whatsNew = button(row(host, 'Version'), "What's new");
  assert.equal(whatsNew.getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector('.update-notes'), null);
  await click(whatsNew);
  assert.equal(whatsNew.getAttribute('aria-expanded'), 'true');
  assert.match(text(host.querySelector('.update-notes')), /a thing/);
  await click(whatsNew);
  assert.equal(host.querySelector('.update-notes'), null);
  await unmount();
  for (const st of [
    { status: 'ready', version: '1.0.0', available: { version: '2.0.0', notes: '   ' } },
    { status: 'downloading', version: '1.0.0', available: { version: '2.0.0', notes: 'x' } },
    { status: 'ready', version: '1.0.0', available: null },
  ]) {
    ctl.update = st;
    const other = await section('about');
    assert.equal(
      [...row(other.host, 'Version').querySelectorAll('button')].some((b) => b.textContent === "What's new"),
      false,
    );
    await other.unmount();
  }
});

test('auto update and the update channel write prefs; dogfood is offered to staff only', async () => {
  useStore.setState({ prefs: { ...useStore.getState().prefs, updateChannel: 'dogfood' } });
  let r = await section('about');
  assert.equal(text(row(r.host, 'Update channel').querySelector('.select-btn')), 'Beta');
  await click(row(r.host, 'Update channel').querySelector('.select-btn')!);
  assert.deepEqual(options(row(r.host, 'Update channel')), ['Stable', 'Beta']);
  await pick(row(r.host, 'Update channel'), 'Stable');
  assert.deepEqual(lastPrefs(), { updateChannel: 'stable' });
  await toggle(r.host, 'Update automatically');
  assert.deepEqual(lastPrefs(), { autoUpdate: false });
  await r.unmount();
  ctl.mopilotUser = { internal: true };
  useStore.setState({ prefs: { ...useStore.getState().prefs, updateChannel: 'dogfood' } });
  r = await section('about');
  assert.equal(text(row(r.host, 'Update channel').querySelector('.select-btn')), 'Dogfood');
  await click(row(r.host, 'Update channel').querySelector('.select-btn')!);
  assert.deepEqual(options(row(r.host, 'Update channel')), ['Stable', 'Beta', 'Dogfood']);
  await r.unmount();
});

test('about: Join the community opens the shared link, and says why when it cannot', async () => {
  const { COMMUNITY_URL } = await import('../shared/community.mjs');
  const { host, unmount } = await section('about');
  assert.match(text(row(host, 'Join the community')), /Discord/);
  await click(button(host, 'Join'));
  assert.deepEqual(calls.at(-1), ['shell.openExternal', COMMUNITY_URL]);
  responses['shell.openExternal'] = () => Promise.reject(new Error('no browser'));
  await click(button(host, 'Join'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't open the community link: no browser", 'error']);
  await unmount();
});

test('about opens notices, copies diagnostics, and lists both harness CLIs', async () => {
  ctl.status = { codex: { bin: '/bin/codex', version: '0.9' }, claude: {} };
  useHarnessUpdates.setState({ harnesses: [checked({ harness: 'codex', bin: '/bin/codex', via: 'app-bundle', from: 'ChatGPT.app' })] });
  responses['app.info'] = { version: '1' };
  responses['app.diagnostics'] = 'diag text';
  responses['app.openNotices'] = { ok: true, path: '/x' };
  const { host, unmount } = await section('about');
  assert.ok(host.querySelector('[data-stub=MigrationAdvanced]'));
  await click(button(host, 'View notices'));
  assert.deepEqual(calls.at(-1), ['app.openNotices']);
  responses['app.openNotices'] = () => Promise.reject(new Error('bridge gone'));
  await click(button(host, 'View notices'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't open the notices: bridge gone", 'error']);
  // main answers why it didn't open the file, or only that it didn't
  responses['app.openNotices'] = { ok: false, error: 'The notices file is missing from this build.' };
  await click(button(host, 'View notices'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't open the notices: The notices file is missing from this build.", 'error']);
  responses['app.openNotices'] = { ok: false };
  await click(button(host, 'View notices'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't open the notices: the file did not open", 'error']);
  responses['app.openNotices'] = { ok: true, path: '/x' };
  await click(button(host, 'View notices'));
  await flush();
  assert.deepEqual(calls.at(-1), ['app.openNotices']);
  await click(button(host, 'Copy diagnostics'));
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['clipboard.write', copied('diag text')],
    ['toast', 'Diagnostics copied'],
  ]);
  assert.match(copied('diag text'), /\n\nHarness checks \(MoPilot's test machine; these versions, not this Mac\)\n/);
  // "copied" only once the write went through
  responses['clipboard.write'] = () => Promise.reject(new Error('clipboard busy'));
  await click(button(host, 'Copy diagnostics'));
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['clipboard.write', copied('diag text')],
    ['toast', "Couldn't copy: clipboard busy", 'error'],
  ]);
  delete responses['clipboard.write'];
  responses['app.diagnostics'] = () => Promise.reject(new Error('x'));
  await click(button(host, 'Copy diagnostics'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't collect diagnostics: x", 'error']);
  // Report a bug opens the bug report about no chat (Dialogs.tsx draws it)
  const reports: unknown[] = [];
  const onReport = (e: Event) => reports.push((e as CustomEvent).detail);
  window.addEventListener('open-bug-report', onReport);
  await click(button(host, 'Report a bug'));
  window.removeEventListener('open-bug-report', onReport);
  assert.deepEqual(reports, [{ threadId: null }]);
  const codex = row(host, 'Codex CLI');
  // the version and how it was installed, as on its own page; the full path on hover
  assert.equal(text(codex.querySelector('.settings-row-desc')), '0.9 · Bundled with ChatGPT.app');
  assert.equal(codex.querySelector('.cli-line')!.getAttribute('title'), '/bin/codex');
  const claude = row(host, 'Claude Code CLI');
  assert.equal(text(claude.querySelector('.settings-row-desc')), 'Not found');
  await click(button(claude, 'Manage'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'claude' }]);
  await unmount();
  // a path the user set reads Custom location; an install found, how it was installed
  ctl.status = {
    codex: { bin: '/n/codex', version: null },
    claude: { bin: '/w/claude', version: '2.1.302', candidates: [{ path: '/a/claude', version: '2.1.302', via: 'self', from: '' }] },
  };
  useStore.setState({ prefs: { ...useStore.getState().prefs, claudeBin: '/w/claude' } });
  const again = await section('about');
  assert.equal(text(row(again.host, 'Claude Code CLI').querySelector('.settings-row-desc')), '2.1.302 · Custom location');
  assert.equal(text(row(again.host, 'Codex CLI').querySelector('.settings-row-desc')), 'Version unknown');
  await again.unmount();
});

test('codex runtime: one version row in plain words, its installs in a menu, another path, its folder and a restart', async () => {
  let bins!: (v: any) => void;
  responses['codex.binaries'] = () => new Promise((r) => (bins = r));
  const { host, unmount } = await render(h(CodexRuntime));
  assert.equal(text(row(host, 'Version').querySelector('.settings-row-desc')), 'Detecting…');
  const app = '/Applications/ChatGPT.app/Contents/Resources/codex';
  bins({
    candidates: [
      { path: app, version: '1.0', via: 'app-bundle', from: 'ChatGPT.app' },
      { path: '/opt/homebrew/bin/codex', version: null, via: 'brew', from: 'Homebrew' },
    ],
    current: '/opt/homebrew/bin/codex',
  });
  await flush();
  const cli = row(host, 'Version');
  // no version found for that binary: the running app server's; then how it was installed; the path only on hover
  assert.equal(text(cli.querySelector('.settings-row-desc')), '1.2.3 · Homebrew');
  assert.equal(cli.querySelector('.cli-line')!.getAttribute('title'), '/opt/homebrew/bin/codex');
  assert.equal(host.querySelectorAll('.settings-row-title').length, 3, 'no CLI location row: Version, Settings folder, Restart');
  await click(button(cli, 'Codex CLI options'));
  assert.equal(text(cli.querySelector('.menu header')), '2 installs found');
  assert.deepEqual(options(cli), ['1.0 · Bundled with ChatGPT.app', 'Version unknown · Homebrew', 'Show in Finder', 'Choose another…']);
  assert.deepEqual(
    [...cli.querySelectorAll('.menu-item')].slice(0, 2).map((b) => [b.getAttribute('title'), b.getAttribute('aria-checked')]),
    [
      [app, 'false'],
      ['/opt/homebrew/bin/codex', 'true'],
    ],
  );
  await pick(cli, '1.0 · Bundled with ChatGPT.app');
  assert.equal(useStore.getState().codexBin, app);
  await flush(450);
  assert.deepEqual(calls.slice(-2), [['codex.restart'], ['reload']]);
  // Choose another… types a path into the row itself, as the CLI location row's Change… did
  await pick(cli, 'Choose another…');
  await setValue(cli.querySelector('input')!, '/opt/codex');
  await blur(cli.querySelector('input')!);
  assert.equal(useStore.getState().codexBin, '/opt/codex');
  await flush(450);
  assert.deepEqual(calls.slice(-2), [['codex.restart'], ['reload']]);
  assert.equal(text(row(host, 'Settings folder').querySelector('.settings-row-desc')), '~/.codex');
  await click(button(row(host, 'Settings folder'), 'Open'));
  assert.deepEqual(calls.at(-1), ['shell.openPath', '/Users/me/.codex']);
  await click(button(row(host, 'Restart Codex'), 'Restart'));
  await flush();
  assert.deepEqual(calls.slice(-2), [['codex.restart'], ['reload']]);
  // a restart that failed says so and leaves the page as it is
  responses['codex.restart'] = () => Promise.reject(new Error('busy'));
  await click(button(row(host, 'Restart Codex'), 'Restart'));
  await flush();
  assert.deepEqual(calls.slice(-2), [['codex.restart'], ['toast', "Couldn't restart the Codex server: busy", 'error']]);
  delete responses['codex.restart'];
  await unmount();
});

test("codex runtime says why it couldn't look for the Codex CLI instead of detecting forever", async () => {
  responses['codex.binaries'] = () => Promise.reject(new Error("Error invoking remote method 'codex:binaries': Error: which failed"));
  const { host, unmount } = await render(h(CodexRuntime));
  await flush();
  assert.equal(text(row(host, 'Version').querySelector('.settings-row-desc')), "Couldn't look for the Codex CLI: which failed");
  // nothing found to show in Finder; another path can still be chosen
  await click(button(row(host, 'Version'), 'Codex CLI options'));
  assert.deepEqual(options(row(host, 'Version')), ['Choose another…']);
  await unmount();
});

test('codex runtime with one install: no install list; its own version when the server has none; a custom path resets', async () => {
  useStore.setState({ userAgent: null, codexHome: null, codexBin: '/my/codex' });
  responses['codex.binaries'] = { candidates: [{ path: '/x/codex', version: '0.5.0', via: 'unknown', from: '' }], current: '/my/codex' };
  const { host, unmount } = await render(h(CodexRuntime));
  await flush();
  const desc = row(host, 'Version').querySelector('.settings-row-desc')!;
  // a path the user set, not one of the installs found
  assert.equal(text(desc), 'Version unknown · Custom location');
  assert.equal(desc.querySelector('[title]')?.getAttribute('title'), '/my/codex');
  assert.equal(desc.querySelector('.cli-offpath'), null);
  await click(button(row(host, 'Version'), 'Codex CLI options'));
  assert.equal(row(host, 'Version').querySelector('.menu header'), null, 'one install: nothing to pick between');
  assert.deepEqual(options(row(host, 'Version')), ['Show in Finder', 'Choose another…', 'Reset']);
  await pick(row(host, 'Version'), 'Show in Finder');
  assert.deepEqual(calls.at(-1), ['shell.reveal', '/my/codex']);
  await pick(row(host, 'Version'), 'Reset');
  assert.equal(useStore.getState().codexBin, null);
  await flush(450);
  assert.deepEqual(calls.slice(-2), [['codex.restart'], ['reload']]);
  const before = calls.length;
  await click(button(row(host, 'Settings folder'), 'Open'));
  assert.equal(calls.length, before);
  await unmount();
  // the version found for that binary, whole, over the server's shortened one
  useStore.setState({ codexBin: null, userAgent: 'codex/0.5.0 (mac)' });
  responses['codex.binaries'] = {
    candidates: [{ path: '/x/codex', version: '0.5.0-alpha.2', via: 'unknown', from: '' }],
    current: '/x/codex',
  };
  const r2 = await render(h(CodexRuntime));
  await flush();
  assert.equal(text(row(r2.host, 'Version').querySelector('.settings-row-desc')), '0.5.0-alpha.2 · Installed manually');
  await r2.unmount();
});

test('codex runtime whose terminal runs a different codex says so, with both paths on hover', async () => {
  useStore.setState({ userAgent: null, codexHome: null });
  responses['codex.binaries'] = {
    candidates: [{ path: '/h/.local/bin/codex', version: '0.2.0', offPath: true, terminal: '/opt/homebrew/bin/codex' }],
    current: '/h/.local/bin/codex',
    offPath: true,
    terminal: '/opt/homebrew/bin/codex',
  };
  const { host, unmount } = await render(h(CodexRuntime));
  await flush();
  const note = row(host, 'Version').querySelector('.cli-offpath')!;
  assert.equal(text(note), 'Your terminal runs a different Codex');
  assert.equal(note.getAttribute('title'), 'MoPilot runs /h/.local/bin/codex\nYour terminal runs /opt/homebrew/bin/codex');
  await unmount();
});

test('cloud environments list, filter, open for editing, and report errors or emptiness', async () => {
  let envs!: (v: any) => void;
  responses['cloud.envs'] = () => new Promise((r) => (envs = r));
  let r = await render(h(CloudSettings));
  assert.equal(r.host.querySelector('.connections-empty'), null);
  assert.equal(r.host.querySelector('.settings-card'), null);
  envs({
    envs: [
      { id: 'e1', label: 'Web', repo: 'org/web' },
      { id: 'e2', label: 'Api', repo: null },
    ],
  });
  await flush();
  assert.equal(text(row(r.host, 'Web').querySelector('.settings-row-desc')), 'org/web');
  assert.equal(text(row(r.host, 'Api').querySelector('.settings-row-desc')), 'e2');
  await click(button(row(r.host, 'Api'), 'Edit'));
  assert.deepEqual(calls.at(-1), ['shell.openExternal', 'https://chatgpt.com/codex/settings/environment/e2']);
  await click(button(r.host, 'Create environment'));
  assert.deepEqual(calls.at(-1), ['shell.openExternal', 'https://chatgpt.com/codex/settings/environments']);
  await setValue(r.host.querySelector('.pill-search input')!, 'WE');
  assert.deepEqual([...r.host.querySelectorAll('.settings-row-title')].map(text), ['Web']);
  await setValue(r.host.querySelector('.pill-search input')!, 'zzz');
  assert.equal(text(r.host.querySelector('.connections-empty')), 'No saved environments');
  await r.unmount();
  responses['cloud.envs'] = { error: 'Sign in to ChatGPT' };
  r = await render(h(CloudSettings));
  await flush();
  assert.equal(text(r.host.querySelector('.connections-empty')), 'Sign in to ChatGPT');
  await r.unmount();
  // a request that failed says why instead of loading forever
  responses['cloud.envs'] = () => Promise.reject(new Error('offline'));
  r = await render(h(CloudSettings));
  await flush();
  assert.equal(text(r.host.querySelector('.connections-empty')), "Couldn't list the environments: offline");
  await r.unmount();
});
