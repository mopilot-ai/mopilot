// The built-in browser over a scripted CDP debugger: navigate, snapshots, click and type by ref or
// selector, screenshots, and the tab lifecycle's edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { assertCdpTarget, formatAxTree, PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');

/** A panel guest whose debugger answers from `answers` (method -> value or function of params). */
function guestWorld(answers: Record<string, any> = {}) {
  const panelSession = { name: 'persist:browser' };
  const ui: any = { id: 1 };
  const wc: any = new EventEmitter();
  const sent: [string, any][] = [];
  let attached = false;
  Object.assign(wc, {
    id: 2,
    session: panelSession,
    hostWebContents: ui,
    url: 'https://a.test/',
    loading: false,
    isDestroyed: () => false,
    getType: () => 'webview',
    getURL: () => wc.url,
    getTitle: () => 'A',
    isLoading: () => wc.loading,
    debugger: {
      isAttached: () => attached,
      attach: () => (attached = true),
      sendCommand: async (method: string, params: any) => {
        sent.push([method, params]);
        const a = answers[method];
        return typeof a === 'function' ? a(params) : a;
      },
    },
  });
  const panel = new PanelBrowser({ appContents: () => [ui], panelSession: () => panelSession, open: () => {}, attachMs: 20 });
  panel.attach('c', wc, ui);
  return { panel, wc, sent, ui, panelSession };
}

test('assertCdpTarget: no web preferences reader, or one that returns nothing, is accepted', () => {
  const ui = {};
  const s = {};
  const base = { id: 3, session: s, hostWebContents: ui, isDestroyed: () => false, getType: () => 'webview' };
  assert.doesNotThrow(() => assertCdpTarget(base, { appContents: [null, ui], panelSession: s }));
  assert.doesNotThrow(() => assertCdpTarget({ ...base, getLastWebPreferences: () => null }, { appContents: [ui], panelSession: s }));
  assert.throws(
    () =>
      assertCdpTarget(
        { ...base, getLastWebPreferences: () => ({ nodeIntegrationInSubFrames: true }) },
        { appContents: [ui], panelSession: s },
      ),
    /Node/,
  );
});

test('formatAxTree: no root without a parent takes the first node; values, nameless roles and a cut', () => {
  const nodes = [
    { nodeId: '1', parentId: 'x', role: { value: 'RootWebArea' }, childIds: ['2', '3', '9'] },
    { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Name' }, value: { value: 'Ann' }, backendDOMNodeId: 7 },
    { nodeId: '3', parentId: '1', childIds: ['4', '5'] },
    { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: '' } },
    { nodeId: '5', parentId: '3', role: { value: 'StaticText' }, name: { value: 'Hi' } },
  ];
  const { text, refs } = formatAxTree(nodes);
  assert.equal(text, '- RootWebArea\n  - textbox "Name" value="Ann" [ref=e1]\n  - \n    - text "Hi"');
  assert.deepEqual([...refs], [['e1', 7]]);
  const cut = formatAxTree(nodes, { max: 20 });
  assert.equal(cut.text, '- RootWebArea\n… (snapshot cut short)');
});

test('attach: no chat id is refused; the same tab again is kept; a replaced tab dying keeps the new one', () => {
  const { panel, wc, ui } = guestWorld();
  assert.throws(() => panel.attach('', wc, ui), /no chat/);
  assert.throws(() => panel.attach(5, wc, ui), /no chat/);
  const entry = panel.tabs.get('c');
  panel.attach('c', wc, ui);
  assert.equal(panel.tabs.get('c'), entry);
  const other: any = new EventEmitter();
  for (const k of ['isDestroyed', 'getType', 'getURL', 'getTitle', 'isLoading', 'debugger', 'session', 'hostWebContents']) other[k] = wc[k];
  other.id = 4;
  panel.attach('c', other, ui);
  wc.emit('destroyed');
  assert.equal(panel.tabs.get('c').backend.identity, other);
});

test('tab: a chat waiting for its tab gets it when a window attaches one', async () => {
  const { panel, wc, ui } = guestWorld();
  panel.tabs.delete('c');
  const p = panel.tab('c');
  const q = panel.tab('c');
  panel.attach('c', wc, ui);
  assert.equal((await p).backend.identity, wc);
  assert.equal((await q).backend.identity, wc);
});

test('url and navigate: the URL without CDP; a load error; waiting for the load it started', async () => {
  const { panel, wc, sent } = guestWorld({
    'Page.navigate': ({ url }: any) => (url.includes('bad') ? { errorText: 'net::ERR' } : url.includes('same') ? {} : { loaderId: 'L' }),
  });
  assert.equal(await panel.url('c'), 'https://a.test/');
  assert.deepEqual(sent, [] as any[]);
  await assert.rejects(panel.navigate('c', 'https://bad.test/'), /Couldn't open https:\/\/bad.test\/ \(net::ERR\)\. Try once more/);
  const p = panel.navigate('c', 'https://b.test/');
  setTimeout(() => ((wc.url = 'https://b.test/'), wc.emit('did-stop-loading')), 5);
  assert.deepEqual(await p, { url: 'https://b.test/', title: 'A' });
  assert.equal(sent.filter(([m]) => m === 'Page.navigate').length, 2);
  // a same-document navigation has no loader: nothing to wait for
  await panel.navigate('c', 'https://b.test/same#x');
  const n = new PanelBrowser({ appContents: () => [], panelSession: () => null, open: () => {} });
  assert.equal(n.attachMs, 15_000);
});

test('navigate: a link answered with a file is a download, not a failure (#1484)', async () => {
  const { noteDownload, DOWNLOAD_NOTE } = require('../electron/capabilities/browser/downloadNavigations.cjs');
  const { panel, wc } = guestWorld({ 'Page.navigate': () => ({ errorText: 'net::ERR_ABORTED' }) });
  setTimeout(() => noteDownload(wc, ['https://a.test/report.csv']), 5);
  assert.deepEqual(await panel.navigate('c', 'https://a.test/report.csv'), { url: 'https://a.test/', title: 'A', note: DOWNLOAD_NOTE });
});

test('navigate: a navigate that answers nothing is not waited for', async () => {
  const { panel } = guestWorld({});
  assert.deepEqual(await panel.navigate('c', 'https://x.test/'), { url: 'https://a.test/', title: 'A' });
});

test('snapshot: text mode, cut when long, empty when there is no body; the accessibility tree gives refs', async () => {
  let body: any = 'Hello';
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 11 },
  ];
  let nodes: any = tree;
  const { panel } = guestWorld({
    'Runtime.evaluate': () => ({ result: { value: body } }),
    'Accessibility.getFullAXTree': () => ({ nodes }),
  });
  assert.equal(await panel.snapshot('c', 'text'), 'URL: https://a.test/\nTitle: A\n\nHello');
  body = 'x'.repeat(40_001);
  const long = await panel.snapshot('c', 'text');
  assert.ok(long.endsWith('\n… (cut short)'));
  body = undefined;
  assert.equal(await panel.snapshot('c', 'text'), 'URL: https://a.test/\nTitle: A\n\n');
  assert.equal(await panel.snapshot('c'), 'URL: https://a.test/\nTitle: A\n\n- RootWebArea\n  - button "Go" [ref=e1]');
  assert.equal(panel.tabs.get('c').refs.get('e1'), 11);
  nodes = undefined;
  assert.equal(await panel.snapshot('c'), 'URL: https://a.test/\nTitle: A\n\n');
});

test('snapshot: an evaluate that answers nothing is empty text', async () => {
  const { panel } = guestWorld({});
  assert.equal(await panel.snapshot('c', 'text'), 'URL: https://a.test/\nTitle: A\n\n');
});

const box = { model: { content: [0, 0, 10, 0, 10, 20, 0, 20] } };

test('click: by ref at the center of its box, waiting for a load the click started', async () => {
  const { panel, wc, sent } = guestWorld({
    'Accessibility.getFullAXTree': { nodes: [{ nodeId: '1', role: { value: 'link' }, name: { value: 'L' }, backendDOMNodeId: 5 }] },
    'DOM.scrollIntoViewIfNeeded': () => Promise.reject(new Error('not needed')),
    'DOM.getBoxModel': box,
  });
  await panel.snapshot('c');
  wc.loading = true;
  // as Electron's: the page stops loading when it says so
  setTimeout(() => ((wc.loading = false), wc.emit('did-stop-loading')), 200);
  await panel.click('c', { ref: 'e1' });
  const mouse = sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => [p.type, p.x, p.y]);
  assert.deepEqual(mouse, [
    ['mouseMoved', 5, 10],
    ['mousePressed', 5, 10],
    ['mouseReleased', 5, 10],
  ]);
  assert.deepEqual(sent.find(([m]) => m === 'DOM.getBoxModel')![1], { backendNodeId: 5 });
  // the load forgot the old refs
  assert.equal(panel.tabs.get('c').refs.size, 0);
  await assert.rejects(panel.click('c', { ref: 'e1' }), /No element e1 in the last snapshot/);
});

test('type: by selector, with and without Enter; a selector that matches nothing; no target at all', async () => {
  const { panel, sent } = guestWorld({
    'DOM.getDocument': { root: { nodeId: 1 } },
    'DOM.querySelector': ({ selector }: any) => ({ nodeId: selector === '#q' ? 9 : 0 }),
  });
  await panel.type('c', { selector: '#q' }, 'hi');
  assert.deepEqual(sent.slice(-2), [
    ['DOM.focus', { nodeId: 9 }],
    ['Input.insertText', { text: 'hi' }],
  ]);
  await panel.type('c', { selector: '#q' }, 'go', true);
  assert.deepEqual(
    sent.filter(([m]) => m === 'Input.dispatchKeyEvent').map(([, p]) => p.type),
    ['keyDown', 'keyUp'],
  );
  await assert.rejects(panel.type('c', { selector: '#none' }, 'x'), /Nothing matches #none/);
  await assert.rejects(panel.click('c', {}), /Name the element with ref or selector/);
});

test('screenshot: a PNG content item; the debugger attaches once, after the target check', async () => {
  const { panel, sent } = guestWorld({ 'Page.captureScreenshot': { data: 'b64' } });
  assert.deepEqual(await panel.screenshot('c'), { type: 'image', data: 'b64', mimeType: 'image/png' });
  await panel.send('c', 'Page.enable');
  assert.deepEqual(sent.at(-1), ['Page.enable', {}]);
});

test('a crashed page: the panel tools say it crashed and to reload, at once, and the way back still goes', async () => {
  const { panel, wc, sent } = guestWorld({ 'Page.navigate': { loaderId: 'l' } });
  wc.isCrashed = () => true;
  await assert.rejects(panel.send('c', 'Runtime.evaluate', { expression: '1' }), {
    code: 'page_crashed',
    message: /^This page crashed\. Reload it/,
  });
  assert.equal(sent.length, 0, 'nothing reaches the gone renderer');
  await panel.send('c', 'Page.enable');
  await panel.send('c', 'Page.reload');
  assert.deepEqual(
    sent.map(([m]) => m),
    ['Page.enable', 'Page.reload'],
  );
});

test('a page that crashes while a panel command runs says it crashed and to reload, not "Target crashed" (#1561)', async () => {
  const { panel, wc } = guestWorld({});
  let gone = false;
  wc.isCrashed = () => gone;
  wc.debugger.sendCommand = async () => {
    gone = true;
    throw new Error('Target crashed');
  };
  await assert.rejects(panel.send('c', 'Page.navigate', { url: 'https://example.test/' }), {
    code: 'page_crashed',
    message: /^This page crashed\. Reload it/,
  });
  // a failure with the renderer still there is passed on as it was (the same error)
  gone = false;
  const own = new Error('Cannot find context with specified id');
  wc.debugger.sendCommand = async () => {
    throw own;
  };
  await assert.rejects(panel.send('c', 'Runtime.evaluate', { expression: '1' }), (e: unknown) => e === own);
  // a destroyed webContents (the panel closed) throws on isCrashed: it is gone, not crashed, and its error stays
  const closed = new Error('Target closed');
  wc.debugger.sendCommand = async () => {
    wc.isDestroyed = () => true;
    wc.isCrashed = () => {
      throw new TypeError('Object has been destroyed');
    };
    throw closed;
  };
  await assert.rejects(panel.send('c', 'Runtime.evaluate', { expression: '1' }), (e: unknown) => e === closed);
});
