// The Add to session sheet and the composer's thumbnails: the photo strip and its access states, the Attach capsule, the rows that really work, and the file tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted, fakeMedia } from './support/phone/m3';
import { deferred } from './support/async-scenarios';
import { fakeDraft } from './support/phone/drafts';

const sheetPath = '../mobile/src/components/AddToSessionSheet';
const stripPath = '../mobile/src/components/AttachmentStrip';
const threadPath = '../mobile/src/screens/Thread';
const { AddToSessionSheet } = await import(sheetPath);
const { AttachmentStrip } = await import(stripPath);
const { Thread } = await import(threadPath);
const linkPath = '../mobile/src/macLink';
const { MacLinkProvider } = await import(linkPath);
const macState = { phase: 'online', selectedPair: 'p', pairs: [{ pairId: 'p', name: 'Studio Mac' }], presence: {} };

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    root,
    render: async (next: any) => {
      await act(async () => root.render(next));
      await flush();
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, uri: `ph://p${i}` }));
const tiles = (host: HTMLElement) => [...host.querySelectorAll('button[aria-label="Photo"]')] as HTMLButtonElement[];
const named = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const tap = async (el: Element | null) => {
  assert.ok(el);
  await act(async () => (el as HTMLElement).click());
  await flush();
};
/** What the composer's useAttachments gives the sheet: the files it holds and the one way it adds. */
function fakeFiles(held = 0) {
  const added: any[] = [];
  const files: any = {
    items: Array.from({ length: held }, (_, key) => ({ key })),
    add: (file: any) => {
      added.push(file);
      files.items = [...files.items, { key: 100 + added.length }];
    },
    full: false,
  };
  return { files, added };
}
const props = (over: Record<string, unknown> = {}) => {
  const closed: string[] = [];
  const { media, log } = fakeMedia({ recent: { access: 'full', photos: photos(3) } });
  const { files, added } = fakeFiles();
  return { closed, log, added, files, props: { open: true, onClose: () => closed.push('close'), media, files, ...over } };
};

test('the strip starts with Camera, then the newest photos; ticking shows the capsule, and Attach reads each photo into the message', async () => {
  const t = props();
  const v = await mount(createElement(AddToSessionSheet, t.props));
  assert.ok(named(v.host, 'Camera'));
  assert.equal(tiles(v.host).length, 3);
  assert.equal(
    tiles(v.host)[0].querySelector('img')!.getAttribute('src'),
    'ph://p0',
    'a tile draws the library address through expo-image',
  );
  assert.equal(named(v.host, 'Attach 1 photo'), null, 'no capsule without a selection');
  await tap(tiles(v.host)[0]);
  assert.ok(named(v.host, 'Attach 1 photo'));
  await tap(tiles(v.host)[2]);
  assert.equal(tiles(v.host)[0].getAttribute('aria-selected'), 'true');
  assert.equal(tiles(v.host)[1].getAttribute('aria-selected'), 'false');
  // ticking again unticks, and the capsule goes with the last tick
  await tap(tiles(v.host)[0]);
  await tap(tiles(v.host)[2]);
  assert.equal(named(v.host, 'Attach 1 photo'), null);
  await tap(tiles(v.host)[0]);
  await tap(tiles(v.host)[1]);
  await tap(named(v.host, 'Attach 2 photos'));
  assert.deepEqual(t.log, ['recent', 'photos:p0', 'photos:p1']);
  assert.deepEqual(
    t.added.map((f) => f.name),
    ['p0.jpg', 'p1.jpg'],
  );
  assert.deepEqual(t.closed, ['close']);
  await v.done();
});

test('a photo that cannot be read stays ticked with its reason while the others attach; the capsule waits while reading', async () => {
  const slow = deferred<any[]>();
  const { media, log } = fakeMedia({ recent: { access: 'full', photos: photos(3) }, failPhoto: 'p1' });
  const real = media.photos;
  media.photos = (ids: string[]) => (ids[0] === 'p0' ? slow.promise : real(ids));
  const { files, added } = fakeFiles();
  const closed: string[] = [];
  const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => closed.push('x'), media, files }));
  for (const tile of tiles(v.host).slice(0, 2)) await tap(tile);
  await tap(named(v.host, 'Attach 2 photos'));
  assert.equal(named(v.host, 'Attaching…'), null);
  assert.match(v.host.textContent!, /Attaching…/);
  assert.equal(named(v.host, 'Attach 2 photos')!.disabled, true);
  await act(async () => slow.resolve([{ name: 'p0.jpg', mime: 'image/jpeg', base64: 'QUJD' }]));
  await flush();
  assert.equal(added.length, 1, 'the readable photo attached');
  assert.deepEqual(closed, [], 'the sheet stays open for the one that failed');
  assert.match(v.host.textContent!, /One photo could not be read\./);
  assert.equal(named(v.host, 'Attach 1 photo')!.disabled, false);
  assert.deepEqual(log, ['recent', 'photos:p1']);
  await v.done();

  const both = fakeMedia({ recent: { access: 'full', photos: photos(2) }, failPhoto: 'p0' });
  const alsoBad = both.media.photos;
  both.media.photos = (ids: string[]) => (ids[0] === 'p1' ? Promise.reject(new Error('x')) : alsoBad(ids));
  const w = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: both.media, files: fakeFiles().files }));
  for (const tile of tiles(w.host)) await tap(tile);
  await tap(named(w.host, 'Attach 2 photos'));
  assert.match(w.host.textContent!, /2 photos could not be read\./);
  await w.done();
});

test('a message holds at most ten files: ticking stops at the room left, and a full message disables every way to add', async () => {
  const { media } = fakeMedia({ recent: { access: 'full', photos: photos(4) } });
  const { files } = fakeFiles(8);
  const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media, files }));
  await tap(tiles(v.host)[0]);
  await tap(tiles(v.host)[1]);
  assert.equal(tiles(v.host)[2].disabled, true, 'two fit, so the rest cannot be ticked');
  assert.equal(tiles(v.host)[0].disabled, false, 'a ticked one can still be unticked');
  await tap(tiles(v.host)[2]);
  assert.ok(named(v.host, 'Attach 2 photos'));
  await v.done();

  const full = fakeFiles(10);
  const w = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media, files: full.files }));
  assert.equal(named(w.host, 'Camera')!.disabled, true);
  assert.equal(named(w.host, 'Photos')!.disabled, true);
  assert.equal(named(w.host, 'Add files'), null);
  assert.match(w.host.textContent!, /Up to ten files/);
  await w.done();
});

test('refused access shows only Camera; limited access says so and offers Select more, which reads the strip again', async () => {
  const none = fakeMedia({ recent: { access: 'denied', photos: [] } });
  const a = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: none.media, files: fakeFiles().files }));
  assert.ok(named(a.host, 'Camera'));
  assert.equal(tiles(a.host).length, 0);
  assert.ok(named(a.host, 'Photos'), 'the full picker needs no access');
  assert.equal(named(a.host, 'Select more photos'), null);
  await a.done();

  const some = fakeMedia({ recent: { access: 'limited', photos: photos(1) } });
  const b = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: some.media, files: fakeFiles().files }));
  assert.match(b.host.textContent!, /Showing the photos you shared/);
  await tap(named(b.host, 'Select more photos'));
  assert.deepEqual(some.log, ['recent', 'manage', 'recent']);
  await b.done();

  const broken = fakeMedia({ recent: { access: 'limited', photos: [] }, manageError: 'The picker is not available.' });
  const c = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: broken.media, files: fakeFiles().files }));
  await tap(named(c.host, 'Select more photos'));
  assert.match(c.host.textContent!, /picker is not available/);
  await c.done();
});

test('Photos, Camera and Add files add and close; a cancel adds nothing; a refusal says why; extra files are left out with a note', async () => {
  const make = (over: Record<string, any>) => {
    const m = fakeMedia({ recent: { access: 'full', photos: [] }, ...over });
    const f = fakeFiles();
    const closed: string[] = [];
    return {
      ...m,
      ...f,
      closed,
      element: createElement(AddToSessionSheet, { open: true, onClose: () => closed.push('c'), media: m.media, files: f.files }),
    };
  };
  const ok = make({ files: [{ name: 'a.pdf', mime: 'application/pdf', base64: 'QQ==' }] });
  const a = await mount(ok.element);
  await tap(named(a.host, 'Photos'));
  await tap(named(a.host, 'Camera'));
  await tap(named(a.host, 'Add files'));
  assert.deepEqual(
    ok.added.map((f) => f.name),
    ['photo.jpg', 'photo.jpg', 'a.pdf'],
  );
  assert.equal(ok.closed.length, 3);
  await a.done();

  const cancelled = make({ library: null, camera: null, files: [] });
  const b = await mount(cancelled.element);
  await tap(named(b.host, 'Photos'));
  await tap(named(b.host, 'Camera'));
  await tap(named(b.host, 'Add files'));
  assert.deepEqual([cancelled.added.length, cancelled.closed.length], [0, 0]);
  await b.done();

  const refused = make({ cameraError: 'Allow camera access in Settings to take a photo.' });
  const c = await mount(refused.element);
  await tap(named(c.host, 'Camera'));
  assert.match(c.host.textContent!, /Allow camera access in Settings/);
  assert.equal(refused.closed.length, 0);
  await c.done();

  const many = make({ files: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, mime: 'text/plain', base64: 'QQ==' })) });
  const d = await mount(many.element);
  await tap(named(d.host, 'Add files'));
  assert.equal(many.added.length, 10);
  assert.match(d.host.textContent!, /Up to ten files per message; the rest were left out\./);
  assert.equal(many.closed.length, 0);
  await d.done();
});

test('the rows are only those that work: Permission, Computer and Skills appear when given and leave the sheet before opening their page', async () => {
  const bare = props();
  const a = await mount(createElement(AddToSessionSheet, bare.props));
  assert.ok(named(a.host, 'Add files'));
  for (const row of ['Permission', 'Computer', 'Skills', 'Research', 'Connectors', 'Memory', 'Add to project'])
    assert.equal(
      [...a.host.querySelectorAll('button')].some((b) => b.getAttribute('aria-label')?.startsWith(row)),
      false,
      row,
    );
  await a.done();

  const seen: string[] = [];
  const t = props({
    permission: { value: 'Ask', open: () => seen.push('permission') },
    computer: { value: 'DU’s MacBook Pro', open: () => seen.push('computer') },
    skills: () => seen.push('skills'),
  });
  const b = await mount(createElement(AddToSessionSheet, t.props));
  await tap(named(b.host, 'Permission, Ask'));
  await tap(named(b.host, 'Computer, DU’s MacBook Pro'));
  await tap(named(b.host, 'Skills'));
  assert.deepEqual(seen, ['permission', 'computer', 'skills']);
  assert.deepEqual(t.closed, ['close', 'close', 'close']);
  // a permission row with no value yet still reads as a row
  const c = await mount(createElement(AddToSessionSheet, { ...t.props, permission: { open: () => {} } }));
  assert.ok(named(c.host, 'Permission'));
  await b.done();
  await c.done();
});

test('opening again starts clean, and what finishes after the sheet closed adds nothing', async () => {
  const slowRecent = deferred<any>();
  const slowPhoto = deferred<any[]>();
  const slowCamera = deferred<any>();
  const m = fakeMedia({ recent: { access: 'full', photos: photos(2) } });
  const calls: string[] = [];
  const media = {
    ...m.media,
    recent: () => (calls.push('recent'), calls.length === 3 ? slowRecent.promise : m.media.recent()),
    photos: () => slowPhoto.promise,
    camera: () => slowCamera.promise,
  };
  const { files, added } = fakeFiles();
  const el = (open: boolean) => createElement(AddToSessionSheet, { open, onClose: () => {}, media, files });
  const v = await mount(el(true));
  await tap(tiles(v.host)[0]);
  await v.render(el(false));
  assert.equal(v.host.textContent, '', 'closed draws nothing');
  await v.render(el(true));
  // the tick, the strip and any error of the last time are gone
  assert.equal(named(v.host, 'Attach 1 photo'), null);
  await v.render(el(false));
  await v.render(el(true));
  await v.render(el(false));
  // the strip that was on its way when the sheet closed is ignored
  await act(async () => slowRecent.resolve({ access: 'full', photos: photos(5) }));
  await v.render(el(true));
  assert.equal(calls.length, 4);
  // a photo read and a camera shot that finish after the sheet closed add nothing, and a failure after close shows nothing
  await v.render(el(true));
  await tap(tiles(v.host)[0]);
  await tap(named(v.host, 'Attach 1 photo'));
  await tap(named(v.host, 'Camera'));
  await v.render(el(false));
  await act(async () => slowPhoto.resolve([{ name: 'late.jpg', mime: 'image/jpeg', base64: 'QUJD' }]));
  await act(async () => slowCamera.resolve({ name: 'late2.jpg', mime: 'image/jpeg', base64: 'QUJD' }));
  await flush();
  assert.deepEqual(added, []);
  await v.done();

  // a photo that fails to read after the sheet closed leaves no error behind
  const late = deferred<any[]>();
  const failing = { ...m.media, photos: () => late.promise };
  const w = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: failing, files }));
  await tap(tiles(w.host)[0]);
  await tap(named(w.host, 'Attach 1 photo'));
  await w.render(createElement(AddToSessionSheet, { open: false, onClose: () => {}, media: failing, files }));
  await act(async () => late.reject(new Error('gone')));
  await flush();
  assert.deepEqual(added, []);
  await w.done();

  const cam = deferred<any>();
  const refusing = { ...m.media, camera: () => cam.promise };
  const x = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: refusing, files }));
  await tap(named(x.host, 'Camera'));
  await x.render(createElement(AddToSessionSheet, { open: false, onClose: () => {}, media: refusing, files }));
  await act(async () => cam.reject(new Error('no camera')));
  await flush();
  await x.render(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: refusing, files }));
  assert.doesNotMatch(x.host.textContent!, /no camera/);
  await x.done();

  // a Mac that names no current permission still gets the row, with no value
  const unnamed = chat(['options.get', 'options.set'], {}, undefined, '');
  const z = await mount(unnamed.render());
  await click('Add to session');
  assert.ok(named(z.host, 'Permission'));
  await z.done();

  // a Mac that can set permissions but lists none leaves the row out too
  const norows = chat(['options.get', 'options.set'], {}, []);
  const y = await mount(norows.render());
  await click('Add to session');
  assert.equal(
    [...y.host.querySelectorAll('button')].some((b) => b.getAttribute('aria-label')?.startsWith('Permission')),
    false,
  );
  await y.done();
});

test('the composer tiles show each file’s state: progress while sending, a retry on a failed one, a name for a document, and a ×', async () => {
  const removed: number[] = [];
  const retried: number[] = [];
  const item = (key: number, state: string, mime: string, over: Record<string, unknown> = {}) => ({
    key,
    state,
    sent: 0,
    total: 4,
    id: null,
    error: null,
    file: { name: `f${key}`, mime, base64: 'QUJD' },
    ...over,
  });
  const none = await mount(createElement(AttachmentStrip, { items: [], retry: () => {}, remove: () => {} }));
  assert.equal(none.host.textContent, '');
  await none.done();
  const items = [
    item(1, 'sending', 'image/jpeg', { sent: 1 }),
    item(2, 'done', 'image/jpeg', { file: { name: 'shot', mime: 'image/png', base64: 'QUJD', uri: 'file:///shot.png' } }),
    item(3, 'failed', 'image/jpeg', { error: 'Mac full' }),
    item(4, 'cancelled', 'application/pdf'),
    item(5, 'sending', 'image/jpeg', { sent: 9, total: 0 }),
  ];
  const v = await mount(
    createElement(AttachmentStrip, { items, retry: (k: number) => retried.push(k), remove: (k: number) => removed.push(k) }),
  );
  const label = (l: string) => v.host.querySelector(`[aria-label="${l}"]`);
  assert.ok(label('f1, sending 25%'));
  assert.match(v.host.textContent!, /25%/);
  assert.ok(label('shot, attached'));
  assert.equal(v.host.querySelector('img[alt="shot"]')!.getAttribute('src'), 'file:///shot.png', 'a local image shows from its file');
  assert.equal(v.host.querySelector('img[alt="f3"]')!.getAttribute('src'), 'data:image/jpeg;base64,QUJD', 'else from its bytes');
  assert.ok(label('f3, failed: Mac full'));
  assert.ok(label('f4, cancelled'));
  assert.ok(label('f5, sending 100%'), 'progress never passes 100');
  assert.match(v.host.textContent!, /f4/, 'a document shows its name');
  assert.equal(label('Retry upload of f1'), null);
  await tap(named(v.host, 'Retry upload of f3'));
  await tap(named(v.host, 'Retry upload of f4'));
  await tap(named(v.host, 'Remove shot'));
  assert.deepEqual(retried, [3, 4]);
  assert.deepEqual(removed, [2]);
  await v.done();
});

const follow = { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] };
function chat(
  methods: string[],
  extra: Record<string, unknown> = {},
  rows = [{ id: 'default', label: 'Ask', detail: 'Ask first' }],
  current = 'default',
) {
  const { runtime } = scripted((m) => {
    if (m === 'machine.hello') return { capabilities: { methods, permissionCeiling: 'auto-review' } };
    if (m === 'chat.follow') return follow;
    if (m === 'options.get')
      return {
        models: [{ id: 'm1', label: 'M1', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' }],
        model: 'm1',
        effort: 'low',
        harness: 'Claude Code',
        harnessId: 'claude',
        permission: { value: current, rows },
      };
    return undefined;
  });
  let draft = '';
  const render = (more: Record<string, unknown> = {}) =>
    createElement(
      MacLinkProvider,
      { state: macState },
      createElement(Thread, {
        runtime,
        chatId: 'c',
        back: () => {},
        drafts: fakeDraft(draft, { set: (t: string) => (draft = t) }),
        media: fakeMedia().media,
        ...extra,
        ...more,
      }),
    );
  return { render, draft: () => draft, setDraft: (t: string) => (draft = t) };
}

test('in a chat the sheet offers Permission only where the phone may set it, the computer where the chat runs, and Skills only where the Mac lists them', async () => {
  const full = chat(['options.get', 'options.set', 'commands.list'], { where: () => {} });
  const v = await mount(full.render());
  await click('Add to session');
  const text = () => [...v.host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
  assert.ok(text().includes('Permission, Ask'));
  assert.ok(text().includes('Computer, Studio Mac'), 'the row names the Mac');
  assert.ok(text().includes('Skills'));
  await click('Skills');
  assert.equal(full.draft(), '$', 'Skills types the $ that opens the skills list');
  full.setDraft('Fix this');
  await v.render(full.render());
  await click('Add to session');
  await click('Skills');
  assert.equal(full.draft(), 'Fix this $');
  await click('Add to session');
  await click('Permission, Ask');
  assert.match(v.host.textContent!, /Select model/, 'Permission opens the page the model pill opens');
  await v.done();

  const bare = chat(['options.get']);
  const w = await mount(bare.render());
  await click('Add to session');
  const labels = [...w.host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
  assert.equal(
    labels.some((l) => /^(Permission|Computer|Skills)/.test(l)),
    false,
    'an older Mac and a chat with nowhere to go leave the rows out',
  );
  assert.ok(labels.includes('Add files'));
  await w.done();

  // a Mac that lists permissions but cannot set them from the phone leaves the row out
  const nopermit = chat(['options.get', 'commands.list']);
  const x = await mount(nopermit.render());
  await click('Add to session');
  assert.equal(
    [...x.host.querySelectorAll('button')].some((b) => b.getAttribute('aria-label')?.startsWith('Permission')),
    false,
  );
  await x.done();

  // a Mac that names no current permission still gets the row, with no value
  const unnamed = chat(['options.get', 'options.set'], {}, undefined, '');
  const z = await mount(unnamed.render());
  await click('Add to session');
  assert.ok(named(z.host, 'Permission'));
  await z.done();

  // a Mac that can set permissions but lists none leaves the row out too
  const norows = chat(['options.get', 'options.set'], {}, []);
  const y = await mount(norows.render());
  await click('Add to session');
  assert.equal(
    [...y.host.querySelectorAll('button')].some((b) => b.getAttribute('aria-label')?.startsWith('Permission')),
    false,
  );
  await y.done();
});
