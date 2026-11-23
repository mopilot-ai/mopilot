// Host relay and real Registry/browser handlers must not expose this Mac's browser stores, saved-login sheet or upload files to any remote harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { world } from './support/browser-host-tools/fixture';
const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createToolRelay, hostToolsFor } = require('../electron/host/toolRelay.cjs');

for (const chatId of ['claude:remote', 'codex-remote', 'acp:kimi:remote']) {
  test(`${chatId}: real relay refuses Mac browser data before the Registry handler reads it`, async () => {
    let reads = 0;
    const registry = new Registry();
    registry.setHostScope(() => ({ iab: true }));
    for (const tool of createBrowserTools({
      tabs: { state: () => '' },
      grants: {},
      memory: {
        history: () => ({
          search: () => {
            reads++;
            return [{ url: 'https://private.test', title: 'Mac secret', lastVisit: 0, visitCount: 1 }];
          },
        }),
        bookmarks: () => ({
          search: () => {
            reads++;
            return [{ url: 'https://private.test', title: 'Mac secret', folderPath: 'Private' }];
          },
        }),
      },
    }))
      registry.register(tool);
    const sent: any[] = [];
    let receive!: (event: any) => void;
    const host = {
      tools: {
        request: async (method: string, params: any) => {
          sent.push({ method, params });
        },
        onEvent: (fn: any) => {
          receive = fn;
          return () => undefined;
        },
      },
      hostInfo: () => ({ state: 'online' }),
      onState: () => () => undefined,
    };
    const relay = createToolRelay({ host, registry, include: hostToolsFor(() => true), owns: (id: string) => id === chatId });
    try {
      for (const [i, name] of [
        'browser_history_search',
        'browser_bookmarks_search',
        'browser_request_credentials',
        'browser_file_upload',
      ].entries()) {
        receive({ event: 'tool', chatId, segmentId: 's1', callId: `call-${i}`, epoch: 1, name, arguments: {} });
      }
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.equal(reads, 0, 'a remote tool read the Mac browser store');
      const announced = sent.find((s) => s.method === 'host.toolsSync').params.tools.map((t: any) => t.name);
      for (const name of ['browser_history_search', 'browser_bookmarks_search', 'browser_request_credentials', 'browser_file_upload'])
        assert.ok(!announced.includes(name));
      const answers = sent.filter((s) => s.method === 'host.toolResult');
      assert.equal(answers.length, 4);
      assert.ok(answers.every((s) => s.params.ok === false && s.params.error.code === 'unavailable'));
      assert.ok(!JSON.stringify(answers).includes('Mac secret'));
    } finally {
      relay.dispose();
    }
  });
}

test('registry lists and invokes against current owner even when local capability snapshot was already cached', async () => {
  let caps: any = null;
  let reads = 0;
  const registry = new Registry();
  registry.setHostScope(() => caps);
  const tools = createBrowserTools({
    tabs: { state: () => '' },
    grants: {},
    memory: {
      history: () => ({
        search: () => {
          reads++;
          return [];
        },
      }),
    },
  });
  for (const tool of tools) registry.register(tool);
  registry.register({
    name: 'browser_preview_list',
    policy: 'observe',
    handler: () => {
      reads++;
      return 'local-process';
    },
  });
  assert.ok(registry.list({ chatId: 'c' }).some((t: any) => t.name === 'browser_history_search'));
  assert.equal((await registry.invoke('c', 's', 'browser_history_search', {}, { callId: 'local' })).ok, true);
  caps = { iab: true, localBrowserData: true };
  assert.equal(
    (await registry.invoke('c', 's', 'browser_history_search', {}, { callId: 'local' })).ok,
    false,
    'cached local result must not cross owners',
  ); // even a remote capability flag cannot grant the Mac stores
  for (const name of [
    'browser_history_search',
    'browser_bookmarks_search',
    'browser_request_credentials',
    'browser_file_upload',
    'browser_preview_list',
  ]) {
    assert.ok(!registry.list({ chatId: 'c' }).some((t: any) => t.name === name));
    assert.equal((await registry.invoke('c', 's', name, {}, { callId: name })).ok, false);
  }
  assert.equal(reads, 1);
  caps = null;
  assert.equal((await registry.invoke('c', 's', 'browser_history_search', {}, { callId: 'returned-local' })).ok, true);
  assert.equal(reads, 2);
});

test('batch cannot bypass local-store checks and remote credentials/uploads refuse before touching their Mac dependencies', async () => {
  const touched: string[] = [];
  const tools = createBrowserTools({
    localDataAllowed: () => false,
    tabs: {
      state: () => '',
      resolve: () => {
        touched.push('tab');
        throw Error('must not resolve');
      },
    },
    grants: {},
    credentials: {
      ask: () => {
        touched.push('saved-login');
        throw Error('must not ask');
      },
    },
    memory: {
      history: () => {
        touched.push('history');
        throw Error('must not read');
      },
      bookmarks: () => {
        touched.push('bookmarks');
        throw Error('must not read');
      },
    },
    folders: () => {
      touched.push('local-files');
      throw Error('must not read');
    },
  });
  const ctx = { chatId: 'remote', segmentId: 's' };
  const call = (name: string, args: any = {}) => tools.find((t: any) => t.name === name).handler(args, ctx);
  for (const name of ['browser_history_search', 'browser_bookmarks_search', 'browser_request_credentials', 'browser_file_upload'])
    await assert.rejects(call(name), (e: any) => e.code === 'unavailable');
  await assert.rejects(call('browser_batch', { actions: [{ name: 'browser_history_search', input: {} }] }), /another Host/);
  assert.deepEqual(touched, []);
});

test('local-only scope fails closed on unreadable owner and ignores frozen per-turn surface state', async () => {
  const { HostScope, toolNeeds } = require('../electron/capabilities/contract/hostScope.cjs');
  let fail = false;
  const errors: any[] = [];
  const scope = new HostScope({
    capsOf: () => {
      if (fail) throw Error('owner unreadable');
      return null;
    },
    onError: (e: any) => errors.push(e),
  });
  assert.equal(scope.lacks('c', 'iab'), false);
  assert.equal(scope.lacks('c', 'localBrowserData'), false);
  fail = true;
  assert.equal(scope.lacks('c', 'localBrowserData'), true);
  assert.equal(errors.length, 1);
  for (const name of ['browser_preview_start', 'browser_preview_stop', 'browser_preview_logs', 'browser_preview_list']) {
    assert.equal(toolNeeds(name), 'localBrowserData');
    assert.equal(hostToolsFor(() => true)({ name }), false);
  }
  assert.equal(hostToolsFor(() => true)({ name: 'browser_read_page' }), true);
});

test('real routed tabs refuse local data after an ownership move during tab resolution, before upload paths are read', async () => {
  const { TabsByHost } = require('../electron/capabilities/browser/tabsByHost.cjs');
  let owner = 'local';
  let finish!: (tab: any) => void;
  const local = {
    resolve: () =>
      new Promise((r) => {
        finish = r;
      }),
    state: () => '',
    list: () => [],
  };
  const remote = { resolve: () => undefined };
  const router = new TabsByHost({ local, ownerOf: () => owner, make: () => remote });
  const routed = router.routed();
  let files = 0;
  const tools = createBrowserTools({
    tabs: routed,
    grants: {},
    folders: () => {
      files++;
      return { uploads: '/must-not-read' };
    },
  });
  const upload = tools
    .find((t: any) => t.name === 'browser_file_upload')
    .handler({ paths: ['/must-not-read/private'] }, { chatId: 'c', segmentId: 's' });
  owner = 'remote';
  finish({ host: local });
  await assert.rejects(upload, (e: any) => e.code === 'unavailable');
  assert.equal(files, 0);
  assert.equal(routed.localDataAllowed('c', null), false);
  owner = 'local';
  assert.equal(routed.localDataAllowed('c', { host: remote }), false, 'an old remote tab cannot receive Mac secrets');
  assert.equal(routed.localDataAllowed('c', { host: local }), true);
});

test('a relay call with an allowed name cannot replay a cached Mac-store result from another tool', async () => {
  let caps: any = null;
  const registry = new Registry();
  registry.setHostScope(() => caps);
  registry.register({ name: 'browser_history_search', policy: 'observe', handler: () => 'private-Mac-history' });
  registry.register({ name: 'browser_navigate', policy: 'act', handler: () => 'page' });
  await registry.invoke('c', 's', 'browser_history_search', {}, { callId: 'same' });
  caps = { iab: true };
  const replay = await registry.invoke('c', 's', 'browser_navigate', {}, { callId: 'same' });
  assert.equal(replay.ok, false);
  assert.ok(!JSON.stringify(replay).includes('private-Mac-history'));
  caps = null;
  assert.equal((await registry.invoke('c', 's', 'browser_navigate', {}, { callId: 'same' })).error.code, 'call_id_reused');
});

test('a moved remote chat cannot capture a retained local Chrome tab through screenshot fallback', async () => {
  let chromeReads = 0;
  const tools = createBrowserTools({
    tabs: {
      localDataAllowed: () => false,
      list: () => [],
      resolve: async () => {
        throw Object.assign(Error('no remote tab'), { code: 'tab_not_found' });
      },
      state: () => '',
    },
    grants: {},
    chromeShots: () => {
      chromeReads++;
      return async () => 'Mac screenshot';
    },
  });
  await assert.rejects(
    tools.find((t: any) => t.name === 'browser_save_screenshot').handler({ tabId: 'old-chrome-tab' }, { chatId: 'c', segmentId: 's' }),
  );
  assert.equal(chromeReads, 0);
});

test('preview start rechecks the owner after approval before starting any Mac process', async () => {
  const { createPreviewTools } = require('../electron/capabilities/browser/devPreview/tools.cjs');
  let local = true;
  let starts = 0;
  const tools = createPreviewTools({
    localDataAllowed: () => local,
    previews: {
      find: () => null,
      start: () => {
        starts++;
        throw Error('must not start');
      },
    },
    open: async () => undefined,
    projectOf: async () => '/scratch',
    isDir: () => true,
    confirm: async () => {
      local = false;
      return true;
    },
  });
  await assert.rejects(
    tools
      .find((t: any) => t.name === 'browser_preview_start')
      .handler({ command: 'echo fake', cwd: '/scratch' }, { chatId: 'c', segmentId: 's' }),
    (e: any) => e.code === 'unavailable',
  );
  assert.equal(starts, 0);
});

test('an upload that waited for confirmation cannot dispatch local files after its chat moves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-data-upload-'));
  let local = true;
  const w = world({
    folders: () => ({ uploads: dir, downloads: dir }),
    confirm: async () => {
      local = false;
      return true;
    },
  });
  (w.tabs as any).localDataAllowed = () => local;
  fs.writeFileSync(path.join(dir, 'proof.txt'), 'not sent');
  try {
    await assert.rejects(w.call('browser_file_upload', { paths: ['proof.txt'] }), (e: any) => e.code === 'unavailable');
    assert.deepEqual(w.tabs.called('setFiles'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remote tab context never creates or exposes a Mac upload folder', async () => {
  let folders = 0;
  const w = world({
    folders: () => {
      folders++;
      return { uploads: '/private-Mac-folder', downloads: '/private-Mac-downloads' };
    },
  });
  (w.tabs as any).localDataAllowed = () => false;
  const result = await w.call('browser_tabs_context');
  assert.equal(folders, 0);
  assert.ok(!JSON.stringify(result).includes('private-Mac'));
});

test('malformed tool names preserve the Registry unknown-tool refusal instead of throwing from the local-data policy', async () => {
  const { localBrowserData } = require('../electron/capabilities/contract/localBrowserData.cjs');
  const registry = new Registry();
  registry.setHostScope(() => ({ iab: true }));
  for (const name of [undefined, null, 7, {}, [], '']) {
    assert.equal(localBrowserData(name), false);
    const result = await registry.invoke('c', 's', name, {}, { callId: `malformed-${JSON.stringify(name)}` });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unknown_tool');
    assert.deepEqual(result.content, []);
  }
});
