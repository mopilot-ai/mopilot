// Settings → All harnesses' "Install another harness (N)" (src/components/harness/InstallHarnesses.tsx) over the real
// presence list (src/session/harness/installable.ts): which harnesses are missing, in which order, folded or not, a card's
// docs and CLI location, and Re-check all.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, settingsExports, render, click, byText, maybeText } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const { create } = await import('zustand');
const calls: any[] = [];
const store = fakeStore<any>({ status: {}, basicHarnesses: [], prefs: {} });
let recheckFails: string[] = [];
const runs = create<any>(() => ({ runs: [] }));
stubStore({
  useStore: store.useStore,
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
});
mock.module('../src/session/harness/select.ts', { namedExports: { harnessStatus: (h: string, s: any) => s.status[h] } });
mock.module('../src/session/harness/harnessRuns.ts', {
  namedExports: {
    useHarnessRuns: runs,
    refreshInstallTools: () => calls.push(['tools']),
    recheckHarness: async (kind: string) => {
      calls.push(['recheck', kind]);
      if (recheckFails.includes(kind)) throw new Error('probe failed');
    },
  },
});
mock.module('../src/session/harness/basicBin.ts', { namedExports: { pickBasicBin: (id: string, v: any) => calls.push(['bin', id, v]) } });
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(['open', u]) } });
// Windows, where Goose has no one-line command, so its card links to its maker instead
mock.module('../src/lib/platform.ts', { namedExports: { platform: 'win32' } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
mock.module('../src/components/harnessPicker/badges.tsx', {
  namedExports: {
    HarnessIcon: ({ h: id }: any) => h('i', { 'data-icon': id }),
    BasicHarnessIcon: ({ id }: any) => h('i', { 'data-icon': `acp:${id}` }),
  },
});
mock.module('../src/components/harness/InstallLines.tsx', {
  namedExports: {
    InstallLines: ({ item, onSetLocation }: any) =>
      h('div', { 'data-lines': item.kind }, h('button', { onClick: onSetLocation }, `Locate ${item.kind}`)),
  },
});
const { InstallHarnesses } = await import('../src/components/harness/InstallHarnesses.tsx');
const { presence } = await import('../src/session/harness/installable.ts');

const st = (state: string, extra: any = {}) => ({ state, version: null, ...extra });
const basic = (id: string, label: string, state: string, version: string | null = null) => ({ id, label, state, version });
const cards = (host: HTMLElement) => [...host.querySelectorAll('[data-install]')].map((c) => c.getAttribute('data-install'));
const fold = (host: HTMLElement) => host.querySelector('.install-fold') as HTMLButtonElement;
const set = (patch: any) => act(async () => store.setState(patch));

test('every supported harness, first-class first then basic ones by name, with what it is called and who makes it', () => {
  const list = presence({
    status: { codex: st('ready', { version: '0.162.0' }), claude: st('detecting') },
    basicHarnesses: [basic('qwen', 'Qwen Code', 'missing'), basic('dsh', 'dsh', 'off', '0.2'), basic('gemini', 'Gemini CLI', 'checking')],
  } as any);
  assert.deepEqual(
    list.map((p) => [p.kind, p.label, p.vendor, p.tier, p.state, p.version]),
    [
      ['codex', 'Codex', 'OpenAI', 'first', 'present', '0.162.0'],
      ['claude', 'Claude Code', 'Anthropic', 'first', 'checking', null],
      // a harness turned off is installed, not missing
      ['acp:dsh', 'dsh', 'DeepSeek', 'basic', 'present', '0.2'],
      ['acp:gemini', 'Gemini CLI', 'Google', 'basic', 'present', null],
      ['acp:qwen', 'Qwen Code', 'Alibaba', 'basic', 'missing', null],
    ],
  );
  // one not started on purpose (it starts when first used) is installed; one the registry doesn't know has no maker
  const more = presence({
    status: { codex: st('detecting', { idle: true }), claude: st('missing') },
    basicHarnesses: [basic('zz', 'Zz', 'missing')],
  } as any);
  assert.deepEqual(
    more.map((p) => [p.kind, p.state, p.vendor]),
    [
      ['codex', 'present', 'OpenAI'],
      ['claude', 'missing', 'Anthropic'],
      ['acp:zz', 'missing', ''],
    ],
  );
});

test('folded once something is installed, with the count; open when nothing is; gone when nothing is missing', async () => {
  calls.length = 0;
  store.setState({
    status: { codex: st('ready'), claude: st('missing') },
    basicHarnesses: [basic('qwen', 'Qwen Code', 'missing'), basic('cursor', 'Cursor CLI', 'missing'), basic('dsh', 'dsh', 'admitted')],
  });
  const v = await render(h(InstallHarnesses));
  assert.deepEqual(calls, [['tools']], 'what the lines need is asked when it shows');
  assert.equal(fold(v.host).textContent, 'Install another harness (3)');
  assert.equal(fold(v.host).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(cards(v.host), []);
  await click(fold(v.host));
  assert.deepEqual(cards(v.host), ['claude', 'acp:cursor', 'acp:qwen']);
  assert.match(v.host.textContent!, /Copy a command and run it in your terminal\. MoPilot picks the harness up once it's installed\./);
  await click(fold(v.host));
  assert.deepEqual(cards(v.host), []);
  // nothing installed yet: open from the start
  await set({ status: { codex: st('missing'), claude: st('missing') }, basicHarnesses: [] });
  await v.unmount();
  const empty = await render(h(InstallHarnesses));
  assert.equal(fold(empty.host).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(cards(empty.host), ['codex', 'claude']);
  await empty.unmount();
  // everything installed: nothing to fold out
  await set({ status: { codex: st('ready'), claude: st('ready') }, basicHarnesses: [basic('dsh', 'dsh', 'admitted')] });
  const none = await render(h(InstallHarnesses));
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
});

test('a harness just installed by a run keeps its card for the result; a card has its icon, maker, docs and CLI location', async () => {
  calls.length = 0;
  store.setState({ status: { codex: st('ready'), claude: st('ready') }, basicHarnesses: [basic('gemini', 'Gemini CLI', 'admitted')] });
  await act(async () => runs.setState({ runs: [{ id: 'r', kind: 'acp:gemini' }] }));
  const v = await render(h(InstallHarnesses));
  assert.equal(fold(v.host).textContent, 'Install another harness (0)');
  await click(fold(v.host));
  const card = v.host.querySelector('[data-install="acp:gemini"]') as HTMLElement;
  assert.equal(card.querySelector('[data-icon]')!.getAttribute('data-icon'), 'acp:gemini');
  assert.equal(card.querySelector('.install-vendor')!.textContent, 'Google');
  assert.equal(card.querySelector('[data-lines]')!.getAttribute('data-lines'), 'acp:gemini');
  await click(byText(card, 'Docs ↗'));
  // a basic harness's CLI location is set right on the card, from its foot or from a run's result
  assert.equal(card.querySelector('[data-binpath]'), null);
  await click(byText(card, 'Set location…'));
  assert.equal(card.querySelector('[data-binpath]')!.getAttribute('data-binpath'), 'gemini');
  await click(card.querySelector('[data-bin-set]'));
  await click(byText(card, 'Locate acp:gemini'));
  assert.deepEqual(calls.slice(1), [
    ['open', 'https://github.com/google-gemini/gemini-cli'],
    ['bin', 'gemini', '/opt/bin/gemini'],
  ]);
  await act(async () => runs.setState({ runs: [] }));
  await v.unmount();
});

test("a first-class card's CLI location is on its own page; a harness with no command here says where to get it", async () => {
  calls.length = 0;
  store.setState({
    status: { codex: st('missing'), claude: st('ready') },
    basicHarnesses: [basic('goose', 'Goose', 'missing')],
    prefs: { acpBins: { goose: '/x/goose' } },
  });
  const v = await render(h(InstallHarnesses));
  await click(fold(v.host));
  const codex = v.host.querySelector('[data-install="codex"]') as HTMLElement;
  assert.equal(codex.querySelector('[data-icon]')!.getAttribute('data-icon'), 'codex');
  await click(byText(codex, 'Set location…'));
  await click(byText(codex, 'Locate codex'));
  assert.deepEqual(calls.slice(1), [
    ['navigate', { name: 'settings', section: 'codex' }],
    ['navigate', { name: 'settings', section: 'codex' }],
  ]);
  assert.equal(codex.querySelector('[data-binpath]'), null);
  const goose = v.host.querySelector('[data-install="acp:goose"]') as HTMLElement;
  assert.equal(goose.querySelector('[data-lines]'), null);
  calls.length = 0;
  await click(byText(goose, 'Get it from AAIF ↗'));
  assert.deepEqual(calls, [['open', 'https://goose-docs.ai/docs/getting-started/installation']]);
  await click(byText(goose, 'Set location…'));
  assert.equal(goose.querySelector('[data-binpath]')!.textContent, '/x/goose');
  await v.unmount();
});

test('Antigravity installation explains the separate ACP server and locates that executable', async () => {
  calls.length = 0;
  store.setState({
    status: { codex: st('ready'), claude: st('ready') },
    basicHarnesses: [basic('antigravity', 'Antigravity', 'missing')],
    prefs: {},
  });
  const v = await render(h(InstallHarnesses));
  await click(fold(v.host));
  const card = v.host.querySelector('[data-install="acp:antigravity"]') as HTMLElement;
  assert.match(card.textContent!, /MoPilot uses the separate Antigravity ACP server with localharness_external beside it/);
  assert.equal(card.querySelector('[data-lines]'), null, 'do not offer the unrelated agy installer');
  await click(byText(card, 'Get it from Google ↗'));
  assert.deepEqual(calls.at(-1), ['open', 'https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp']);
  await click(byText(card, 'Set location…'));
  assert.equal(card.querySelector('[data-binpath]')!.getAttribute('data-binpath'), 'agy_acp_server.par');
  await v.unmount();
});

test('Re-check all asks again what the lines need and looks for each missing harness; a failed look says so', async () => {
  calls.length = 0;
  recheckFails = ['acp:qwen'];
  store.setState({
    status: { codex: st('ready'), claude: st('missing') },
    basicHarnesses: [basic('qwen', 'Qwen Code', 'missing')],
    prefs: {},
  });
  const v = await render(h(InstallHarnesses));
  await click(fold(v.host));
  calls.length = 0;
  await click(byText(v.host, 'Re-check all'));
  await act(async () => undefined);
  assert.deepEqual(calls, [
    ['tools'],
    ['recheck', 'claude'],
    ['recheck', 'acp:qwen'],
    ['toast', "Couldn't check for Qwen Code: probe failed", 'error'],
  ]);
  assert.equal(maybeText(v.host, 'Get it from'), null);
  recheckFails = [];
  await v.unmount();
});

test('a missing development harness without registry facts can still set its executable location', async () => {
  calls.length = 0;
  store.setState({
    status: { codex: st('ready'), claude: st('ready') },
    basicHarnesses: [basic('claude-acp', 'Claude Code (ACP)', 'missing')],
    prefs: {},
  });
  const v = await render(h(InstallHarnesses));
  await click(fold(v.host));
  const card = v.host.querySelector('[data-install="acp:claude-acp"]') as HTMLElement;
  assert.match(card.textContent!, /Install instructions aren't available/);
  await click(byText(card, 'Set location…'));
  assert.equal(card.querySelector('[data-binpath]')!.getAttribute('data-binpath'), 'claude-acp');
  await v.unmount();
});
