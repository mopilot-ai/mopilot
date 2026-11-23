// The turn trace on the user's Chrome (#3571, G5): setupChromeRelay hands the app's one TurnTraces to the Chrome host (its page gates feed it, its turn ends end it) and wraps the chrome_* registration, so a Chrome turn is traced like a built-in browser turn and listed with it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pageChrome, playExtension } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { setupChromeRelay } = require('../electron/app/chromeRelay.cjs');
const { TurnTraces } = require('../electron/capabilities/browser/devtools/turnTrace.cjs');
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { createChromeTools, PREFIX } = require('../electron/capabilities/browser/chromeTools.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-trace-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const relayWith = (traces: unknown) => {
  const tools = new Map<string, any>();
  const relay = setupChromeRelay({
    registry: { register: (t: any) => (tools.set(t.name, t), () => undefined) },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => true,
    traces,
  });
  return { relay, tools };
};

test('CM-X38: a Chrome turn is traced: the host takes the traces, chrome_* calls are recorded, and the chat’s turn end saves the trace', async () => {
  const saved: any[] = [];
  const traces = new TurnTraces({
    enabled: () => true,
    root: (chatId: string) => path.join(dir, chatId),
    onSaved: (c: string, s: any) => saved.push([c, s]),
  });
  const { relay, tools } = relayWith(traces);
  try {
    assert.equal(relay.tabs.traces, traces);
    // a chat with no Chrome tab yet: this call needs no site permission
    const out = await tools.get('chrome_tabs_context_mcp').handler({ createIfEmpty: false }, { chatId: 'c1', segmentId: 's' });
    assert.match(out[0].text, /no tab group in Chrome yet/);
    await relay.tabs.turnEnded('c1');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      saved.map(([c]) => c),
      ['c1'],
    );
    const [trace] = traces.list('c1');
    assert.deepEqual(
      trace.actions.map((a: any) => [a.tool, a.ok]),
      [['chrome_tabs_context_mcp', true]],
    );
    // and a turn that is over is not ended again
    await relay.tabs.turnEnded('c1');
    assert.equal(saved.length, 1);
  } finally {
    relay.stop();
  }
});

test('CM-X38: without a trace the Chrome host and its tools are as before', () => {
  const { relay, tools } = relayWith(null);
  try {
    assert.equal(relay.tabs.traces, null);
    assert.ok(tools.has('chrome_navigate'));
  } finally {
    relay.stop();
  }
});

test('CM-X38: a page gate of a real Chrome tab begins the turn’s trace, and the tab joins it', async () => {
  const x = playExtension();
  pageChrome(x);
  x.chrome.cdp['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : {
          result: { value: { value: { quietMs: 1000, visibility: 'visible', lines: ['button "OK" [ref_1]'], truncated: false }, seq: 0 } },
        };
  const relay = new ChromeRelay({ openPage: x.openPage, connectMs: 2000, commandMs: 1000 });
  try {
    const tabs = chromeBrowserTabs({ relay, images: { fromBuffer: (b: Buffer) => b } });
    const traces = new TurnTraces({ enabled: () => true, root: (chatId: string) => path.join(dir, `g-${chatId}`) });
    tabs.traces = traces;
    const grants = {
      anchor: () => 'full',
      peek: () => 'ok',
      require: async () => undefined,
      riskOf: () => ({ level: 'normal' }),
      act: async () => undefined,
    };
    const tools = new Map<string, any>(createChromeTools({ tabs, grants }).map((t: any) => [t.name.slice(PREFIX.length), t]));
    const ctx = { chatId: 'c2', segmentId: 's' };
    await tools.get('tabs_context_mcp').handler({}, ctx);
    const id = tabs.current('c2').wc.tabId;
    await tools.get('read_page').handler({ tabId: id }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    const trace = traces.chats.get('c2');
    assert.ok(trace, 'the page gate began the trace');
    assert.ok(trace.tabs.size >= 1);
    await traces.endTurn('c2');
  } finally {
    relay.stop();
  }
});
