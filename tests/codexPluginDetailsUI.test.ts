// Native-plugin detail loading, previews, installation and stale response ownership.
import { test } from 'node:test';
import { assert, mount, click, flush, byText, h, act, calls, handlers, P, setPlugins, reset, pl, sent } from './support/codex-plugin-ui.ts';
test('the plugin page: loading, details merged from plugin/read, sections, links, install and uninstall', async () => {
  await reset();
  const base = pl('stripe', {
    marketplacePath: '/mk',
    version: '0.9',
    interface: {
      shortDescription: 'Payments',
      category: 'Finance',
      defaultPrompt: ['Check balance', 'List charges'],
      composerIconUrl: 'https://icon',
    },
  });
  let read!: (v: any) => void;
  handlers['plugin/read'] = () => new Promise((res) => (read = res));
  handlers['plugin/list'] = () => new Promise(() => {});
  const r = await mount(h(P.Plugins, { plugin: base.id }));
  assert.ok(r.host.querySelector('.center-fill .spin'));
  assert.deepEqual(sent(), ['plugin/list']);
  await setPlugins({ plugins: [base], loading: false });
  assert.deepEqual(calls.at(-1), ['plugin/read', { marketplacePath: '/mk', remoteMarketplaceName: undefined, pluginName: 'stripe' }]);
  assert.equal(r.host.querySelector('.pd-title')?.textContent, 'Stripe');
  assert.equal(r.host.querySelector('.pd-sub')?.textContent, 'Payments');
  assert.deepEqual(
    [...r.host.querySelectorAll('.pd-info dt')].map((d) => d.textContent),
    ['Category', 'Version'],
  );
  assert.equal(r.host.querySelectorAll('.pd-info dd')[1].textContent, '0.9');
  assert.equal(r.host.querySelector('.pd-mention-icon')?.getAttribute('src'), 'https://icon');

  await act(async () =>
    read({
      plugin: {
        shareUrl: 'https://share',
        description: 'Long from detail',
        summary: {
          version: '1.2',
          interface: {
            capabilities: ['Read', 'Write'],
            developerName: 'Stripe Inc',
            websiteUrl: 'https://site',
            termsOfServiceUrl: 'https://tos',
            composerIconUrl: null,
          },
        },
        apps: [{ name: 'Dashboard', description: 'Manage', logoUrl: 'https://app' }],
        appTemplates: [{ name: 'Admin app' }],
        skills: [
          { name: 'refund', description: 'Refunds', interface: { displayName: 'Refund', shortDescription: 'Issue refunds' } },
          { name: 'plain' },
          { name: 'described', description: 'Just text' },
        ],
        mcpServers: ['stripe-mcp'],
      },
    }),
  );
  assert.deepEqual(
    [...r.host.querySelectorAll('.pd-info dt')].map((d) => d.textContent),
    ['Capabilities', 'Developer', 'Category', 'Version', 'Website', 'Terms of Service'],
  );
  assert.equal(r.host.querySelector('.pd-info dd')?.textContent, 'Read, Write');
  assert.equal(r.host.querySelectorAll('.pd-info dd')[3].textContent, '1.2');
  assert.equal(r.host.querySelector('.pd-long')?.textContent, 'Long from detail');
  assert.equal(r.host.querySelector('.pd-mention-icon'), null);
  const sections = [...r.host.querySelectorAll('.pd-section')].map((s) => [
    s.querySelector('h2')?.textContent,
    s.querySelector('.pd-count')?.textContent ?? null,
  ]);
  assert.deepEqual(sections, [
    ['Apps', '2'],
    ['Skills', '3'],
    ['MCP servers', '1'],
    ['Information', null],
  ]);
  const apps = [...r.host.querySelectorAll('.pd-section')[0].querySelectorAll('.pd-app')];
  assert.deepEqual(
    apps.map((a) => [
      a.className,
      a.querySelector('.pd-app-icon img')?.getAttribute('src') ?? null,
      !!a.querySelector('.info'),
      a.querySelector('.pd-app-desc')?.textContent ?? null,
      !!a.querySelector('.pd-app-lock'),
    ]),
    [
      ['pd-app ', 'https://app', true, 'Manage', false],
      ['pd-app template', null, false, null, true],
    ],
  );
  const skills = [...r.host.querySelectorAll('.pd-section')[1].querySelectorAll('.pd-app')];
  assert.deepEqual(
    skills.map((a) => [a.querySelector('.pd-app-name')?.textContent, a.querySelector('.pd-app-desc')?.textContent ?? null]),
    [
      ['Refund', 'Issue refunds'],
      ['plain', null],
      ['described', 'Just text'],
    ],
  );

  calls.length = 0;
  await click(r.host.querySelector('[aria-label=Website]'));
  await click(r.host.querySelector('[aria-label="Terms of Service"]'));
  await click(byText(r.host, '.pd-btn', /Copy link/));
  await click(r.host.querySelector('.pd-crumb'));
  await flush();
  assert.deepEqual(calls, [
    ['open', 'https://site'],
    ['open', 'https://tos'],
    ['copy', 'https://share'],
    ['toast', 'Copied link'],
    ['navigate', { name: 'plugins' }],
  ]);

  // not installed: Install, a prompt installs too, and the menu offers Install
  let finish!: () => void;
  handlers['plugin/install'] = () => new Promise<void>((res) => (finish = res));
  handlers['plugin/list'] = async () => ({
    marketplaces: [{ name: 'openai-curated', path: '/mk', plugins: [{ ...base, installed: false }] }],
  });
  calls.length = 0;
  await click(byText(r.host, '.pd-btn.primary', /Install/));
  assert.ok(r.host.querySelector('.pd-btn.primary .spin'));
  assert.equal(byText(r.host, '.pd-btn.primary', /Install/)?.hasAttribute('disabled'), true);
  await act(async () => finish());
  await flush();
  assert.deepEqual(sent(), ['plugin/install', 'plugin/list']);
  handlers['plugin/install'] = async () => {
    throw new Error('quota');
  };
  calls.length = 0;
  await click(byText(r.host, '.pd-prompt', /Check balance/));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'quota', 'error']);
  handlers['plugin/install'] = async () => {
    throw 'raw';
  };
  await click(r.host.querySelector('[aria-label="Plugin actions"]'));
  assert.equal(byText(r.host, '[role=menuitem]', 'Install')?.hasAttribute('data-danger'), false);
  await click(byText(r.host, '[role=menuitem]', 'Install'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'raw', 'error']);
  await r.unmount();

  // installed: Try now, a prompt fills the composer, the menu uninstalls
  await reset();
  const inst = {
    ...base,
    id: 'inst',
    installed: true,
    marketplacePath: undefined,
    interface: { defaultPrompt: ['Do it'], longDescription: 'Own long', privacyPolicyUrl: 'https://pp' },
  };
  await setPlugins({ plugins: [inst, pl('locked', { id: 'lk', availability: 'UNAVAILABLE' }), pl('bare', { id: 'bare' })] });
  handlers['plugin/read'] = async () => {
    throw new Error('x');
  };
  const events: any[] = [];
  const onMention = (e: any) => events.push(['mention', e.detail.path]);
  const onInsert = (e: any) => events.push(['insert', e.detail]);
  window.addEventListener('insert-mention', onMention);
  window.addEventListener('composer-insert', onInsert);
  try {
    const r2 = await mount(h(P.Plugins, { plugin: 'inst' }));
    await flush();
    assert.deepEqual(calls[0], [
      'plugin/read',
      { marketplacePath: undefined, remoteMarketplaceName: 'openai-curated', pluginName: 'stripe' },
    ]);
    assert.equal(r2.host.querySelector('.pd-long')?.textContent, 'Own long');
    assert.equal(r2.host.querySelector('.pd-sub'), null);
    assert.equal(byText(r2.host, '.pd-btn', /Copy link/), undefined);
    assert.deepEqual(
      [...r2.host.querySelectorAll('.pd-section h2')].map((x) => x.textContent),
      ['Information'],
    );
    assert.deepEqual(
      [...r2.host.querySelectorAll('.pd-info dt')].map((d) => d.textContent),
      ['Version', 'Privacy Policy'],
    );
    assert.ok(r2.host.querySelector('.pd-mention .plugin-logo'));
    calls.length = 0;
    await click(byText(r2.host, '.pd-btn.primary', /Try now/));
    await click(byText(r2.host, '.pd-prompt', /Do it/));
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(calls, [
      ['navigate', { name: 'home' }],
      ['navigate', { name: 'home' }],
    ]);
    assert.deepEqual(events, [
      ['mention', 'plugin://inst'],
      ['mention', 'plugin://inst'],
      ['insert', 'Do it'],
    ]);
    handlers['plugin/uninstall'] = async () => ({});
    handlers['plugin/list'] = async () => ({});
    await click(r2.host.querySelector('[aria-label="Plugin actions"]'));
    const un = byText(r2.host, '[role=menuitem]', 'Uninstall')!;
    assert.equal(un.hasAttribute('data-danger'), true);
    calls.length = 0;
    await click(un);
    await flush();
    assert.deepEqual(calls, [
      ['plugin/uninstall', { pluginId: 'inst' }],
      ['plugin/list', {}],
      ['toast', 'Removed Stripe'],
    ]);
    assert.ok(r2.host.querySelector('.center-fill .spin'));
    await r2.unmount();

    await setPlugins({ plugins: [pl('locked', { id: 'lk', availability: 'UNAVAILABLE' })] });
    handlers['plugin/read'] = async () => ({ plugin: {} });
    const r3 = await mount(h(P.Plugins, { plugin: 'lk' }));
    await flush();
    assert.equal(byText(r3.host, '.pd-btn.primary', /Install/)?.hasAttribute('disabled'), true);
    assert.equal(r3.host.querySelector('.pd-preview'), null);
    assert.equal(r3.host.querySelector('.pd-section'), null);
    assert.equal(r3.host.querySelector('.pd-long'), null);
    await r3.unmount();
  } finally {
    window.removeEventListener('insert-mention', onMention);
    window.removeEventListener('composer-insert', onInsert);
  }
});

test("another plugin's page reads its own details: the last plugin's answer or failure arriving later never lands", async () => {
  for (const late of ['answer', 'failure'] as const) {
    await reset();
    const a = pl('alpha', { marketplacePath: '/mk' });
    const b = pl('beta', { marketplacePath: '/mk' });
    await setPlugins({ plugins: [a, b], loading: false });
    const reads = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
    handlers['plugin/read'] = (p: any) => new Promise((resolve, reject) => reads.set(p.pluginName, { resolve, reject }));
    const r = await mount(h(P.Plugins, { plugin: a.id }));
    await r.render(h(P.Plugins, { plugin: b.id }));
    await act(async () => reads.get('beta')!.resolve({ plugin: { description: 'Beta details' } }));
    await act(async () =>
      late === 'answer'
        ? reads.get('alpha')!.resolve({ plugin: { description: 'Alpha details' } })
        : reads.get('alpha')!.reject(new Error('gone')),
    );
    await flush();
    assert.equal(r.host.querySelector('.pd-long')?.textContent, 'Beta details');
    // a catalog refresh that keeps the plugin does not read it again
    calls.length = 0;
    await setPlugins({ plugins: [{ ...a }, { ...b }] });
    assert.deepEqual(sent(), []);
    await r.unmount();
  }
});
