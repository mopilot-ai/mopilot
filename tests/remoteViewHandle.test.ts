// The pane's handle on a tab on a Host (src/lib/remoteView.ts, src/lib/hostTabKey.ts; package 2.6): the <webview> surface answered from frames, the user's pointer and keys as inputs, and which Host a pane key names (kept equal to the main side's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { RemoteViewHandle, forwardedUrl, keyInput, loopbackTarget, modifiersOf, mouseInput, pagePoint } from '../src/lib/remoteView.ts';
import { hostOfTabKey } from '../src/lib/hostTabKey.ts';

const require = createRequire(import.meta.url);
const { encodeTabKey, decodeTabKey } = require('../electron/capabilities/browser/hostTabKey.cjs');

const frame = (patch: object = {}) => ({
  paneId: 'p',
  data: 'AAAA',
  mime: 'image/jpeg',
  width: 800,
  height: 600,
  url: 'https://a.test/',
  title: 'A',
  loading: false,
  ...patch,
});

test('the handle tells what changed between frames as a <webview> would, and answers from the last one', () => {
  const h = new RemoteViewHandle();
  const heard: string[] = [];
  for (const t of ['dom-ready', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'page-title-updated'])
    h.addEventListener(t, (e: any) => heard.push(`${t}${e.url ? ` ${e.url}` : ''}${e.title ? ` ${e.title}` : ''}`));
  assert.deepEqual([h.getURL(), h.getTitle(), h.isLoading()], ['', '', false]);
  h.receive(frame({ loading: true }));
  assert.deepEqual(heard, ['dom-ready', 'did-start-loading', 'did-navigate https://a.test/', 'page-title-updated A']);
  assert.deepEqual([h.getURL(), h.getTitle(), h.isLoading(), h.state?.src], ['https://a.test/', 'A', true, 'data:image/jpeg;base64,AAAA']);
  // a second frame of the same load tells nothing new
  h.receive(frame({ loading: true }));
  assert.equal(heard.length, 4);
  heard.length = 0;
  // the same page, finished loading
  h.receive(frame());
  assert.deepEqual(heard, ['did-stop-loading']);
  heard.length = 0;
  // another page: a frame that omits the mime, size and facts keeps the size and reads as an empty page
  h.receive({ paneId: 'p', data: 'BBBB' });
  assert.equal(h.state?.src, 'data:image/jpeg;base64,BBBB');
  assert.deepEqual([h.state?.width, h.state?.height, h.getURL(), h.getTitle()], [800, 600, '', '']);
  assert.deepEqual(heard, ['did-navigate', 'page-title-updated']);
  // a failure or an empty frame changes nothing
  h.receive({ paneId: 'p', error: 'gone' });
  h.receive({ paneId: 'p' });
  assert.equal(h.state?.src, 'data:image/jpeg;base64,BBBB');
  // a listener that left hears no more
  const off = () => heard.push('late');
  h.addEventListener('did-navigate', off);
  h.removeEventListener('did-navigate', off);
  h.receive(frame({ url: 'https://b.test/' }));
  assert.equal(heard.includes('late'), false);
  // a handle with no frame yet and a first frame with no size
  const fresh = new RemoteViewHandle();
  fresh.receive({ paneId: 'p', data: 'CCCC' });
  assert.deepEqual([fresh.state?.width, fresh.state?.height], [0, 0]);
});

test('the user cannot navigate a page on another machine from the pane; the rest of the <webview> surface is quiet', async () => {
  const h = new RemoteViewHandle();
  assert.throws(() => h.getWebContentsId(), /another machine/);
  await assert.rejects(h.loadURL(), /agent drives it/);
  assert.deepEqual([h.canGoBack(), h.canGoForward(), h.getZoomFactor()], [false, false, 1]);
  h.reload();
  h.reloadIgnoringCache();
  h.goBack();
  h.goForward();
  h.stop();
});

test('a point on the shown frame is a point on the page; a frame or page with no size has none', () => {
  const box = { left: 100, top: 50, width: 400, height: 300 };
  const page = { width: 800, height: 600 };
  assert.deepEqual(pagePoint(box, { x: 300, y: 200 }, page), { x: 400, y: 300 });
  assert.deepEqual(pagePoint(box, { x: 50, y: 10 }, page), { x: 0, y: 0 }, 'left of the frame: its edge');
  assert.deepEqual(pagePoint(box, { x: 9999, y: 9999 }, page), { x: 800, y: 600 });
  for (const [b, p] of [
    [{ ...box, width: 0 }, page],
    [{ ...box, height: 0 }, page],
    [box, { width: 0, height: 600 }],
    [box, { width: 800, height: 0 }],
  ] as const)
    assert.equal(pagePoint(b, { x: 1, y: 1 }, p), null);
});

test('pointer and key events become inputs: buttons, click counts, modifiers, and printable characters that are not shortcuts', () => {
  assert.equal(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15);
  assert.equal(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }), 0);
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.deepEqual(mouseInput('down', { x: 1, y: 2 }, { button: 2, detail: 2, ...none, shiftKey: true }), {
    kind: 'mouse',
    type: 'down',
    x: 1,
    y: 2,
    button: 'right',
    clickCount: 2,
    modifiers: 8,
  });
  assert.equal((mouseInput('up', { x: 1, y: 2 }, { button: 1, detail: 9, ...none }) as any).clickCount, 3);
  assert.equal((mouseInput('move', { x: 1, y: 2 }, { button: 0, detail: 0, ...none }) as any).clickCount, 1);
  assert.equal(mouseInput('down', { x: 1, y: 2 }, { button: 3, detail: 1, ...none }), null);
  const k = (key: string, over: object = {}) => keyInput('down', { key, code: 'X', keyCode: 65, ...none, ...over });
  assert.equal((k('a') as any).text, 'a');
  assert.equal((k('€') as any).text, '€');
  assert.equal('text' in (k('Enter') as any), false, 'a named key types nothing');
  assert.equal('text' in (k('a', { ctrlKey: true }) as any), false, 'Control makes a shortcut');
  assert.equal('text' in (k('a', { metaKey: true }) as any), false);
  assert.equal((k('A', { shiftKey: true }) as any).modifiers, 8);
});

test('B1: the renderer names the same Host as the main side for every shape of pane key', () => {
  const keys: unknown[] = [
    null,
    undefined,
    '',
    'tab_abc',
    encodeTabKey('local', 'tab_1'),
    encodeTabKey('box', 'tab_1'),
    encodeTabKey('box', null),
    JSON.stringify(['host', 'box', 'tab_1']),
    JSON.stringify(['host', 'local', 'tab_1']),
    JSON.stringify(['host', '', 'tab_1']),
    JSON.stringify(['host', 'box']),
    JSON.stringify(['other', 'box', 'tab_1']),
    JSON.stringify(['host', 5, 'tab_1']),
    JSON.stringify({ a: 1 }),
    '[not json',
    7,
  ];
  for (const key of keys) {
    const main = decodeTabKey(key);
    assert.equal(hostOfTabKey(key as any), main.hostId === 'local' ? null : main.hostId, JSON.stringify(key));
  }
});

test("I2: only a page on the machine's own loopback is offered for forwarding, with its scheme, port (default when absent) and the rest of its address", () => {
  assert.deepEqual(loopbackTarget('http://localhost:5173/app?x=1#top'), { protocol: 'http:', port: 5173, rest: '/app?x=1#top' });
  assert.deepEqual(loopbackTarget('http://127.0.0.1/'), { protocol: 'http:', port: 80, rest: '/' });
  assert.deepEqual(loopbackTarget('https://[::1]/a'), { protocol: 'https:', port: 443, rest: '/a' });
  for (const other of [
    'https://shop.test/cart',
    'http://localhost.evil.test:3000/',
    'http://10.0.0.5:3000/',
    'http://0.0.0.0:3000/',
    'file:///etc/passwd',
    'about:blank',
    'chrome-error://chromewebdata/',
    'not a url',
    '',
  ])
    assert.equal(loopbackTarget(other), null, other);
});

test("the forwarded address keeps the page's scheme and path and points at this Mac's port, never at a host the page named", () => {
  assert.equal(forwardedUrl({ protocol: 'http:', port: 5173, rest: '/app?x=1#top' }, 41000), 'http://127.0.0.1:41000/app?x=1#top');
  assert.equal(forwardedUrl(loopbackTarget('https://localhost:8443/')!, 41001), 'https://127.0.0.1:41001/');
});
