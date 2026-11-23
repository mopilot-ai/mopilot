// New chat's / and @ menus (agent + saved project instead of a followed chat), skills carried by chat.start, no menu on another machine, an older Mac without them, and the full-screen look at an attached image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, button, chip, tap, typeIn, row } from './support/phone/newchat-kit';

const menuPath = '../mobile/src/remote/composerMenu';
const stripPath = '../mobile/src/components/AttachmentStrip';
const { menusOffered, loadCommands, loadMentions } = await import(menuPath);
const { AttachmentStrip } = await import(stripPath);

const COMMANDS = [
  {
    name: 'review',
    description: 'Review the changes',
    hint: '',
    kind: 'command',
    as: 'text',
  },
  {
    name: 'pdf',
    description: 'Read PDF files',
    hint: '',
    kind: 'skill',
    as: 'skill',
  },
];
const LISTS = {
  chats: [{ id: 'claude:abc', title: 'Kyoto trip' }],
  files: [{ path: 'src/a.ts', name: 'a.ts', directory: false }],
};
const METHODS = [...menus.hello.capabilities.methods, 'commands.list', 'mentions.start'];
function mac(methods: string[] = METHODS) {
  return scripted((m) => {
    if (m === 'machine.hello') return { capabilities: { ...menus.hello.capabilities, methods } };
    if (m === 'commands.list') return { commands: COMMANDS };
    if (m === 'mentions.start') return LISTS;
    if (m === 'chat.start') return { chatId: 'claude:new' };
    return undefined;
  });
}
const rows = () => [...document.querySelectorAll('[role="menuitem"]')].map((r) => r.getAttribute('aria-label'));
const pick = (re: RegExp) =>
  act(
    async () => (
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) => re.test(r.getAttribute('aria-label') ?? ''))!.click(),
      undefined
    ),
  );

test('typing / on New chat lists the commands of the agent and project picked; a skill rides with chat.start', async () => {
  const { runtime, calls } = mac();
  const { host } = await mount(runtime, fakeMedia().media);
  await typeIn('/');
  await flush();
  assert.deepEqual(
    calls.find((c) => c[0] === 'commands.list'),
    ['commands.list', { harness: 'claude', projectId: null }],
  );
  assert.deepEqual(rows(), ['Command /review, Review the changes', 'Skill /pdf, Read PDF files']);
  await pick(/pdf/);
  await flush();
  assert.ok(button(host, '/pdf ×'));
  await typeIn('summarize');
  await click('Start chat');
  const start = calls.find((c) => c[0] === 'chat.start')![1];
  assert.deepEqual(start.skills, ['pdf']);
  assert.equal(start.text, 'summarize');
});

test('typing @ on New chat asks mentions.start for the project and lists chats and files', async () => {
  const { runtime, calls } = mac();
  const { host } = await mount(runtime, fakeMedia().media);
  await tap(chip(host, 'Project'));
  await row('App');
  await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
  await typeIn('look at @a');
  await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
  assert.deepEqual(
    calls.find((c) => c[0] === 'mentions.start'),
    ['mentions.start', { harness: 'claude', projectId: 'app', query: 'a' }],
  );
  assert.deepEqual(rows(), ['Chat Kyoto trip', 'File src/a.ts']);
});

test('a Mac without mentions.start offers no menu on New chat, and the scope decides what is asked', async () => {
  const { runtime, calls } = mac(['commands.list']);
  await mount(runtime, fakeMedia().media);
  await typeIn('/');
  await flush();
  assert.deepEqual(rows(), []);
  assert.equal(
    calls.some((c) => c[0] === 'commands.list'),
    false,
  );
  const req = async () => ({
    capabilities: { methods: ['commands.list', 'mentions.list'] },
  });
  assert.deepEqual(await menusOffered(req, { harness: 'claude', projectId: null }), { commands: false, mentions: false });
  assert.deepEqual(await menusOffered(req, 'c1'), {
    commands: true,
    mentions: true,
  });
  assert.deepEqual(await menusOffered(req), { commands: true, mentions: true });
  const asked: any[] = [];
  const spy = async (m: string, p: any) => (asked.push([m, p]), m === 'commands.list' ? { commands: [] } : { chats: [], files: [] });
  await loadCommands(spy, 'c1');
  await loadMentions(spy, 'c1', 'q');
  assert.deepEqual(asked, [
    ['commands.list', { chatId: 'c1' }],
    ['mentions.list', { chatId: 'c1', query: 'q' }],
  ]);
});

test('on another machine New chat keeps photo attachments while file references and skills remain local', async () => {
  const SNAP = {
    phase: 'online',
    generation: 1,
    selectedPair: 'p',
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    presence: {},
  };
  const machines = {
    machines: [
      {
        id: 'local',
        name: 'Studio Mac',
        status: 'online',
        line: 'This Mac',
        tone: 'ok',
        agents: [],
      },
      {
        id: 'h1',
        name: 'Build box',
        status: 'online',
        line: 'Online',
        tone: 'ok',
        agents: [{ id: 'codex', label: 'Codex', state: 'ready', via: 'key' }],
      },
    ],
  };
  const { runtime, calls } = scripted((m) =>
    m === 'machine.hello'
      ? {
          capabilities: {
            ...menus.hello.capabilities,
            methods: METHODS,
            machines: true,
          },
        }
      : m === 'machines.list'
        ? machines
        : undefined,
  );
  const { host } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(host, 'Computer'));
  await row('Build box');
  await typeIn('/pdf');
  await flush();
  assert.match(host.textContent!, /File references and skills stay on this Mac\./);
  assert.equal(
    calls.some((c) => c[0] === 'commands.list' || c[0] === 'mentions.start'),
    false,
  );
  await typeIn('plain words');
  assert.doesNotMatch(host.textContent!, /stay on this Mac/);
});

const image = (key: number, state = 'done', over: Record<string, unknown> = {}) => ({
  key,
  state,
  sent: 0,
  total: 4,
  id: null,
  error: null,
  file: { name: `p${key}`, mime: 'image/png', base64: 'QUJD' },
  ...over,
});
test('an attached picture opens full screen and closes by its button; one uploading, and a document, do not open', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const items = [
    image(1),
    image(2, 'sending'),
    {
      ...image(3),
      file: { name: 'doc', mime: 'application/pdf', base64: 'QUJD' },
    },
  ];
  await act(async () =>
    root.render(
      createElement(AttachmentStrip, {
        items,
        retry: () => {},
        remove: () => {},
      }),
    ),
  );
  assert.equal(document.querySelector('button[aria-label="View p2"]'), null, 'not while it sends');
  assert.equal(document.querySelector('button[aria-label="View doc"]'), null);
  assert.equal(document.querySelector('button[aria-label="Close image"]'), null);
  await tap(document.querySelector('button[aria-label="View p1"]') as HTMLElement);
  assert.ok(document.querySelector('button[aria-label="Close image"]'));
  assert.ok(
    document.querySelector('img[alt="p1"][src="data:image/png;base64,QUJD"]') || document.querySelectorAll('img[alt="p1"]').length > 1,
  );
  await tap(document.querySelector('button[aria-label="Close image"]') as HTMLElement);
  assert.equal(document.querySelector('button[aria-label="Close image"]'), null);
  // removed while looking at it: the viewer goes with the tile
  await tap(document.querySelector('button[aria-label="View p1"]') as HTMLElement);
  await act(async () =>
    root.render(
      createElement(AttachmentStrip, {
        items: [items[2]],
        retry: () => {},
        remove: () => {},
      }),
    ),
  );
  assert.equal(document.querySelector('button[aria-label="Close image"]'), null);
  await act(async () => root.unmount());
  host.remove();
});

test('a pre-chat menu requires an explicit capability, including missing or failed hello', async () => {
  const scope = { harness: 'codex', projectId: null };
  for (const request of [
    async () => ({}),
    async () => {
      throw new Error('offline');
    },
    async () => ({ capabilities: { methods: ['mentions.start'] } }),
  ]) {
    assert.deepEqual(await menusOffered(request, scope), { commands: false, mentions: false });
  }
});

test('the mounted image viewer handles native swipe and system dismissal with a local URI', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(AttachmentStrip, {
        items: [image(1, 'done', { file: { name: 'local', mime: 'image/png', uri: 'file:///photo.png', base64: '' } })],
        retry() {},
        remove() {},
      }),
    ),
  );
  await tap(host.querySelector<HTMLElement>('button[aria-label="View local"]')!);
  assert.ok(host.querySelector('img[src="file:///photo.png"]'));
  await act(async () => (globalThis as any).__scrollEvents.onScrollEndDrag({ nativeEvent: { contentOffset: { y: -150 } } }));
  assert.equal(host.querySelector('[role="dialog"]'), null);
  await tap(host.querySelector<HTMLElement>('button[aria-label="View local"]')!);
  await act(async () => (host.querySelector('[role="dialog"]') as any).__requestClose());
  assert.equal(host.querySelector('[role="dialog"]'), null);
  await act(async () => root.unmount());
  host.remove();
});

test('the pictures being attached page in the viewer: a swipe moves to the next picture, and files that are not pictures are not in it', async () => {
  const g = globalThis as any;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const file = (key: number, mime: string) => image(key, 'done', { file: { name: `f${key}`, mime, uri: `file:///${key}`, base64: '' } });
  await act(async () =>
    root.render(
      createElement(AttachmentStrip, {
        items: [file(1, 'image/png'), file(2, 'application/pdf'), file(3, 'image/png')],
        retry() {},
        remove() {},
      }),
    ),
  );
  await tap(host.querySelector<HTMLElement>('button[aria-label="View f1"]')!);
  assert.ok(document.body.textContent!.includes('1 / 2'), 'two pictures, the file is not one');
  await act(async () => g.__scrollViews['image-pager'].onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 390 } } }));
  assert.ok(document.body.textContent!.includes('2 / 2'));
  assert.ok(document.querySelector('[role=dialog] img[src="file:///3"]'));
  await act(async () => root.unmount());
  host.remove();
});
