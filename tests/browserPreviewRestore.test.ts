// Restored browser views load only after preview readiness and discard superseded restoration results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup } from './support/browser-view-fixture.ts';
import { deferred, tick } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { loadPanePage, cancelPaneLoad } = require('../electron/capabilities/browser/viewLoad.cjs');
const url = 'http://127.0.0.1:4317/';

for (const later of ['success', 'failure'] as const) {
  test(`a pending restored page yields to newer navigation before its old ${later}`, async () => {
    const old = deferred<string>();
    const replacement = deferred<string>();
    const entry: any = { chat: 'chat', wc: { isDestroyed: () => false } };
    const loaded: string[] = [],
      failures: any[] = [];
    const load = (u: string) => {
      loaded.push(u);
    };
    const failed = (e: any) => failures.push(e);
    const a = loadPanePage(entry, `${url}old`, () => old.promise, load, failed);
    const b = loadPanePage(entry, `${url}new`, () => replacement.promise, load, failed);
    if (later === 'success') old.resolve(`${url}old`);
    else old.reject(new Error('old failure'));
    await a;
    assert.deepEqual(loaded, []);
    assert.deepEqual(failures, []);
    assert.ok(entry.previewLoad, 'the old continuation cannot clear the replacement');
    replacement.resolve(`${url}new`);
    await b;
    assert.deepEqual(loaded, [`${url}new`]);
    assert.equal(entry.previewLoad, null);
  });
}

for (const retire of ['stop', 'dispose'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`${retire} retires a pending restoration before its ${outcome}`, async () => {
      const ready = deferred<string>();
      let destroyed = false;
      const entry: any = { chat: 'chat', wc: { isDestroyed: () => destroyed } };
      const loaded: string[] = [],
        failures: any[] = [];
      const pending = loadPanePage(
        entry,
        url,
        () => ready.promise,
        (u: string) => loaded.push(u),
        (e: any) => failures.push(e),
      );
      if (retire === 'stop') cancelPaneLoad(entry);
      else destroyed = true;
      if (outcome === 'success') ready.resolve(url);
      else ready.reject(new Error('retired failure'));
      await pending;
      assert.deepEqual(loaded, []);
      assert.deepEqual(failures, []);
    });
  }
}

test('binding a saved tab waits for its chat preview, emits a usable failure, and retries through toolbar reload', async () => {
  const h = setup();
  const ready = deferred<string>();
  const requests: any[] = [];
  h.views.o.prepare = (chat: string, u: string) => {
    requests.push([chat, u]);
    return ready.promise;
  };
  const bound = h.views.bind('saved-pane', h.sender, { chatId: 'chat', url });
  const entry = h.views.entryOf(bound.id);
  assert.deepEqual(requests, [['chat', url]]);
  assert.deepEqual(entry.wc.calls, [], 'the refused-connection page must never load ahead of its server');
  ready.reject(new Error('The preview server could not restart. Check its preview logs, then retry this page.'));
  await tick();
  const event = h.sender.sent.find(([, e]: any) => e.type === 'did-fail-load')[1];
  assert.equal(event.detail.validatedURL, url);
  assert.match(event.detail.errorDescription, /could not restart/);
  h.views.o.prepare = async () => 'http://127.0.0.1:4318/';
  await h.views.nav(bound.id, h.sender, 'reload');
  assert.deepEqual(entry.wc.calls, [['load', 'http://127.0.0.1:4318/']]);
  await h.views.nav(bound.id, h.sender, 'reloadIgnoringCache');
  assert.equal(entry.wc.calls.at(-1), 'reloadIgnoringCache');
});

test('Stop through the toolbar prevents a ready preview from reviving a cancelled load', async () => {
  const h = setup();
  const ready = deferred<string>();
  h.views.o.prepare = () => ready.promise;
  const bound = h.views.bind('pane', h.sender, { chat: 'chat', url });
  h.views.nav(bound.id, h.sender, 'stop');
  ready.resolve(url);
  await tick();
  assert.ok(!h.views.entryOf(bound.id).wc.calls.some((c: any) => Array.isArray(c) && c[0] === 'load'));
});

for (const action of ['reload', 'reloadIgnoringCache']) {
  test(`${action} waits for a moved preview and loads its new port instead of reloading the dead page`, async () => {
    const h = setup();
    const original = `${url}app?draft=1#details`;
    const restored = original.replace(':4317', ':4318');
    const bound = h.views.bind('pane', h.sender, { chat: 'chat', url: original });
    const entry = h.views.entryOf(bound.id);
    entry.wc.calls = [];
    const ready = deferred<string>();
    const asked: any[] = [];
    h.views.o.prepare = (chat: string, address: string) => {
      asked.push([chat, address]);
      return ready.promise;
    };
    const pending = h.views.nav(bound.id, h.sender, action);
    assert.deepEqual(asked, [['chat', original]]);
    assert.deepEqual(entry.wc.calls, [], 'reload cannot reach the dead port before readiness');
    ready.resolve(restored);
    await pending;
    assert.deepEqual(entry.wc.calls, [['load', restored]]);
    assert.equal(entry.wc.getURL(), restored);
  });
}

test('an ordinary page keeps synchronous loading without a restoration hook', () => {
  const loaded: string[] = [];
  const entry: any = {};
  loadPanePage(
    entry,
    'https://example.test',
    undefined,
    (u: string) => loaded.push(u),
    () => assert.fail('ordinary page'),
  );
  assert.deepEqual(loaded, ['https://example.test']);
});
