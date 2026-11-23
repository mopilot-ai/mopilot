// The Customize sidebar and route with store plugins: the store first, Codex's copies of them left out, and their page.
import { test } from 'node:test';
import {
  assert,
  mount,
  click,
  flush,
  byText,
  h,
  calls,
  P,
  setPlugins,
  reset,
  pl,
  mountCodexTab,
  setStorePlugins,
} from './support/codex-plugin-ui.ts';

test('the sidebar lists the store first, without built-ins, unreadable ones or Codex copies of store plugins', async () => {
  await reset();
  const spec = (name: string) => ({ name, displayName: name, skills: [], commands: [], agents: [], hooks: [], mcpServers: {}, apps: [] });
  setStorePlugins([
    { id: 'tidy-up@acme', enabled: true, harnesses: {}, spec: spec('tidy-up') },
    { id: 'mopilot@mopilot', origin: 'builtin', enabled: true, harnesses: {}, spec: spec('mopilot') },
    { id: 'broken@acme', enabled: true, harnesses: {}, spec: null, error: 'gone' },
  ]);
  try {
    const r = await mount(h(P.PluginsNav, {}));
    await flush();
    await setPlugins({
      plugins: [
        pl('routines', { installed: true, marketplace: 'mopilot-mopilot', marketplacePath: '/home/.mopilot/plugins/cache/mopilot' }),
        pl('own-tools', { installed: true, marketplace: 'mopilot-tools', marketplacePath: '/home/tools' }),
        pl('tidy-up', { installed: true, marketplace: 'other' }),
        pl('calendar', { installed: true }),
      ],
    });
    await flush();
    const labels = () => [...r.host.querySelectorAll('.side-row-label')].map((l) => l.textContent);
    assert.deepEqual(labels(), ['Plugins', 'Skills', 'Tidy Up', 'Own Tools', 'Calendar']);
    calls.length = 0;
    await click(byText(r.host, '.side-row', 'Tidy Up'));
    assert.deepEqual(calls, [['navigate', { name: 'plugins', plugin: 'store:tidy-up@acme' }]]);
    await r.render(h(P.PluginsNav, { plugin: 'store:tidy-up@acme' }));
    assert.deepEqual(
      [...r.host.querySelectorAll('.side-row.selected')].map((b) => b.textContent),
      ['Tidy Up'],
    );
    await r.unmount();
  } finally {
    setStorePlugins([]);
  }
});

test("a store plugin's route opens its page on any tab, with no harness tabs; a mirror stays off the Codex tab", async () => {
  await reset();
  const r = await mount(h(P.Plugins, { plugin: 'store:tidy@acme' }));
  assert.equal(r.host.querySelector('#store-plugin')!.textContent, 'tidy@acme');
  assert.equal(r.host.querySelector('[data-seg=codex]'), null);
  await r.unmount();
  const tab = await mountCodexTab();
  await setPlugins({
    plugins: [
      pl('mirrored', { marketplace: 'mopilot-acme', marketplacePath: '/home/.mopilot/plugins/cache/acme' }),
      pl('mine', { marketplace: 'personal' }),
    ],
  });
  await click(byText(tab.host, 'button', 'Personal'));
  assert.ok(byText(tab.host, '.plugin-name', 'Mine'));
  assert.equal(byText(tab.host, '.plugin-name', 'Mirrored'), undefined);
  await tab.unmount();
});

test("marketplaces the user added: not bundled, pathless, OpenAI's or a mirror; a name alone does not make a mirror", async () => {
  const { isUserMarketplace, isMirrored } = await import('../src/components/harness/codex/plugins/marketplaceKinds.ts');
  assert.equal(isUserMarketplace({ name: 'zeta', path: '/z' }), true);
  assert.equal(isUserMarketplace({ name: 'mopilot-tools', path: '/home/tools' }), true);
  assert.equal(isUserMarketplace({ name: 'nopath' }), false);
  assert.equal(isUserMarketplace({ name: 'openai-bundled', path: '/b' }), false);
  assert.equal(isUserMarketplace({ name: 'openai-curated', path: '/c' }), false);
  assert.equal(isUserMarketplace({ name: 'mopilot-acme', path: '/h/.mopilot/plugins/cache/acme' }), false);
  assert.equal(isMirrored('mopilot-acme'), false);
  assert.equal(isMirrored('mopilot-acme', 'C:\\h\\plugins\\cache\\acme'), true);
});
