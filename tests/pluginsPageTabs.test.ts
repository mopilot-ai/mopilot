import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, settingsStubs } from './support/harness-ui-kit.ts';

const { createElement: h } = await import('react');
const stub = (name: string) => () => h('div', { 'data-page': name });
const stubs = (...names: string[]) => Object.fromEntries(names.map((n) => [n, stub(n)]));
mock.module('../src/components/harness/codex/SkillsCatalog.tsx', { namedExports: stubs('SkillsCatalog') });
mock.module('../src/components/harness/codex/plugins/PluginCatalog.tsx', { namedExports: stubs('PluginCatalog') });
mock.module('../src/components/harness/codex/plugins/PluginPage.tsx', {
  namedExports: { PluginPage: ({ id }: any) => h('div', { 'data-page': `PluginPage:${id}` }) },
});
mock.module('../src/components/harness/codex/plugins/catalog.ts', {
  namedExports: {
    BUNDLED: [],
    usePlugins: () => null,
    loadPlugins() {},
    ensurePlugins() {},
    isPublic() {},
    nameOf() {},
    openPlugin() {},
    toggleInstalled() {},
    createPlugin() {},
  },
});
mock.module('../src/components/harness/codex/plugins/PluginLogo.tsx', { namedExports: stubs('PluginLogo') });
mock.module('../src/components/harness/codex/plugins/PluginsNav.tsx', { namedExports: stubs('PluginsNav') });
mock.module('../src/components/harness/codex/plugins/MarketplaceDialog.tsx', { namedExports: stubs('MarketplaceDialog') });
mock.module('../src/components/plugins/StorePage.tsx', { namedExports: stubs('StorePage') });
mock.module('../src/components/skills/AllSkills.tsx', {
  namedExports: { AllSkills: ({ codexOk }: any) => h('div', { 'data-page': 'AllSkills', 'data-codex': String(codexOk) }) },
});
mock.module('../src/components/plugins/PluginDetail.tsx', {
  namedExports: { PluginDetail: ({ id }: any) => h('div', { 'data-page': `PluginDetail:${id}` }) },
});
mock.module('../src/components/pages/Login.tsx', { namedExports: stubs('CodexNotice') });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Segmented: settingsStubs.Segmented } });
mock.module('../src/components/harness/parts.tsx', {
  namedExports: { PARTS: { codex: {}, claude: { Customize: ({ tab }: any) => h('div', { 'data-page': `Claude:${tab}` }) } } },
});
const { Plugins } = await import('../src/components/harness/codex/Plugins.tsx');

const page = (host: HTMLElement) => host.querySelector('[data-page]')?.getAttribute('data-page');
const seg = (host: HTMLElement, v: string) => click(host.querySelector(`[data-seg="${v}"]`));
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[data-seg]')].map((b) => b.getAttribute('data-seg'));

test('Skills and Plugins both open on All harnesses; each remembers the tab picked on it', async () => {
  const r = await mount(h(Plugins, { tab: 'skills' }));
  assert.deepEqual(tabs(r.host), ['all', 'codex', 'claude']);
  assert.equal(page(r.host), 'AllSkills');
  await seg(r.host, 'codex');
  assert.equal(page(r.host), 'SkillsCatalog');
  await seg(r.host, 'claude');
  assert.equal(page(r.host), 'Claude:skills');
  await r.render(h(Plugins, { tab: 'plugins' }));
  assert.equal(page(r.host), 'StorePage');
  await seg(r.host, 'codex');
  assert.equal(page(r.host), 'PluginCatalog');
  await r.render(h(Plugins, { tab: 'skills' }));
  assert.equal(page(r.host), 'Claude:skills');
  await seg(r.host, 'all');
  assert.equal(page(r.host), 'AllSkills');
});

test('without Codex its tabs say so; a plugin route opens its page with no tabs', async () => {
  const r = await mount(h(Plugins, { tab: 'plugins', codexOk: false }));
  await seg(r.host, 'codex');
  assert.equal(page(r.host), 'CodexNotice');
  await r.render(h(Plugins, { tab: 'skills', codexOk: false }));
  assert.equal(r.host.querySelector('[data-codex]')?.getAttribute('data-codex'), 'false');
  await r.render(h(Plugins, { tab: 'plugins', plugin: 'store:acme@m' }));
  assert.equal(page(r.host), 'PluginDetail:acme@m');
  assert.equal(r.host.querySelector('[data-seg]'), null);
  await r.render(h(Plugins, { tab: 'plugins', plugin: 'gmail', codexOk: false }));
  assert.equal(page(r.host), 'CodexNotice');
  await r.render(h(Plugins, { tab: 'plugins', plugin: 'gmail', codexOk: true }));
  assert.equal(page(r.host), 'PluginPage:gmail');
});
