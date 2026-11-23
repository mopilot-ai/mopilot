// Browser channel selection, schema caching, fallback and token persistence cases.
import { test, assert, fs, os, path, require, BrowserControl, effectiveChannel, ChromeTokens, OriginGrants, Registry } from './fixture.ts';

export function registerSelectionAndTokens() {
  test('BrowserControl: one set of sage_browser_* tools, from the chosen channel or its fallback', async () => {
    const flags: Record<string, boolean> = { 'shared.browser.extension': true, 'shared.browser.panelCdp': true };
    const isEnabled = (k: string) => !!flags[k];
    const registry = new Registry();
    let stopped = 0;
    const chrome = {
      tools: async () => [
        { name: 'browser_navigate', inputSchema: { type: 'object' } },
        { name: 'browser_take_screenshot', inputSchema: { type: 'object' } },
      ],
      stopAll: () => stopped++,
    };
    const written: any[] = [];
    const cache = { read: () => null, write: (l: any) => written.push(l) };
    const bc = new BrowserControl({
      registry,
      grants: new OriginGrants({ ask: async () => null }),
      chromeGrants: new OriginGrants({ ask: async () => null }),
      panel: {},
      chrome,
      isEnabled,
      cache,
    });
    const names = () => registry.list().map((t: any) => t.name);

    assert.equal(await bc.configure('chrome'), 'chrome');
    assert.deepEqual(names(), [
      'sage_browser_navigate',
      'sage_browser_snapshot',
      'sage_browser_click',
      'sage_browser_type',
      'sage_browser_screenshot',
      'sage_browser_take_screenshot',
    ]);
    assert.equal(written.length, 1);
    assert.equal(await bc.configure('builtin'), 'builtin');
    assert.deepEqual(names(), [
      'sage_browser_navigate',
      'sage_browser_snapshot',
      'sage_browser_click',
      'sage_browser_type',
      'sage_browser_screenshot',
    ]);
    assert.equal(stopped, 1, 'leaving Your Chrome stops its instances');

    flags['shared.browser.extension'] = false;
    assert.equal(await bc.configure('chrome'), 'builtin', 'switched off remotely: the built-in browser');
    flags['shared.browser.panelCdp'] = false;
    assert.equal(await bc.configure('chrome'), null);
    assert.deepEqual(names(), []);
    assert.equal(
      effectiveChannel('nonsense', () => true),
      'builtin',
    );
  });

  test('ChromeTokens: encrypted per profile, removable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctok-'));
    const file = path.join(dir, 'chrome-token.json');
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    };
    const t = new ChromeTokens({ file, safeStorage });
    assert.equal(t.get(), null);
    assert.equal(t.set('', ' abc '), true);
    assert.equal(t.set('Profile 2', 'xyz'), true);
    assert.equal(t.get(), 'abc');
    assert.equal(t.get('Profile 2'), 'xyz');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('abc'), 'not stored in the clear');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    t.set('', '');
    assert.equal(t.has(''), false);
    assert.equal(t.has('Profile 2'), true);
    assert.equal(new ChromeTokens({ file, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } }).set('', 'q'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

export function registerCoreSchemaSwitching() {
  test('core browser schemas survive channel switches; modern Chrome receives target-based click/type and screenshots', async () => {
    const registry = new Registry();
    const calls: any[] = [];
    const inst = {
      url: 'https://task.test/',
      needsSnapshot: false,
      call: async (name: string, args: any) => {
        calls.push([name, args]);
        if (name === 'browser_navigate') inst.url = args.url;
        return { content: [{ type: 'text', text: `Page URL: ${inst.url}` }] };
      },
    };
    const schemas = ['navigate', 'snapshot', 'click', 'type', 'take_screenshot'].map((name) => ({
      name: `browser_${name}`,
      inputSchema: { type: 'object', properties: name === 'click' || name === 'type' ? { target: { type: 'string' } } : {} },
    }));
    const chrome = { tools: async () => schemas, instance: async () => inst, stopAll() {} };
    const bc = new BrowserControl({
      registry,
      panel: {},
      chrome,
      grants: { require: async () => {}, act: async () => {} },
      chromeGrants: { require: async () => {}, act: async () => {} },
      isEnabled: () => true,
    });
    await bc.configure('builtin');
    const before = registry.list().map((d: any) => [d.name, d.inputSchema]);
    await bc.configure('chrome');
    const after = registry
      .list()
      .slice(0, 5)
      .map((d: any) => [d.name, d.inputSchema]);
    assert.deepEqual(after, before);
    const call = (tool: string, args: any = {}) => registry.invoke('chat', 'segment', `sage_browser_${tool}`, args);
    assert.equal((await call('snapshot', { mode: 'text' })).ok, true);
    assert.equal((await call('click', { ref: 'e3' })).ok, true);
    assert.deepEqual(
      calls.find(([name]) => name === 'browser_click'),
      ['browser_click', { target: 'e3', element: 'e3' }],
    );
    await call('type', { selector: '#name', text: 'Ada', submit: true });
    assert.deepEqual(
      calls.find(([name]) => name === 'browser_type'),
      ['browser_type', { target: '#name', element: '#name', text: 'Ada', submit: true }],
    );
    await call('screenshot');
    assert.deepEqual(calls.at(-1), ['browser_take_screenshot', { type: 'png' }]);
    await call('navigate', { url: 'https://task.test/new' });
    assert.equal(inst.url, 'https://task.test/new');
  });
}

export function registerSelectionRecovery() {
  test('BrowserControl exposes stable initialization tools, handles failed schemas and preserves a newer configuration', async () => {
    const registry = new Registry();
    let resolve: any;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const chrome = { tools: () => pending, stopAll() {} };
    const bc = new BrowserControl({ registry, panel: {}, chrome, grants: {}, chromeGrants: {}, isEnabled: () => true });
    const old = bc.configure('chrome');
    assert.equal(registry.list().length, 5);
    assert.equal((await registry.invoke('chat', 'segment', 'sage_browser_snapshot', {})).error.code, 'unavailable');
    await bc.configure('builtin');
    resolve([{ name: 'browser_snapshot' }]);
    assert.equal(await old, 'builtin');
    assert.equal(bc.active, 'builtin');
    for (const schemas of [[], null]) {
      const empty = new BrowserControl({
        registry: new Registry(),
        panel: {},
        chrome: {
          tools: async () => {
            if (schemas === null) throw new Error('missing');
            return schemas;
          },
          stopAll() {},
        },
        grants: {},
        chromeGrants: {},
        isEnabled: () => true,
      });
      assert.equal(await empty.configure('chrome'), null);
      assert.equal(empty.o.registry.list().length, 0);
    }
    const cached = new BrowserControl({
      registry: new Registry(),
      panel: {},
      chrome: {
        tools: async () => {
          throw new Error('must use cache');
        },
        stopAll() {},
      },
      grants: {},
      chromeGrants: {},
      cache: { read: () => [{ name: 'browser_snapshot' }] },
      isEnabled: () => true,
    });
    assert.equal(await cached.configure('chrome'), 'chrome');
  });

  test('BrowserControl.drivesUserChrome: true from the moment Your Chrome is chosen, false once the built-in browser runs', async () => {
    let resolve: any;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const flags: Record<string, boolean> = { 'shared.browser.extension': true, 'shared.browser.panelCdp': true };
    const bc = new BrowserControl({
      registry: new Registry(),
      panel: {},
      chrome: { tools: () => pending, stopAll() {} },
      grants: {},
      chromeGrants: {},
      isEnabled: (k: string) => !!flags[k],
    });
    assert.equal(bc.drivesUserChrome(), false, 'nothing configured yet');
    const loading = bc.configure('chrome');
    assert.equal(bc.drivesUserChrome(), true, 'while its tools load (wanted chrome, nothing active)');
    resolve([{ name: 'browser_snapshot' }]);
    assert.equal(await loading, 'chrome');
    assert.equal(bc.drivesUserChrome(), true);
    assert.equal(await bc.configure('builtin'), 'builtin');
    assert.equal(bc.drivesUserChrome(), false);
    // switched off remotely: chosen chrome falls back to the built-in browser
    flags['shared.browser.extension'] = false;
    assert.equal(await bc.configure('chrome'), 'builtin');
    assert.equal(bc.drivesUserChrome(), false);
  });

  test('browser schema cache tolerates absent, invalid and unwritable storage', () => {
    const { schemaCache } = require('../../../electron/capabilities/browser/control.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-schema-'));
    try {
      const file = path.join(dir, 'sub', 'cache.json');
      const cache = schemaCache(file);
      assert.equal(cache.read(), null);
      cache.write([{ name: 'browser_snapshot' }]);
      assert.deepEqual(cache.read(), [{ name: 'browser_snapshot' }]);
      fs.writeFileSync(file, '{}');
      assert.equal(cache.read(), null);
      fs.writeFileSync(file, 'broken');
      assert.equal(cache.read(), null);
      schemaCache(path.join(file, 'nested.json')).write([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

export function registerLiveFlags() {
  test('BrowserControl enforces live channel flags, fallback names and optional cache persistence', async () => {
    const { browserWorld } = require('../../helpers/browser.cjs');
    const { PanelBrowser } = require('../../../electron/capabilities/browser/cdp.cjs');
    const w = browserWorld();
    const panel = new PanelBrowser({ ...w, open: () => false });
    panel.attach('chat', w.root, w.host);
    const registry = new Registry();
    const chrome = {
      tools: async () => [{ name: 'browser_snapshot' }],
      instance: async () => ({ call: async () => ({ content: [] }) }),
      stopAll() {},
    };
    let enabled = true;
    const bc = new BrowserControl({
      registry,
      panel,
      grants: { require: async () => {}, act: async () => {} },
      chromeGrants: { require: async () => {}, act: async () => {} },
      chrome,
      isEnabled: () => enabled,
      cache: { read: () => [], write() {} },
    });
    await bc.configure('nonsense');
    assert.equal((await registry.invoke('chat', 'segment', 'sage_browser_snapshot', {})).ok, true);
    const old = registry.tools.get('sage_browser_snapshot');
    await bc.configure('chrome');
    await assert.rejects(old.handler({}, { chatId: 'chat' }), /turned off/);
    enabled = false;
    assert.equal((await registry.invoke('chat', 'segment', 'sage_browser_snapshot', {})).error.code, 'disabled');
    await bc.configure('builtin');
    assert.equal(bc.active, null);
  });
}
