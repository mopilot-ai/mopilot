import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, settingsStubs, fakeStore } from './support/harness-ui-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
// a child page as a tag naming it and its string props
const stub = (name: string) => (p: any) =>
  h(
    'div',
    { 'data-c': name },
    Object.entries(p)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'boolean')
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
  );
const stubs = (...names: string[]) => Object.fromEntries(names.map((n) => [n, stub(n)]));
let claudeStatus: any = { state: 'ready', bin: '/bin/claude' };
const store = fakeStore({ ok: true });
let ensured = 0;
mock.module('../src/session/harness/select.ts', { namedExports: { useHarnessStatus: () => claudeStatus } });
stubStore({ useStore: store.useStore, codexUsable: (s: any) => s.ok, ensureCodex: async () => void ensured++ });
mock.module('../src/components/pages/Settings.tsx', {
  namedExports: { Group: settingsStubs.Group, Row: settingsStubs.Row, ...stubs('CloudSettings', 'CodexRuntime') },
});
mock.module('../src/components/pages/HarnessSettings.tsx', { namedExports: stubs('InstructionsEditor') });
mock.module('../src/components/ui/icons.tsx', {
  namedExports: { ChevronDown: () => h('i', null, 'v'), ChevronRight: () => h('i', null, '>') },
});
mock.module('../src/components/harness/Overview.tsx', { namedExports: stubs('HarnessHeader', 'AccountCard') });
mock.module('../src/components/harness/WhatWorks.tsx', { namedExports: stubs('WhatWorks') });
mock.module('../src/components/pages/settings/HarnessPage.tsx', {
  namedExports: {
    ModelsAndBilling: stub('ModelsAndBilling'),
    HarnessTabs: ({ value, onChange }: any) =>
      h(
        'nav',
        { 'data-tab': value },
        ['overview', 'extensions', 'advanced'].map((t) => h('button', { key: t, id: `tab-${t}`, onClick: () => onChange(t) }, t)),
      ),
  },
});
mock.module('../src/components/pages/Login.tsx', { namedExports: stubs('NeedsCodex') });
mock.module('../src/components/harness/claude/parts.tsx', { namedExports: stubs('ClaudeAdvanced') });
mock.module('../src/components/harness/claude/Extensions.tsx', { namedExports: stubs('ClaudeExtensions') });
mock.module('../src/components/harness/codex/settings.tsx', {
  namedExports: stubs('Configuration', 'Hooks', 'ImportSection', 'Personalization'),
});
mock.module('../src/components/harness/codex/PluginSettings.tsx', { namedExports: stubs('PluginSettings') });
const { ClaudePage } = await import('../src/components/harness/claude/Page.tsx');
const { CodexPage } = await import('../src/components/harness/codex/Page.tsx');

// the page's sections; the header above the tabs is checked on its own
const shown = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-c]:not([data-c="HarnessHeader"])')].map(
    (e) => `${e.getAttribute('data-c')}${e.textContent ? `(${e.textContent})` : ''}`,
  );
const tab = (host: HTMLElement, t: string) => click(host.querySelector(`#tab-${t}`));

test('the Claude Code page opens the asked tab, falls back to the overview, and switches tabs', async () => {
  let r = await mount(h(ClaudePage, { tab: 'nope' }));
  assert.equal(r.host.querySelector('nav')?.getAttribute('data-tab'), 'overview');
  assert.equal(r.host.querySelector('[data-c="HarnessHeader"]')?.textContent, 'h=claude');
  // Overview holds the account, the defaults, the instructions (whose editor opens on Edit) and what it lacks
  const overview = ['AccountCard(h=claude)', 'ModelsAndBilling(h=claude)', 'WhatWorks(kind=claude label=Claude Code)'];
  assert.deepEqual(shown(r.host), overview);
  assert.equal(r.host.querySelector('h3')?.textContent, 'Instructions');
  const row = [...r.host.querySelectorAll('.row')].find((e) => e.querySelector('b')?.textContent === 'CLAUDE.md')!;
  assert.equal(row.querySelector('i')?.textContent, 'Your instructions for every chat. Project instructions also apply.');
  await click(row.querySelector('button'));
  assert.deepEqual(shown(r.host), [
    'AccountCard(h=claude)',
    'ModelsAndBilling(h=claude)',
    'InstructionsEditor(kind=claude placeholder=e.g. Prefer small, reviewable diffs.)',
    'WhatWorks(kind=claude label=Claude Code)',
  ]);
  assert.equal(row.querySelector('button')?.textContent, 'Done');
  await click(row.querySelector('button'));
  assert.deepEqual(shown(r.host), overview);
  await tab(r.host, 'advanced');
  assert.deepEqual(shown(r.host), ['ClaudeAdvanced']);
  await r.unmount();

  r = await mount(h(ClaudePage, { tab: 'extensions' }));
  assert.deepEqual(shown(r.host), ['ClaudeExtensions(bin=/bin/claude)']);
  await r.unmount();
  for (const st of [
    { state: 'apikey', bin: '/k' },
    { state: 'signin', bin: '/s' },
    { state: 'ready', bin: null },
  ]) {
    claudeStatus = st;
    r = await mount(h(ClaudePage, { tab: 'extensions' }));
    if (st.state === 'apikey') assert.deepEqual(shown(r.host), ['ClaudeExtensions(bin=/k)']);
    else assert.equal(r.host.querySelector('.row b')?.textContent, 'Available once Claude Code is installed and signed in');
    await r.unmount();
    // what works in MoPilot is said once Claude Code can run (signed in, or on a key)
    r = await mount(h(ClaudePage, {}));
    assert.equal(shown(r.host).includes('WhatWorks(kind=claude label=Claude Code)'), st.state !== 'signin', st.state);
    await r.unmount();
  }
});

test('the Codex page connects once and shows each tab, or what needs Codex while it is unusable', async () => {
  store.set({ ok: true });
  const r = await mount(h(CodexPage, {}));
  assert.equal(ensured, 1);
  assert.equal(r.host.querySelector('[data-c="HarnessHeader"]')?.textContent, 'h=codex');
  // what works in MoPilot comes last, as on every harness's page
  const tail = ['WhatWorks(kind=codex label=Codex)'];
  assert.deepEqual(shown(r.host), [
    'AccountCard(h=codex)',
    'ModelsAndBilling(h=codex)',
    'Configuration(part=models)',
    'Personalization',
    ...tail,
  ]);
  await tab(r.host, 'extensions');
  assert.deepEqual(shown(r.host), ['PluginSettings', 'Hooks', 'ImportSection']);
  await tab(r.host, 'advanced');
  assert.deepEqual(shown(r.host), ['CodexRuntime', 'Configuration(part=cli)', 'CloudSettings']);
  store.set({ ok: false });
  await tab(r.host, 'advanced');
  assert.deepEqual(shown(r.host), ['CodexRuntime', 'NeedsCodex(what=Codex’s configuration and cloud settings.)']);
  await tab(r.host, 'extensions');
  assert.deepEqual(shown(r.host), ['NeedsCodex(what=Codex plugins, skills, MCP servers and hooks.)']);
  await tab(r.host, 'overview');
  // nothing said of what works while Codex can't run
  assert.deepEqual(shown(r.host), [
    'AccountCard(h=codex)',
    'ModelsAndBilling(h=codex)',
    'NeedsCodex(what=Codex’s models, memory and configuration.)',
    'Personalization',
  ]);
  await r.unmount();
  // an old tab that is no longer one of the three opens on Overview, which now holds it
  const r2 = await mount(h(CodexPage, { tab: 'instructions' }));
  assert.equal(r2.host.querySelector('nav')?.getAttribute('data-tab'), 'overview');
  assert.ok(shown(r2.host).includes('Personalization'));
  await r2.unmount();
});
