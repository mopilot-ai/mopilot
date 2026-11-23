// Native-plugin catalog navigation, actions and logo rendering.
import { test } from 'node:test';
import {
  assert,
  mount,
  click,
  change,
  flush,
  byText,
  h,
  act,
  calls,
  handlers,
  store,
  P,
  setPlugins,
  reset,
  pl,
  sent,
  titles,
  sectionNames,
  mountCodexTab,
  setDark,
} from './support/codex-plugin-ui.ts';
const { usePlugins } = P;

test('the public plugin entrypoint and extracted catalog share the same cache and actions', async () => {
  const catalog = await import('../src/components/harness/codex/plugins/catalog.ts');
  assert.equal(P.usePlugins, catalog.usePlugins);
  assert.equal(P.loadPlugins, catalog.loadPlugins);
  assert.equal(P.ensurePlugins, catalog.ensurePlugins);
  assert.equal(P.toggleInstalled, catalog.toggleInstalled);
  assert.equal(P.createPlugin, catalog.createPlugin);
  assert.equal(P.openPlugin, catalog.openPlugin);
});

test('loadPlugins flattens marketplaces once, reloads on demand, and is empty after a failure', async () => {
  await reset();
  handlers['plugin/list'] = async () => ({
    marketplaces: [{ name: 'm1', path: '/m1', plugins: [{ id: 'a', name: 'a' }] }, { name: 'm2' }],
    featuredPluginIds: ['a'],
  });
  await P.loadPlugins();
  assert.deepEqual(usePlugins.getState(), {
    plugins: [{ id: 'a', name: 'a', marketplace: 'm1', marketplacePath: '/m1' }],
    featured: ['a'],
    loading: false,
    error: null,
  });
  await P.loadPlugins();
  assert.deepEqual(sent(), ['plugin/list']);
  handlers['plugin/list'] = async () => ({});
  await P.loadPlugins(true);
  assert.deepEqual(usePlugins.getState(), { plugins: [], featured: [], loading: false, error: null });
  usePlugins.setState({ loading: true });
  await P.loadPlugins(true);
  assert.equal(sent().length, 2);
  usePlugins.setState({ loading: false });
  handlers['plugin/list'] = async () => {
    throw new Error('x');
  };
  await P.loadPlugins(true);
  assert.deepEqual(usePlugins.getState().plugins, []);
  assert.equal(usePlugins.getState().loading, false);
  // the failure is kept, so the pages say why the catalog is empty
  assert.equal(usePlugins.getState().error, 'X.');
  // and a catalog that failed is asked again by the next page that opens, not taken as loaded
  handlers['plugin/list'] = async () => ({ marketplaces: [{ name: 'm1', plugins: [{ id: 'b', name: 'b' }] }] });
  const asked = sent().length;
  await P.loadPlugins();
  assert.equal(sent().length, asked + 1);
  assert.deepEqual(usePlugins.getState().plugins, [{ id: 'b', name: 'b', marketplace: 'm1', marketplacePath: undefined }]);
  assert.equal(usePlugins.getState().error, null);
});

test("a catalog that couldn't load says why on the catalog, the plugin page and Create plugin", async () => {
  await reset();
  handlers['plugin/list'] = async () => {
    throw new Error("Error invoking remote method 'codex:request': Error: not signed in");
  };
  const r = await mountCodexTab();
  await flush();
  assert.equal(r.host.querySelector('.center-pad.settings-row-desc')?.textContent, "Couldn't load plugins: Not signed in.");
  await r.unmount();
  // a plugin page waits for the catalog, and a catalog that failed never lists it: no endless spinner
  const page = await mount(h(P.Plugins, { plugin: 'stripe@openai-curated' }));
  await flush();
  assert.equal(page.host.querySelector('.center-fill .spin'), null);
  assert.equal(page.host.querySelector('.center-fill')?.textContent, "Couldn't load plugins: Not signed in.");
  await page.unmount();
  calls.length = 0;
  await P.createPlugin();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't load plugins: Not signed in.", 'error']);
});

test('names, public marketplaces and logos', async () => {
  assert.equal(P.nameOf(pl('frontend-design_kit')), 'Frontend Design Kit');
  assert.equal(P.nameOf(pl('x', { interface: { displayName: 'Shown' } })), 'Shown');
  assert.equal(P.isPublic(pl('x')), true);
  assert.equal(P.isPublic(pl('x', { marketplace: 'mine' })), false);
  const logo = async (iface: any, isDark: boolean) => {
    setDark(isDark);
    const r = await mount(h(P.PluginLogo, { p: pl('x', { interface: iface }) }));
    const out = [
      r.host.querySelector('img')?.getAttribute('src') ?? null,
      (r.host.querySelector('.plugin-logo') as HTMLElement).style.background || null,
    ];
    await r.unmount();
    return out;
  };
  assert.deepEqual(await logo({ logoUrlDark: 'https://d', logoUrl: 'https://l' }, true), ['https://d', null]);
  assert.deepEqual(await logo({ logoUrlDark: 'https://d', logoUrl: 'https://l' }, false), ['https://l', null]);
  assert.deepEqual(await logo({ logoDark: '/a b/dark.png', logo: '/l.png' }, true), ['codex-asset:///a%20b/dark.png', null]);
  assert.deepEqual(await logo({ logoDark: '/dark.png', logo: '/l.png' }, false), ['codex-asset:///l.png', null]);
  assert.deepEqual(await logo({ composerIcon: '/c.png' }, true), ['codex-asset:///c.png', null]);
  // a Windows path, and a name with # in it: the protocol handler gets the whole path (not a host, not a fragment)
  assert.deepEqual(await logo({ logo: 'C:\\Users\\me\\logo.png' }, false), ['codex-asset:///C:/Users/me/logo.png', null]);
  assert.deepEqual(await logo({ logo: '/p/#1.png' }, false), ['codex-asset:///p/%231.png', null]);
  assert.deepEqual(await logo({ brandColor: 'red' }, false), [null, 'red']);
  assert.deepEqual(await logo(undefined, false), [null, null]);
  setDark(false);
  const r = await mount(h(P.PluginLogo, { p: pl('x', { interface: { logoUrl: 'https://broken', brandColor: 'blue' } }), size: 20 }));
  await act(async () => {
    r.host.querySelector('img')!.dispatchEvent(new (window as any).Event('error'));
  });
  assert.equal(r.host.querySelector('img'), null);
  assert.ok(r.host.querySelector('.blocks'));
  assert.equal((r.host.querySelector('.plugin-logo') as HTMLElement).style.background, 'blue');
  await r.unmount();
});

test('the sidebar lists plugins the user installed, newest first, and navigates', async () => {
  await reset();
  handlers['plugin/list'] = () => new Promise(() => {});
  const r = await mount(h(P.PluginsNav, {}));
  assert.ok(byText(r.host, '.side-row', 'Loading…'));
  assert.deepEqual(
    [...r.host.querySelectorAll('.side-row.selected')].map((b) => b.textContent),
    ['Plugins'],
  );
  await setPlugins({
    plugins: [
      pl('none', { installed: true }),
      pl('old', { installed: true, installedAt: 1 }),
      pl('mid', { installed: true, installedAt: 3 }),
      pl('new', { installed: true, installedAt: 5 }),
      pl('new', { installed: true, id: 'dup' }),
      pl('undated', { installed: true }),
      pl('bundled', { installed: true, marketplace: 'openai-bundled' }),
      pl('default', { installed: true, installPolicy: 'INSTALLED_BY_DEFAULT' }),
      pl('avail'),
    ],
  });
  const labels = () => [...r.host.querySelectorAll('.side-row-label')].map((l) => l.textContent);
  assert.deepEqual(labels(), ['Plugins', 'Skills', 'New', 'Mid', 'Old', 'None', 'Undated']);
  calls.length = 0;
  await click(byText(r.host, '.side-row', 'Skills'));
  await click(byText(r.host, '.side-row', 'Old'));
  assert.deepEqual(calls, [
    ['navigate', { name: 'plugins', tab: 'skills' }],
    ['navigate', { name: 'plugins', plugin: 'old@openai-curated' }],
  ]);
  await r.render(h(P.PluginsNav, { tab: 'skills', plugin: 'old@openai-curated' }));
  assert.deepEqual(
    [...r.host.querySelectorAll('.side-row.selected')].map((b) => b.textContent),
    ['Old'],
  );
  await r.render(h(P.PluginsNav, { tab: 'skills' }));
  assert.deepEqual(
    [...r.host.querySelectorAll('.side-row.selected')].map((b) => b.textContent),
    ['Skills'],
  );
  await r.unmount();
});

test('Plugins opens on every harness at once (the store), and so does Skills', async () => {
  await reset();
  const r = await mount(h(P.Plugins, {}));
  assert.ok(r.host.querySelector('#store'));
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-seg]')].map((b: any) => b.dataset.seg),
    ['all', 'codex', 'claude'],
  );
  assert.equal(r.host.querySelector('[data-seg=all]')!.getAttribute('aria-pressed'), 'true');
  await r.render(h(P.Plugins, { tab: 'skills' }));
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-seg]')].map((b: any) => b.dataset.seg),
    ['all', 'codex', 'claude'],
  );
  assert.ok(r.host.querySelector('#all-skills'), 'Skills lists every harness at once too');
  await click(r.host.querySelector('[data-seg=claude]')); // each page keeps its pick: Plugins is still All
  assert.ok(r.host.querySelector('#claude-custom'));
  await r.render(h(P.Plugins, {}));
  assert.ok(r.host.querySelector('#store'));
  await r.render(h(P.Plugins, { tab: 'skills' }));
  assert.ok(r.host.querySelector('#claude-custom'));
  await r.unmount();
});

test('the page shows the picked harness tab and its view', async () => {
  await reset();
  await setPlugins({ plugins: [], featured: [] });
  store.set({ harness: 'claude' });
  const r = await mount(h(P.Plugins, { tab: 'skills' }));
  await click(r.host.querySelector('[data-seg=claude]'));
  assert.equal(r.host.querySelector('#claude-custom')?.textContent, 'skills');
  await click(r.host.querySelector('[data-seg=codex]'));
  assert.ok(r.host.querySelector('#skills'));
  await r.render(h(P.Plugins, { codexOk: false }));
  await click(r.host.querySelector('[data-seg=codex]'));
  assert.match(r.host.querySelector('#notice')!.textContent!, /need Codex/);
  await r.render(h(P.Plugins, {}));
  assert.equal(r.host.querySelector('.page-title')?.textContent, 'Plugins');
  await r.unmount();
  store.set({ harness: 'codex' });
  const r2 = await mount(h(P.Plugins, { plugin: 'nope' }));
  assert.equal(r2.host.querySelector('.ext-harness-tabs'), null);
  assert.ok(r2.host.querySelector('.center-fill .spin'));
  await r2.unmount();
});

test('the catalog: featured, installed, categories, search, scopes and a category page', async () => {
  await reset();
  handlers['plugin/list'] = () => new Promise(() => {});
  const r = await mountCodexTab();
  assert.ok(r.host.querySelector('.center-pad .spin'));
  const many = Array.from({ length: 7 }, (_, i) =>
    pl(`inst-${i}`, { installed: true, interface: { category: 'Dev', shortDescription: `tool ${i}` } }),
  );
  await setPlugins({
    loading: true,
    featured: ['feat@openai-curated', 'missing'],
    plugins: [
      pl('feat', { interface: { category: 'Design' } }),
      pl('feat', { id: 'dupe' }),
      ...many,
      pl('plain'),
      pl('mine', { marketplace: 'local' }),
    ],
  });
  assert.ok(r.host.querySelector('.icon-btn .spin'));
  assert.deepEqual(titles(r.host), ['Featured', 'Installed', 'Dev', 'Design', 'Other']);
  assert.deepEqual(sectionNames(r.host, 'Featured'), ['Feat']);
  assert.equal(sectionNames(r.host, 'Installed').length, 6);
  assert.equal(sectionNames(r.host, 'Other')[0], 'Plain');
  assert.equal(r.host.querySelector('.plugin-desc')?.textContent, 'openai-curated');
  // section titles only open real categories
  await click(byText(r.host, '.plugin-section-title', 'Featured'));
  await click(byText(r.host, '.plugin-section-title', 'Installed'));
  assert.equal(r.host.querySelector('.crumb'), null);
  await click(byText(r.host, '.plugin-section-title', 'Dev'));
  assert.deepEqual(titles(r.host), ['Dev']);
  assert.equal(sectionNames(r.host, 'Dev').length, 7);
  await click(r.host.querySelector('.crumb'));
  await click(byText(r.host, '.plugin-section-title', 'Other'));
  assert.deepEqual(sectionNames(r.host, 'Other'), ['Plain']);
  await click(byText(r.host, '.tabs-seg button', 'Personal'));
  assert.equal(r.host.querySelector('.crumb'), null);
  assert.deepEqual(titles(r.host), ['Other']);
  assert.deepEqual(sectionNames(r.host, 'Other'), ['Mine']);
  await click(byText(r.host, '.tabs-seg button', 'Public'));

  const search = r.host.querySelector('input[placeholder="Search plugins"]');
  await change(search, 'TOOL 3');
  assert.deepEqual(titles(r.host), ['Results']);
  assert.deepEqual(sectionNames(r.host, 'Results'), ['Inst 3']);
  await change(search, 'plain');
  assert.deepEqual(sectionNames(r.host, 'Results'), ['Plain']);
  await change(search, 'zzz');
  assert.equal(r.host.querySelector('.plugin-section .settings-row-desc')?.textContent, 'No plugins');
  await change(search, ' ');
  assert.deepEqual(titles(r.host), ['Featured', 'Installed', 'Dev', 'Design', 'Other']);

  handlers['plugin/list'] = async () => ({ marketplaces: [] });
  await setPlugins({ loading: false });
  calls.length = 0;
  await click(r.host.querySelectorAll('.plugins-tools .icon-btn')[0]);
  await click(r.host.querySelectorAll('.plugins-tools .icon-btn')[1]);
  await flush();
  assert.deepEqual(calls.slice(0, 1), [['plugin/list', {}]]);
  assert.deepEqual(
    calls.find((c) => c[0] === 'navigate'),
    ['navigate', { name: 'settings', section: 'plugins' }],
  );
  await r.unmount();
});

test('rows install, open, and uninstall plugins, reporting failures', async () => {
  await reset();
  handlers['plugin/list'] = async () => ({
    marketplaces: [
      { name: 'openai-curated', plugins: [pl('tool'), pl('gone', { installed: true }), pl('locked', { availability: 'UNAVAILABLE' })] },
      { name: 'own', path: '/own', plugins: [pl('local')] },
    ],
  });
  await P.loadPlugins(true);
  const r = await mountCodexTab();
  const row = (n: string) => byText(r.host, '.plugin-row', new RegExp(`^${n}`))!;
  assert.equal(row('Locked').querySelector('[aria-label=Install]')?.hasAttribute('disabled'), true);

  let finish!: () => void;
  handlers['plugin/install'] = () => new Promise<void>((res) => (finish = res));
  calls.length = 0;
  await click(row('Tool').querySelector('[aria-label=Install]'));
  assert.ok(row('Tool').querySelector('.spin'));
  await act(async () => finish());
  await flush();
  assert.equal(calls[0][0], 'plugin/install');
  const { installAttemptId, ...rest } = calls[0][1];
  assert.deepEqual(rest, { marketplacePath: undefined, remoteMarketplaceName: 'openai-curated', pluginName: 'tool' });
  assert.match(installAttemptId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.slice(1), [
    ['plugin/list', {}],
    ['toast', 'Installed Tool'],
  ]);
  assert.equal(
    calls.some((c) => c[0] === 'navigate'),
    false,
  );

  for (const [err, text] of [
    [new Error('denied'), 'denied'],
    ['raw', 'raw'],
  ] as const) {
    handlers['plugin/uninstall'] = async () => {
      throw err;
    };
    calls.length = 0;
    await click(row('Gone').querySelector('[aria-label="Plugin actions"]'));
    await click(byText(row('Gone'), '[role=menuitem]', 'Uninstall'));
    assert.equal(row('Gone').querySelector('[role=menu]'), null);
    await flush();
    // the menu is a portal: its click must not bubble on to the row and open the plugin
    assert.deepEqual(calls, [
      ['plugin/uninstall', { pluginId: 'gone@openai-curated' }],
      ['toast', text, 'error'],
    ]);
  }
  handlers['plugin/uninstall'] = async () => ({});
  calls.length = 0;
  await click(row('Gone').querySelector('[aria-label="Plugin actions"]'));
  await click(byText(row('Gone'), '[role=menuitem]', 'Uninstall'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'Removed Gone']);
  calls.length = 0;
  await click(row('Gone').querySelector('[aria-label="Plugin actions"]'));
  await click(byText(row('Gone'), '[role=menuitem]', 'Details'));
  assert.deepEqual(calls, [['navigate', { name: 'plugins', plugin: 'gone@openai-curated' }]]);
  calls.length = 0;
  await click(row('Tool'));
  assert.deepEqual(calls, [['navigate', { name: 'plugins', plugin: 'tool@openai-curated' }]]);
  // the row opens with Enter as well; Enter on its Install button is the button's
  calls.length = 0;
  const enter = (el: Element) =>
    act(async () => void el.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.equal(row('Tool').getAttribute('role'), 'button');
  assert.equal(row('Tool').getAttribute('aria-label'), 'Tool', 'named apart from its Install button');
  await enter(row('Tool'));
  await enter(row('Tool').querySelector('[aria-label=Install]')!);
  assert.deepEqual(calls, [['navigate', { name: 'plugins', plugin: 'tool@openai-curated' }]]);
  await r.unmount();

  calls.length = 0;
  handlers['plugin/install'] = async () => ({});
  await P.toggleInstalled(pl('local', { marketplace: 'own', marketplacePath: '/own' }));
  assert.equal((calls[0][1] as any).marketplacePath, '/own');
  assert.equal((calls[0][1] as any).remoteMarketplaceName, undefined);
});

test('Add → Create plugin installs the Plugin Creator when needed and starts a chat with it', async () => {
  await reset();
  handlers['plugin/list'] = async () => ({
    marketplaces: [{ name: 'local', plugins: [{ id: 'pc-local', name: 'plugin-creator', installed: true }] }],
  });
  const r = await mountCodexTab();
  await flush();
  await click(byText(r.host, '.btn-white', 'Add'));
  calls.length = 0;
  await click(byText(r.host, '[role=menuitem]', 'Create plugin'));
  await flush();
  assert.deepEqual(calls, [['toast', 'Plugin Creator isn’t available for this account', 'error']]);
  await r.unmount();

  const events: any[] = [];
  const onMention = (e: any) => events.push(['mention', e.detail]);
  const onInsert = (e: any) => events.push(['insert', e.detail]);
  window.addEventListener('insert-mention', onMention);
  window.addEventListener('composer-insert', onInsert);
  try {
    await setPlugins({ plugins: [pl('plugin-creator')] });
    handlers['plugin/install'] = async () => ({});
    handlers['plugin/list'] = async () => ({
      marketplaces: [{ name: 'openai-curated', plugins: [pl('plugin-creator', { installed: true })] }],
    });
    calls.length = 0;
    await P.createPlugin();
    assert.deepEqual(sent(), ['plugin/install', 'plugin/list']);
    assert.deepEqual(calls.slice(-2), [
      ['toast', 'Installed Plugin Creator'],
      ['navigate', { name: 'home' }],
    ]);
    calls.length = 0;
    await P.createPlugin();
    assert.deepEqual(calls, [['navigate', { name: 'home' }]]);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(events, [
      ['mention', { name: 'Plugin Creator', path: 'plugin://plugin-creator@openai-curated' }],
      ['insert', 'help me create a plugin'],
      ['mention', { name: 'Plugin Creator', path: 'plugin://plugin-creator@openai-curated' }],
      ['insert', 'help me create a plugin'],
    ]);
    for (const [err, text] of [
      [new Error('no'), 'No.'],
      ['raw', 'Raw.'],
    ] as const) {
      await setPlugins({ plugins: [pl('plugin-creator')] });
      handlers['plugin/install'] = async () => {
        throw err;
      };
      calls.length = 0;
      await P.createPlugin();
      assert.deepEqual(calls.at(-1), ['toast', text, 'error']);
    }
  } finally {
    window.removeEventListener('insert-mention', onMention);
    window.removeEventListener('composer-insert', onInsert);
  }
});

test('Add → Add a marketplace: the form adds it and closes, or says why not', async () => {
  await reset();
  await setPlugins({ plugins: [] });
  const r = await mountCodexTab();
  const dialog = () => r.host.querySelector('[role=dialog]') as HTMLElement | null;
  const open = async () => {
    await click(byText(r.host, '.btn-white', 'Add'));
    await click(byText(r.host, '[role=menuitem]', 'Add a marketplace'));
  };
  const submit = () =>
    act(async () => {
      dialog()!.dispatchEvent(new (window as any).Event('submit', { bubbles: true, cancelable: true }));
    });
  await open();
  assert.ok(dialog());
  const [source, ref] = dialog()!.querySelectorAll('input');
  const sparse = dialog()!.querySelector('textarea');
  assert.equal(byText(dialog()!, 'button', 'Add marketplace')?.hasAttribute('disabled'), true);
  calls.length = 0;
  await submit();
  assert.deepEqual(calls, []);
  await click(byText(dialog()!, 'a', 'Learn more'));
  assert.deepEqual(calls, [['open', 'https://developers.openai.com/codex/plugins']]);

  let release!: (v: any) => void;
  handlers['marketplace/add'] = () => new Promise((res) => (release = res));
  handlers['plugin/list'] = async () => ({});
  await change(source, ' openai/plugins ');
  await change(ref, ' dev ');
  await change(sparse, 'a, b\n\nc');
  calls.length = 0;
  await submit();
  await submit();
  assert.deepEqual(calls, [['marketplace/add', { source: 'openai/plugins', refName: 'dev', sparsePaths: ['a', 'b', 'c'] }]]);
  assert.equal(byText(dialog()!, 'button', 'Add marketplace')?.hasAttribute('disabled'), true);
  await act(async () => release({ marketplaceName: 'Plugins' }));
  await flush();
  assert.deepEqual(calls.slice(1), [
    ['plugin/list', {}],
    ['toast', 'Added Plugins'],
  ]);
  assert.equal(dialog(), null);

  await open();
  await change(dialog()!.querySelector('input'), 'x/y');
  handlers['marketplace/add'] = async () => ({ marketplaceName: 'Y', alreadyAdded: true });
  calls.length = 0;
  await click(byText(dialog()!, 'button', 'Add marketplace'));
  await flush();
  assert.deepEqual(calls[0], ['marketplace/add', { source: 'x/y', refName: null, sparsePaths: null }]);
  assert.deepEqual(calls.at(-1), ['toast', 'Y is already added']);

  await open();
  await change(dialog()!.querySelector('input'), 'bad');
  for (const [err, text] of [
    [new Error('not a repo'), 'not a repo'],
    ['raw', 'raw'],
  ] as const) {
    handlers['marketplace/add'] = async () => {
      throw err;
    };
    calls.length = 0;
    await click(byText(dialog()!, 'button', 'Add marketplace'));
    await flush();
    assert.deepEqual(calls.at(-1), ['toast', text, 'error']);
    assert.ok(dialog());
  }
  const key = (k: string) =>
    act(async () => {
      window.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: k }));
    });
  await key('a');
  assert.ok(dialog());
  await key('Escape');
  assert.equal(dialog(), null);
  for (const close of [
    () => click(dialog()!.querySelector('[aria-label="Close dialog"]')),
    () => click(byText(dialog()!, 'button', 'Cancel')),
    () =>
      act(async () => {
        r.host.querySelector('.sketch-backdrop')!.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true }));
      }),
  ]) {
    await open();
    await act(async () => {
      dialog()!.dispatchEvent(new (window as any).MouseEvent('mousedown', { bubbles: true }));
    });
    assert.ok(dialog());
    await close();
    assert.equal(dialog(), null);
  }
  await r.unmount();
});
