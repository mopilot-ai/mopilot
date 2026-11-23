// What a paired phone reads of a chat's work besides its rows (electron/app/phoneSteps.cjs, session/callImage.cjs, contract/callSurfaces.cjs): a screenshot or zoom step's own picture from the history of any harness, shrunk; where the chat works (in-app tab, the user's Chrome, a desktop app); the Mac-only hand-offs as waiting cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPhoneSteps } = require('../electron/app/phoneSteps.cjs');
const { readCallImage, isShot } = require('../electron/session/callImage.cjs');
const { peerHistoryReader } = require('../electron/session/peerTranscript.cjs');
const { CallSurfaces } = require('../electron/capabilities/contract/callSurfaces.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const PNG = 'iVBORw0KGgo=';
const shot = (o: object = {}) => ({
  id: 'i1',
  type: 'mcpToolCall',
  tool: 'mcp__mopilot_browser__computer',
  arguments: { action: 'screenshot' },
  result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
  ...o,
});
const page = (...items: any[]) => ({ turns: [{ id: 't', items }] });

test('a step picture: the call’s own image, by item id or a phone row id, newest segment first; only screenshots and zooms', async () => {
  const read: any[] = [];
  const segments = [
    { id: 'old', kind: 'codex', nativeId: 'old' },
    { id: 'new', kind: 'codex', nativeId: 'new' },
  ];
  const pages: Record<string, any> = {
    new: page({ id: 'x', type: 'agentMessage', text: 'hi' }, shot({ id: 'i2', tool: 'desktop_zoom', arguments: '{"x":1}' })),
    old: page(shot()),
  };
  const readTurns = async (seg: any) => (read.push(seg.id), pages[seg.id]);
  const record = { segments };
  assert.equal(await readCallImage(record, readTurns, 'i2'), `data:image/png;base64,${PNG}`);
  assert.deepEqual(read, ['old', 'new'], 'read each source once before applying chat slices');
  assert.equal(await readCallImage(record, readTurns, JSON.stringify(['old', 't', 'i1'])), `data:image/png;base64,${PNG}`);
  assert.equal(await readCallImage(record, readTurns, 'x'), null, 'not a tool call');
  assert.equal(await readCallImage(record, readTurns, 'missing'), null);
  assert.equal(await readCallImage(record, readTurns, '[not json'), null);
  assert.equal(await readCallImage(record, readTurns, '[1]'), null);
  assert.equal(await readCallImage(undefined, readTurns, 'i1'), null);
  // a page with no turns, or odd turns, reads as nothing
  assert.equal(await readCallImage({ segments: [{ id: 'a' }] }, async () => ({ turns: [{ items: 'x' }, null] }), 'i1'), null);
  assert.equal(await readCallImage({ segments: [{ id: 'a' }] }, async () => null, 'i1'), null);
  // a screenshot whose picture was not kept
  assert.equal(await readCallImage(record, async () => page(shot({ result: { content: [] } })), 'i1'), null);
  // a click with an image result is not a picture a phone opens
  assert.equal(await readCallImage(record, async () => page(shot({ arguments: { action: 'left_click' } })), 'i1'), null);
  // an id an agent reused: the newer call is a click, the older one the screenshot
  const reused: Record<string, any> = { new: page(shot({ arguments: { action: 'left_click' } })), old: page(shot()) };
  assert.equal(await readCallImage(record, async (seg: any) => reused[seg.id], 'i1'), `data:image/png;base64,${PNG}`);
});

test('a step picture needs Electron’s nativeImage unless the caller gives one; a site with no host is named by its address', async () => {
  // the default image source is Electron's, which a plain Node process doesn't have: the read fails instead of inventing a picture
  const live: any = { peerRuntime: { readHistory: { callImage: async () => 'data:image/png;base64,x' } } };
  await assert.rejects(createPhoneSteps({ live }).stepImage('c', 'i1', 360));
  const hand = createPhoneSteps({
    live: { credentialHandoff: { list: () => [{ id: 'k', chatId: 'c', origin: 'about:blank' }] } },
  });
  assert.equal(hand.waitingCards('c')[0].title, 'Waiting for you on your Mac: sign in to about:blank');
});

test('which steps are screenshots or zooms: by tool name or by the computer tool’s action, on every harness’s item shape', () => {
  assert.equal(isShot(shot()), true);
  assert.equal(isShot(shot({ type: 'dynamicToolCall', tool: 'browser_screenshot', arguments: {} })), true);
  assert.equal(isShot(shot({ tool: 'mcp__mopilot_computer__app_zoom', arguments: undefined })), true);
  assert.equal(isShot(shot({ tool: 'computer', arguments: '{"action":"zoom"}' })), true);
  assert.equal(isShot(shot({ tool: 'computer', arguments: '{bad' })), false);
  assert.equal(isShot(shot({ tool: 'computer', arguments: '7' })), false);
  assert.equal(isShot(shot({ tool: undefined, arguments: { action: 'type' } })), false);
  assert.equal(isShot(shot({ type: 'commandExecution' })), false);
  assert.equal(isShot(null), false);
});

test('the peer history reader also reads one call’s picture, by chat id', async () => {
  const chats = { records: new Map([['c', { segments: [{ id: 's' }] }]]) };
  const reader = peerHistoryReader(chats, () => async () => page(shot()));
  assert.equal(await reader.callImage('c', 'i1'), `data:image/png;base64,${PNG}`);
  assert.equal(await reader.callImage('none', 'i1'), null);
});

/** Electron's nativeImage as a fake: a picture of a given size, shrunk on resize. */
const images = (width: number, height: number) => {
  const made: any[] = [];
  const picture = (w: number, h: number): any => ({
    getSize: () => ({ width: w, height: h }),
    resize: (o: any) => (made.push(o), picture(o.width, o.height)),
    toJPEG: (q: number) => Buffer.from(`jpeg ${w}x${h} q${q}`),
  });
  return { made, api: () => ({ createFromDataURL: () => picture(width, height) }) };
};

test('a step picture is shrunk to the side asked for as a JPEG, a small one kept as it is, none when there is none', async () => {
  const big = images(2000, 1000);
  const live: any = {
    peerRuntime: { readHistory: { callImage: async (_c: string, id: string) => (id === 'i1' ? 'data:image/png;base64,x' : null) } },
  };
  const steps = createPhoneSteps({ live, images: big.api });
  assert.deepEqual(await steps.stepImage('c', 'i1', 360), {
    data: Buffer.from('jpeg 360x180 q70').toString('base64'),
    width: 360,
    height: 180,
  });
  assert.deepEqual(big.made, [{ width: 360, height: 180, quality: 'good' }]);
  const small = images(100, 50);
  assert.deepEqual(await createPhoneSteps({ live, images: small.api }).stepImage('c', 'i1', 360), {
    data: Buffer.from('jpeg 100x50 q70').toString('base64'),
    width: 100,
    height: 50,
  });
  assert.equal(small.made.length, 0);
  // a sliver keeps at least one pixel on its short side
  const thin = images(4000, 1);
  assert.equal((await createPhoneSteps({ live, images: thin.api }).stepImage('c', 'i1', 64)).height, 1);
  assert.equal(await steps.stepImage('c', 'i9', 360), null);
  assert.equal(await createPhoneSteps({ live, images: images(0, 0).api }).stepImage('c', 'i1', 360), null, 'an unreadable picture');
  assert.equal(await createPhoneSteps({ live: {}, images: big.api }).stepImage('c', 'i1', 360), null, 'no history reader yet');
});

test('where the chat works: its last browser or desktop call; the in-app tab’s title and origin; the app a desktop call named', async () => {
  const last = new Map<string, any>();
  const tabs = new Map<string, any>([['c1', { title: 'Orders · UPS', url: 'https://www.ups.com/track?x=1' }]]);
  const live: any = {
    capabilities: { lastSurfaceOf: (id: string) => last.get(id) ?? null },
    browserTabs: { current: (id: string) => tabs.get(id) ?? null, list: () => [] },
  };
  const identity = { resolve: async (app: string) => (app === 'Notes' ? { name: 'Notes', bundleId: 'com.apple.Notes' } : null) };
  const steps = createPhoneSteps({ live, identity });
  assert.equal(await steps.surface('c1'), null, 'no browser or desktop call yet');
  last.set('c1', { needs: 'iab', app: null });
  assert.deepEqual(await steps.surface('c1'), { kind: 'iab', title: 'Orders · UPS', origin: 'https://www.ups.com' });
  tabs.set('c1', { title: '', url: 'about:blank' });
  assert.deepEqual(await steps.surface('c1'), { kind: 'iab' });
  tabs.delete('c1');
  assert.deepEqual(await steps.surface('c1'), { kind: 'iab' });
  last.set('c1', { needs: 'bu', app: null });
  assert.deepEqual(await steps.surface('c1'), { kind: 'chrome' });
  last.set('c1', { needs: 'cu', app: 'Notes' });
  assert.deepEqual(await steps.surface('c1'), { kind: 'desktop', app: { name: 'Notes', bundleId: 'com.apple.Notes' } });
  last.set('c1', { needs: 'cu', app: 'Unknown App' });
  assert.deepEqual(await steps.surface('c1'), { kind: 'desktop', app: { name: 'Unknown App', bundleId: null } });
  last.set('c1', { needs: 'cu', app: null });
  assert.deepEqual(await steps.surface('c1'), { kind: 'desktop' });
  last.set('c1', { needs: 'other', app: null });
  assert.equal(await steps.surface('c1'), null);
  assert.equal(await createPhoneSteps({ live: {} }).surface('c1'), null, 'no registry yet');
  // the default app lookup is the shared one
  assert.equal(typeof createPhoneSteps({ live: {} }).surface, 'function');
});

test('the registry keeps each chat’s last surface and the app its desktop calls named, for every harness’s calls alike', async () => {
  const reg = new Registry();
  for (const [name, needs] of [
    ['browser_click', undefined],
    ['chrome_click', undefined],
    ['desktop_click', undefined],
    ['plain', null],
  ] as const)
    reg.register({ name, policy: 'observe', ...(needs === null ? { needs: null } : {}), handler: async () => ({ content: [] }) });
  assert.equal(reg.lastSurfaceOf('c1'), null);
  await reg.invoke('c1', 's', 'browser_click', {});
  assert.deepEqual(reg.lastSurfaceOf('c1'), { needs: 'iab', app: null });
  await reg.invoke('c1', 's', 'plain', {});
  assert.deepEqual(reg.lastSurfaceOf('c1'), { needs: 'iab', app: null }, 'a call that uses no surface changes nothing');
  await reg.invoke('c1', 's', 'desktop_click', { app: ' Notes ' });
  assert.deepEqual(reg.lastSurfaceOf('c1'), { needs: 'cu', app: 'Notes' });
  await reg.invoke('c1', 's', 'desktop_click', {});
  assert.deepEqual(reg.lastSurfaceOf('c1'), { needs: 'cu', app: 'Notes' }, 'a desktop call naming no app keeps the last one');
  await reg.invoke('c1', 's', 'chrome_click', { app: 'x' });
  assert.deepEqual(reg.lastSurfaceOf('c1'), { needs: 'bu', app: null });
  await reg.invoke('c1', 's', 'desktop_click', { app: '' });
  assert.deepEqual(reg.lastSurfaceOf('c1'), { needs: 'cu', app: null }, 'after another surface no app is carried over');
  // an archived or deleted chat is forgotten (app/appState.cjs), so the map does not grow with every chat ever run
  reg.forgetSurface('c1');
  assert.equal(reg.lastSurfaceOf('c1'), null);
  // a surface tracker on its own, called without arguments
  const s = new CallSurfaces(
    () => [],
    () => 'cu',
    () => undefined,
  );
  s.began('c', new AbortController(), {});
  assert.deepEqual(s.last('c'), { needs: 'cu', app: null });
});

test('the hand-offs only the Mac finishes: a login sheet, a sign-in, a check; never another chat’s', () => {
  const live: any = {
    credentialHandoff: {
      list: () => [
        { id: 'k1', chatId: 'c1', origin: 'https://accounts.example.com' },
        { id: 'k2', chatId: 'c2', origin: 'https://other.test' },
        { id: 'k3', chatId: 'c1', origin: 'not a url' },
      ],
    },
    browserTabs: {
      list: (id: string) =>
        id === 'c1'
          ? [
              { id: 't1', signin: { reason: 'Sign in to continue', credential: true, site: 'github.com' } },
              { id: 't2', signin: { reason: 'Complete the CAPTCHA', credential: false, site: 'shop.test' } },
              { id: 't3', signin: { reason: 'Complete the CAPTCHA', credential: true, site: 'bank.test' } },
              { id: 't5', signin: { reason: 'Sign in to Robotics Inc', credential: false, site: 'robotics.test' } },
              { id: 't4', signin: null },
            ]
          : [],
    },
  };
  const cards = createPhoneSteps({ live }).waitingCards('c1');
  const card = (id: string, what: string) => ({
    id,
    title: `Waiting for you on your Mac: ${what}`,
    inApp: true,
    where: 'mac-only',
    waitingCopy: `Waiting for you on your Mac: ${what}`,
  });
  assert.deepEqual(cards, [
    card('mac-login:k1', 'sign in to accounts.example.com'),
    card('mac-login:k3', 'sign in to not a url'),
    card('mac-signin:t1', 'sign in to github.com'),
    card('mac-signin:t2', 'complete the check on shop.test'),
    card('mac-signin:t3', 'sign in to bank.test'),
    card('mac-signin:t5', 'sign in to robotics.test'),
  ]);
  assert.deepEqual(createPhoneSteps({ live: {} }).waitingCards('c1'), [], 'no browser yet');
  assert.deepEqual(
    createPhoneSteps({ live: { credentialHandoff: { list: () => [{ id: 'k', chatId: 'c', origin: 'https://' }] } } }).waitingCards('c')[0]
      .id,
    'mac-login:k',
  );
});

test('the steps hear a chat’s calls and its in-app tabs change (a hand-off ends with no call running), until they stop', () => {
  const heard: string[] = [];
  const live: any = { capabilities: { onCallChange: (fn: any) => (fn('c1'), () => heard.push('off')) } };
  const off = createPhoneSteps({ live }).onCallChange((id: string) => heard.push(id));
  live.phoneTabsChanged('c2');
  off();
  live.phoneTabsChanged('c3');
  assert.deepEqual(heard, ['c1', 'c2', 'off']);
  const bare: any = {};
  const offBare = createPhoneSteps({ live: bare }).onCallChange((id: string) => heard.push(id));
  bare.phoneTabsChanged('c4');
  offBare();
  assert.equal(heard.at(-1), 'c4');
});
