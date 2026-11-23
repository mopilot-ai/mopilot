// The shared Plugins page: installed cards with only what differs per harness, Discover and the review before an
// install, a harness's own plugin, and what the page says when the store can't be read.
import { test } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import {
  calls,
  toasts,
  routes,
  changed,
  fake,
  StorePage,
  DISCOVER_LIMIT,
  spec,
  plugin,
  rowOf,
  cardOf,
  seg,
  dialogOf,
  button,
  mount,
  click,
  change,
  flush,
  byText,
  h,
  setCodexOn,
} from './support/plugin-store-page.ts';

test("installed: one switch per card, only what differs per harness, an unreadable plugin, and a harness's own", async () => {
  fake.list = async () => ({
    plugins: [
      plugin('tidy@acme', { spec: spec('tidy', { apps: ['gmail'] }) }),
      plugin('off@acme', { enabled: false }),
      plugin('broken@acme', { spec: null, error: 'gone' }),
      plugin('mopilot@mopilot', { origin: 'builtin', spec: spec('mopilot') }),
      plugin('plain@acme', { spec: spec('plain', { author: 'Ann' }) }),
    ],
    error: null,
  });
  const r = await mount(h(StorePage));
  await flush();
  const tidy = cardOf(r.host, 'Tidy');
  assert.equal(tidy.querySelectorAll('[role=switch]').length, 1);
  assert.match(tidy.textContent!, /Couldn't install on Codex · Doesn't run on|Couldn't install on Codex/);
  assert.ok(tidy.querySelector('.plugin-card-meta.failed'));
  assert.equal(cardOf(r.host, 'Off').querySelector('.plugin-card-meta'), null, 'its switch says it is off');
  assert.equal(cardOf(r.host, 'MoPilot').querySelector('.plugin-card-meta')!.textContent, 'Built in');
  assert.equal(cardOf(r.host, 'Plain').querySelector('.plugin-card-meta')!.textContent, 'by Ann');
  assert.match(cardOf(r.host, 'broken@acme').textContent!, /Can't be read: gone/);
  // nothing repeats "Everything" on the list
  assert.doesNotMatch(r.host.textContent!, /Everything/);

  // the card opens the plugin's page; its switch doesn't
  await click(tidy.querySelector('[role=switch]'));
  await click(cardOf(r.host, 'Off').querySelector('[role=switch]'));
  assert.deepEqual(
    calls.filter(([n]) => n === 'setEnabled'),
    [
      ['setEnabled', 'tidy@acme', false],
      ['setEnabled', 'off@acme', true],
    ],
  );
  assert.deepEqual(routes, []);
  await click(tidy);
  assert.deepEqual(routes, [{ name: 'plugins', plugin: 'store:tidy@acme' }]);
  // from the keyboard too; a key on the switch inside the card stays the switch's
  const enter = (el: Element) =>
    act(async () => el.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await enter(tidy.querySelector('[role=switch]')!);
  assert.equal(routes.length, 1);
  await enter(tidy);
  assert.equal(routes.length, 2);
  routes.length = 1;

  // an unreadable plugin asks before it goes
  await click(button(cardOf(r.host, 'broken@acme'), 'Uninstall'));
  await click(button(dialogOf(r.host), 'Cancel'));
  assert.equal(
    calls.some(([n]) => n === 'uninstall'),
    false,
  );
  await click(button(cardOf(r.host, 'broken@acme'), 'Uninstall'));
  assert.match(dialogOf(r.host).textContent!, /Uninstall broken@acme\?It's removed from every harness\./);
  await click(button(dialogOf(r.host), 'Uninstall'));
  await flush();
  assert.deepEqual(
    calls.filter(([n]) => n === 'uninstall'),
    [['uninstall', 'broken@acme']],
  );
  assert.deepEqual(toasts.at(-1), ['Uninstalled broken@acme']);

  // the search narrows the list; On this Mac has only what isn't in the store
  assert.ok(cardOf(r.host, 'Gmail'));
  assert.match(cardOf(r.host, 'Gmail').textContent!, /Only on Codex/);
  assert.equal(r.host.querySelectorAll('.plugin-card-name').length, 6);
  await change(r.host.querySelector('[aria-label="Search plugins"]'), 'PLAIN');
  assert.equal(r.host.querySelectorAll('.plugin-card-name').length, 1);
  await change(r.host.querySelector('[aria-label="Search plugins"]'), 'zzz');
  assert.ok(byText(r.host, '.row > b', 'No plugins match your search'));

  // a turn of the store reads it again
  const reads = calls.filter(([n]) => n === 'list').length;
  await (await import('react')).act(async () => changed!());
  await flush();
  assert.equal(calls.filter(([n]) => n === 'list').length, reads + 1);
  await r.unmount();
  assert.equal(changed, null);
});

test('Discover: search, the limit, and the review before an install', async () => {
  const many = Array.from({ length: DISCOVER_LIMIT + 2 }, (_, i) => ({ name: `p${i}`, source: { kind: 'path', path: `p${i}` } }));
  const base = fake.catalog;
  fake.catalog = async () => {
    const c = await base();
    c.marketplaces[0].marketplace.plugins.push(...many, { name: 'by-ann', author: 'Ann', source: { kind: 'path', path: 'a' } });
    return c;
  };
  const r = await mount(h(StorePage));
  await flush();
  await seg(r.host, 'discover');
  assert.match(r.host.querySelector('.plugin-store-note')!.textContent!, new RegExp(`Showing ${DISCOVER_LIMIT} of ${DISCOVER_LIMIT + 5}`));
  await change(r.host.querySelector('[aria-label="Search plugins"]'), 'by-ann');
  assert.match(cardOf(r.host, 'By Ann').textContent!, /by Ann/);
  await change(r.host.querySelector('[aria-label="Search plugins"]'), 'NOTES');
  assert.match(cardOf(r.host, 'Notes').textContent!, /Take notes.*from acme/);
  assert.equal(r.host.querySelector('.plugin-store-note'), null);
  await change(r.host.querySelector('[aria-label="Search plugins"]'), 'zzz');
  assert.ok(byText(r.host, '.row > b', 'No plugins match your search'));
  await change(r.host.querySelector('[aria-label="Search plugins"]'), 'notes');

  await click(r.host.querySelector('[aria-label="Install Notes"]'));
  await flush();
  const dialog = dialogOf(r.host);
  assert.equal(dialog.getAttribute('aria-label'), 'Install Notes');
  assert.match(dialog.textContent!, /Includes 1 skill\./);
  assert.match(dialog.textContent!, /Runs on this Mac:mcp srv: node \$\{PLUGIN_ROOT\}\/s\.js/);
  assert.match(dialog.textContent!, /Also appears in Codex's own app and CLI\./);
  fake.install = async () => {
    throw new Error('changed since you reviewed');
  };
  await click(button(dialog, 'Install'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['changed since you reviewed', 'error']);
  assert.ok(dialogOf(r.host), 'stays open to try again');
  fake.install = async () => ({ id: 'notes@acme' });
  await click(button(dialogOf(r.host), 'Install'));
  await flush();
  assert.deepEqual(
    calls.find(([n, ...a]) => n === 'install' && a[2] === 'trust-notes'),
    ['install', 'acme', 'notes', 'trust-notes'],
  );
  assert.deepEqual(toasts.at(-1), ['Installed Notes']);
  assert.equal(dialogOf(r.host), null);

  // the card itself opens the review too; a plugin that can't be read, or a preview that fails, says why and opens nothing
  await click(cardOf(r.host, 'Notes'));
  await flush();
  assert.ok(dialogOf(r.host));
  await click(button(dialogOf(r.host), 'Cancel'));
  fake.preview = async () => ({ ok: false, error: 'No plugin.json' });
  await click(r.host.querySelector('[aria-label="Install Notes"]'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['No plugin.json', 'error']);
  fake.preview = async () => {
    throw new Error('fetch failed');
  };
  await click(r.host.querySelector('[aria-label="Install Notes"]'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['fetch failed', 'error']);
  assert.equal(dialogOf(r.host), null);
  await r.unmount();
});

test('a part that cannot be read leaves the rest shown; with plugins.codex off the review says nothing of Codex', async () => {
  fake.native = async () => {
    throw new Error('ENOTDIR');
  };
  setCodexOn(false);
  try {
    const r = await mount(h(StorePage));
    await flush();
    assert.ok(cardOf(r.host, 'Tidy'));
    assert.match(rowOf(r.host, "Couldn't read all of the plugin store").textContent!, /Plugins your harnesses installed: ENOTDIR/);
    await seg(r.host, 'discover');
    await click(r.host.querySelector('[aria-label="Install Notes"]'));
    await flush();
    assert.doesNotMatch(dialogOf(r.host).textContent!, /Also appears/);
    await r.unmount();
  } finally {
    setCodexOn(true);
  }
  fake.catalog = async () => {
    throw new Error('bad known.json');
  };
  fake.codexStates = async () => {
    throw new Error('no states');
  };
  const r2 = await mount(h(StorePage));
  await flush();
  assert.match(
    rowOf(r2.host, "Couldn't read all of the plugin store").textContent!,
    /Marketplaces: bad known\.json Plugins your harnesses installed: ENOTDIR Codex installs: no states/,
  );
  assert.ok(cardOf(r2.host, 'Tidy'));
  await r2.unmount();
});

test('a plugin one harness installed is reviewed, then copied into the store', async () => {
  const r = await mount(h(StorePage));
  await flush();
  assert.equal(byText(r.host, '.plugin-card-name', 'Tidy@acme'), undefined);
  await click(r.host.querySelector('[aria-label="Install Gmail"]'));
  await flush();
  assert.match(dialogOf(r.host).textContent!, /Runs no commands and reaches no remote servers\./);
  await click(button(dialogOf(r.host), 'Cancel'));
  assert.equal(dialogOf(r.host), null);
  await click(r.host.querySelector('[aria-label="Install Gmail"]'));
  await flush();
  await click(button(dialogOf(r.host), 'Install'));
  await flush();
  assert.deepEqual(
    calls.find(([n]) => n === 'importNative'),
    ['importNative', 'gmail@curated', 'trust-gmail'],
  );
  await r.unmount();
});

test("a store that can't be read says why, with Retry; an empty one says how to start", async () => {
  fake.list = async () => ({ plugins: [], error: 'Unreadable installed.json' });
  fake.catalog = async () => ({ marketplaces: [], error: null });
  fake.native = async () => [];
  const r = await mount(h(StorePage));
  await flush();
  assert.match(rowOf(r.host, "Couldn't read all of the plugin store").textContent!, /Unreadable installed\.json/);
  assert.equal(byText(r.host, '.row > b', 'No plugins yet'), undefined);
  assert.equal(byText(r.host, 'h2', 'On this Mac'), undefined);
  fake.list = async () => ({ plugins: [], error: null });
  await click(button(r.host, 'Retry'));
  await flush();
  assert.ok(byText(r.host, '.row > b', 'No plugins yet'));
  // the empty list leads to Discover, whose empty state leads to adding a marketplace
  await click(button(r.host, 'Discover plugins'));
  assert.ok(rowOf(r.host, 'No marketplaces yet'));
  await click(button(r.host, 'Add marketplace'));
  assert.equal(dialogOf(r.host).getAttribute('aria-label'), 'Add marketplace');
  await click(button(dialogOf(r.host), 'Cancel'));
  await seg(r.host, 'marketplaces');
  assert.ok(byText(r.host, '.row > b', 'No marketplaces yet'));
  await r.unmount();

  // every marketplace plugin already installed
  fake.list = async () => ({ plugins: [plugin('tidy@acme')], error: null });
  fake.catalog = async () => ({
    marketplaces: [
      {
        name: 'acme',
        source: { kind: 'local', path: '/a' },
        marketplace: { name: 'acme', plugins: [{ name: 'tidy', source: { kind: 'path', path: 't' } }], problems: [] },
        error: null,
      },
    ],
    error: null,
  });
  const done = await mount(h(StorePage));
  await flush();
  await seg(done.host, 'discover');
  assert.ok(byText(done.host, '.row > b', 'Nothing more to install'));
  await done.unmount();

  fake.list = async () => {
    throw new Error('main is gone');
  };
  const r2 = await mount(h(StorePage));
  await flush();
  assert.match(rowOf(r2.host, "Couldn't read all of the plugin store").textContent!, /Installed plugins: main is gone/);
  await r2.unmount();
  // a read that ends after the page went is dropped
  let finish: (v: unknown) => void = () => undefined;
  fake.list = () => new Promise((res) => (finish = res));
  const r3 = await mount(h(StorePage));
  assert.ok(byText(r3.host, '.row > b', 'Loading…'));
  await r3.unmount();
  finish({ plugins: [], error: null });
  await flush();
  fake.list = () => Promise.reject(new Error('late'));
  const r4 = await mount(h(StorePage));
  await r4.unmount();
  await flush();
});
