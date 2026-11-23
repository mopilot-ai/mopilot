// A store plugin's page with its per-harness switches, the reach lines behind it and behind a card, titles and tiles,
// and a switch that settles only once the store was read again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calls,
  toasts,
  routes,
  fake,
  toggleRuns,
  StorePage,
  reachLine,
  reachException,
  PluginDetail,
  PluginTile,
  titleOfName,
  pluginTitle,
  spec,
  plugin,
  cardOf,
  dialogOf,
  button,
  mount,
  click,
  flush,
  byText,
  h,
} from './support/plugin-store-page.ts';

test("a plugin's page: reach and a switch per harness, what it includes, Uninstall after asking, none for a built-in", async () => {
  fake.list = async () => ({
    plugins: [
      plugin('tidy@acme', {
        harnesses: { claude: false },
        spec: spec('tidy', {
          author: 'Ann',
          version: '1.2.0',
          commands: [{ name: 'c', file: '/c' }],
          agents: [{ name: 'a', file: '/a' }],
          mcpServers: { srv: { type: 'stdio', command: 'x', args: [], env: {} } },
          apps: ['gmail'],
        }),
      }),
      plugin('off@acme', { enabled: false }),
      plugin('mopilot@mopilot', { origin: 'builtin', spec: spec('mopilot', { description: undefined, skills: [] }) }),
      plugin('broken@acme', { spec: null, error: 'gone' }),
    ],
    error: null,
  });
  const loaded = fake.list;
  fake.list = () => new Promise(() => undefined);
  const waiting = await mount(h(PluginDetail, { id: 'tidy@acme' }));
  assert.ok(waiting.host.querySelector('.center-fill'), 'waits for the store');
  assert.equal(button(waiting.host, /isn't installed/), undefined);
  await waiting.unmount();
  fake.list = loaded;
  const r = await mount(h(PluginDetail, { id: 'tidy@acme' }));
  await flush();
  assert.equal(r.host.querySelector('.pd-title')!.textContent, 'Tidy');
  assert.match(
    r.host.querySelector('.pd-sub')!.textContent!,
    /by Ann · v1\.2\.0 · 1 skill · 1 command · 1 agent · 1 MCP server · 1 app connector/,
  );
  const lines = [...r.host.querySelectorAll('.plugin-harness')];
  assert.deepEqual(
    lines.map((l) => l.querySelector('.plugin-harness-name')!.textContent),
    ['Codex', 'Claude Code', 'Other agents'],
  );
  assert.match(lines[0].textContent!, /Couldn't install: refused/);
  assert.match(lines[1].textContent!, /Off/);
  assert.equal(lines[1].querySelector('[role=switch]')!.getAttribute('aria-checked'), 'false');
  assert.match(r.host.textContent!, /Skillss.*Commandsc.*Agentsa.*MCP serverssrv.*App connectorsgmail/);

  await click(lines[1].querySelector('[role=switch]'));
  await flush();
  await click(r.host.querySelector('.pd-actions [role=switch]'));
  await flush();
  assert.deepEqual(
    calls.filter(([n]) => n === 'setEnabled'),
    [
      ['setEnabled', 'tidy@acme', true, 'claude'],
      ['setEnabled', 'tidy@acme', false, undefined],
    ],
  );
  await click(button(r.host, 'Plugins'));
  assert.deepEqual(routes.at(-1), { name: 'plugins' });

  routes.length = 0;
  await click(button(r.host.querySelector('.pd-actions')!, 'Uninstall'));
  await click(button(dialogOf(r.host), 'Cancel'));
  assert.equal(dialogOf(r.host), null);
  fake.uninstall = async () => {
    throw new Error('locked');
  };
  await click(button(r.host.querySelector('.pd-actions')!, 'Uninstall'));
  await click(button(dialogOf(r.host), 'Uninstall'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['locked', 'error']);
  assert.deepEqual(routes, [], 'stays on the page');
  fake.uninstall = async () => true;
  await click(button(r.host.querySelector('.pd-actions')!, 'Uninstall'));
  await click(button(dialogOf(r.host), 'Uninstall'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['Uninstalled Tidy']);
  assert.deepEqual(routes, [{ name: 'plugins' }]);
  await r.unmount();

  // off everywhere: no per-harness switches; every line says Off
  const off = await mount(h(PluginDetail, { id: 'off@acme' }));
  await flush();
  assert.equal(off.host.querySelectorAll('.plugin-harness [role=switch]').length, 0);
  assert.equal(off.host.querySelectorAll('.plugin-harness.off').length, 3);
  await off.unmount();

  // MoPilot's own: no Uninstall, no description or contents to show
  const own = await mount(h(PluginDetail, { id: 'mopilot@mopilot' }));
  await flush();
  assert.equal(own.host.querySelector('.pd-title')!.textContent, 'MoPilot');
  assert.equal(button(own.host, 'Uninstall'), undefined);
  assert.equal(own.host.querySelector('.pd-long'), null);
  assert.equal(own.host.querySelector('.pd-sub'), null);
  assert.equal(byText(own.host, 'h2', 'Includes'), undefined);
  await own.unmount();

  // a store that can't be read says so, with Retry
  const list = fake.list;
  fake.list = async () => ({ plugins: [], error: 'Unreadable installed.json' });
  const unread = await mount(h(PluginDetail, { id: 'tidy@acme' }));
  await flush();
  fake.list = list;
  await click(button(unread.host, /Couldn't read the plugin store/));
  await flush();
  assert.equal(unread.host.querySelector('.pd-title')!.textContent, 'Tidy');
  await unread.unmount();

  // gone, or unreadable: back to the list
  for (const id of ['gone@acme', 'broken@acme']) {
    const gone = await mount(h(PluginDetail, { id }));
    await flush();
    routes.length = 0;
    await click(button(gone.host, /isn't installed/));
    assert.deepEqual(routes, [{ name: 'plugins' }]);
    await gone.unmount();
  }
});

test('each harness’s line: off, a failed or skipped install, everything, part of it, or nothing', () => {
  const s = spec('p', { apps: ['gmail'], hooks: [{ event: 'Stop', command: 'x' }] }) as any;
  assert.deepEqual(reachLine(s, 'codex', { off: true }), { state: 'off', text: 'Off' });
  assert.deepEqual(reachLine(s, 'codex', { install: { codexId: 'p@mopilot-m', path: '/', state: 'failed' } }), {
    state: 'failed',
    text: "Couldn't install: unknown error",
  });
  assert.deepEqual(reachLine(s, 'codex', { install: { codexId: 'p@mopilot-m', path: '/', state: 'alreadyOn' } }), {
    state: 'full',
    text: 'Uses its own copy',
  });
  assert.deepEqual(reachLine(s, 'codex'), { state: 'full', text: 'Everything.' });
  // a remote MCP server reaches a basic-tier harness only where it takes them
  const remote = spec('r', { mcpServers: { srv: { type: 'http', url: 'https://x', headers: {} } } }) as any;
  assert.deepEqual(reachLine(remote, 'acp'), { state: 'full', text: 'Everything. Remote MCP depends on the harness.' });
  assert.deepEqual(reachLine(remote, 'claude'), { state: 'full', text: 'Everything.' });
  assert.equal(reachLine(s, 'acp').state, 'partial');
  assert.match(reachLine(s, 'acp').text, /^Not Stop, gmail\. This harness doesn't run plugin hooks\. App connectors run only on Codex/);
  assert.deepEqual(reachLine(spec('a', { skills: [], apps: ['gmail'] }) as any, 'claude').state, 'none');
  assert.match(reachLine(spec('a', { skills: [], apps: ['gmail'] }) as any, 'claude').text, /^Nothing runs\./);
  // a plan's notes stay on the review's list; a withheld family says why
  const plans = (state: string) => ({
    version: 1,
    plans: Object.fromEntries(
      ['codex', 'claude', 'acp'].map((f) => [
        f,
        {
          state,
          reasons: ['Bad source.'],
          ignored: ['Hooks are not delivered to ACP.'],
          sources: [],
          mcpServers: {},
          hooks: [],
          hookEvents: [],
        },
      ]),
    ),
  });
  assert.deepEqual(reachLine(spec('e', { execution: plans('supported') }) as any, 'acp'), { state: 'full', text: 'Everything.' });
  assert.match(reachLine(spec('e', { execution: plans('withheld') }) as any, 'acp').text, /Bad source\.$/);
});

test('a card names only the harnesses that differ, worst first', () => {
  const on = (o: Record<string, unknown>) => plugin('p@m', { spec: spec('p'), ...o }) as any;
  assert.equal(reachException(on({})), null);
  assert.equal(reachException(on({ enabled: false, harnesses: { codex: false } })), null);
  assert.deepEqual(reachException(on({ harnesses: { codex: false, claude: false } })), {
    text: 'Off on Codex, Claude Code',
    failed: false,
  });
  const hooks = on({ spec: spec('p', { hooks: [{ event: 'Stop', command: 'x' }] }) });
  assert.deepEqual(reachException(hooks), { text: 'Partly on Other agents', failed: false });
  const apps = on({ spec: spec('p', { skills: [], apps: ['gmail'] }) });
  assert.deepEqual(reachException(apps), { text: "Doesn't run on Claude Code, Other agents", failed: false });
  assert.deepEqual(reachException(apps, { codex: { codexId: 'x', path: '/', state: 'failed' } as any }), {
    text: "Couldn't install on Codex · Doesn't run on Claude Code, Other agents",
    failed: true,
  });
});

test('titles and tiles: a display name, a brand, title case; the icon follows what a plugin is made of', async () => {
  assert.equal(titleOfName('frontend-design_kit'), 'Frontend Design Kit');
  assert.equal(titleOfName('mopilot'), 'MoPilot');
  assert.equal(pluginTitle({ name: 'a-b', displayName: 'Custom' }), 'Custom');
  assert.equal(pluginTitle({ name: 'a-b', displayName: 'a-b' }), 'A B');
  const tile = (s?: unknown) => h(PluginTile, { spec: s as any });
  const r = await mount(tile());
  const icon = () => r.host.querySelector('.plugin-tile')!.innerHTML;
  const blocks = icon();
  await r.render(tile(spec('p', { skills: [], mcpServers: { s: { type: 'http', url: 'https://x', headers: {} } } })));
  const server = icon();
  await r.render(tile(spec('p')));
  const skills = icon();
  await r.render(tile(spec('p', { commands: [{ name: 'c', file: '/c' }] })));
  assert.equal(icon(), blocks, 'a mix reads as a plugin');
  assert.equal(new Set([blocks, server, skills]).size, 3);
  await r.unmount();
});

test('a plugin switch settles only once the store was read again, whether the change went through or not', async () => {
  const r = await mount(h(StorePage));
  await flush();
  const page = await mount(h(PluginDetail, { id: 'tidy@acme' }));
  await flush();
  for (const outcome of ['saved', 'refused'] as const) {
    let release: () => void = () => {};
    const list = fake.list;
    fake.list = (...a: any[]) => new Promise((resolve) => (release = () => resolve(list(...a))));
    if (outcome === 'refused')
      fake.setEnabled = async () => {
        throw new Error('locked');
      };
    toggleRuns.length = 0;
    // a card's switch, then one harness's switch on a plugin's page
    for (const sw of [cardOf(r.host, 'Off').querySelector('[role=switch]'), page.host.querySelector('.plugin-harness [role=switch]')]) {
      let done = false;
      await click(sw);
      void (toggleRuns.at(-1) as Promise<unknown>).then(() => {
        done = true;
      });
      await flush();
      assert.equal(done, false, `${outcome}: waits for the store's re-read`);
      release();
      await flush();
      assert.equal(done, true, `${outcome}: settles once it is shown`);
    }
    fake.list = list;
  }
  assert.deepEqual(toasts.at(-1), ['locked', 'error']);
  await page.unmount();
  await r.unmount();
});
