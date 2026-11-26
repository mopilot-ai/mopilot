// The Add to session sheet's Photos button: the system picker's several photos and videos added in the order chosen, within the room the message has left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fakeMedia } from './support/phone/m3';
import { deferred } from './support/async-scenarios';

const sheetPath = '../mobile/src/components/AddToSessionSheet';
const { AddToSessionSheet, hint } = await import(sheetPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
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

const clip = (name: string) => ({ name, mime: 'video/mp4', base64: 'QUJD' });
const still = (name: string) => ({ name, mime: 'image/png', base64: 'QUJD', uri: `file:///${name}` });

test('Photos asks the system picker for as many items as the message has room for, adds each photo and video in the order chosen, then closes', async () => {
  const m = fakeMedia({ library: [still('a.png'), clip('b.mp4'), still('c.png')] });
  const f = fakeFiles(3);
  const closed: string[] = [];
  const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => closed.push('c'), media: m.media, files: f.files }));
  await tap(named(v.host, 'Photos'));
  assert.deepEqual(m.rooms, [7], 'ten files per message, three already held');
  assert.deepEqual(
    f.added.map((x) => x.name),
    ['a.png', 'b.mp4', 'c.png'],
  );
  assert.deepEqual(closed, ['c']);
  await v.done();
});

test('items the picker gives beyond the room are left out with the notice, and the sheet stays open', async () => {
  const m = fakeMedia({ library: [still('a.png'), still('b.png'), still('c.png'), still('d.png')] });
  const f = fakeFiles(8);
  const closed: string[] = [];
  const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => closed.push('c'), media: m.media, files: f.files }));
  await tap(named(v.host, 'Photos'));
  assert.deepEqual(
    f.added.map((x) => x.name),
    ['a.png', 'b.png'],
  );
  assert.match(v.host.textContent!, /Up to ten files per message; the rest were left out\./);
  assert.deepEqual(closed, []);
  await v.done();
});

test('what cannot be read is named while the rest still attach: one by its reason, several by their number', async () => {
  const one = fakeMedia({ library: { picked: [still('a.png')], refused: ['That video is larger than 20 MB. Trim it and try again.'] } });
  const f = fakeFiles();
  const closed: string[] = [];
  const v = await mount(
    createElement(AddToSessionSheet, { open: true, onClose: () => closed.push('c'), media: one.media, files: f.files }),
  );
  await tap(named(v.host, 'Photos'));
  assert.equal(f.added.length, 1, 'the readable one is in the message');
  assert.match(v.host.textContent!, /That video is larger than 20 MB\. Trim it and try again\./);
  assert.deepEqual(closed, [], 'the sheet stays open so the reason is read');
  await v.done();

  const many = fakeMedia({
    library: { picked: [], refused: ['That video is larger than 20 MB. Trim it and try again.', 'That photo could not be read.'] },
  });
  const closedMany: string[] = [];
  const w = await mount(
    createElement(AddToSessionSheet, { open: true, onClose: () => closedMany.push('c'), media: many.media, files: fakeFiles().files }),
  );
  await tap(named(w.host, 'Photos'));
  assert.match(w.host.textContent!, /2 files could not be added\./);
  assert.deepEqual(closedMany, []);
  await w.done();
});

test('a pick that is still being read when the sheet closes adds nothing', async () => {
  const late = deferred<any>();
  const m = fakeMedia();
  m.media.library = () => late.promise;
  const f = fakeFiles();
  const sheet = (open: boolean) => createElement(AddToSessionSheet, { open, onClose: () => {}, media: m.media, files: f.files });
  const v = await mount(sheet(true));
  await tap(named(v.host, 'Photos'));
  await v.render(sheet(false));
  await act(async () => late.resolve({ picked: [still('a.png')], refused: [] }));
  await flush();
  assert.equal(f.added.length, 0);
  await v.done();
});

test('when items were left out and some could not be read, the notice tells both', async () => {
  const m = fakeMedia({
    library: { picked: [still('a.png'), still('b.png'), still('c.png')], refused: ['That photo could not be read.'] },
  });
  const f = fakeFiles(8);
  const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: m.media, files: f.files }));
  await tap(named(v.host, 'Photos'));
  assert.match(v.host.textContent!, /the rest were left out\. That photo could not be read\./);
  await v.done();
});

test('while a video is made smaller the sheet says which one and how far, with a Cancel that stops it and keeps what was ready', async () => {
  const late = deferred<any>();
  const m = fakeMedia();
  let hooks: any = null;
  m.media.library = ((_room: number, h: any) => ((hooks = h), late.promise)) as any;
  const f = fakeFiles();
  const closed: string[] = [];
  const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => closed.push('c'), media: m.media, files: f.files }));
  await tap(named(v.host, 'Photos'));
  assert.equal(named(v.host, 'Cancel'), null, 'nothing to cancel before a video is being made smaller');
  await act(async () => hooks.progress({ index: 2, count: 3, fraction: 0.43 }));
  assert.match(v.host.textContent!, /Making video 2 of 3 smaller… 43%/);
  assert.ok(
    v.host.querySelector('[aria-label="Making video 2 of 3 smaller"]'),
    'a screen reader hears what is happening, not every percent',
  );
  await act(async () => hooks.progress({ index: 1, count: 1, fraction: 0.1 }));
  assert.match(v.host.textContent!, /Making the video smaller… 10%/);
  await act(async () => hooks.progress({ index: 1, count: 1, fraction: 0.2, retry: true }));
  assert.match(v.host.textContent!, /Trying a smaller size for the video… 20%/);
  await act(async () => hooks.progress({ index: 2, count: 3, fraction: 0.5, retry: true }));
  assert.match(v.host.textContent!, /Trying a smaller size for video 2 of 3… 50%/);
  await tap(named(v.host, 'Cancel'));
  assert.equal(hooks.signal.aborted, true);
  await act(async () => late.resolve({ picked: [clip('ready.mp4')], refused: [], cancelled: true }));
  await flush();
  assert.deepEqual(
    f.added.map((x) => x.name),
    ['ready.mp4'],
    'what was ready is in the message',
  );
  assert.deepEqual(closed, [], 'and the sheet stays');
  assert.doesNotMatch(v.host.textContent!, /Making|could not/);
  assert.equal(named(v.host, 'Cancel'), null);
  await v.done();
});

test('closing the sheet while a video is made smaller stops it', async () => {
  const late = deferred<any>();
  const m = fakeMedia();
  let hooks: any = null;
  m.media.library = ((_room: number, h: any) => ((hooks = h), late.promise)) as any;
  const sheet = (open: boolean) => createElement(AddToSessionSheet, { open, onClose: () => {}, media: m.media, files: fakeFiles().files });
  const v = await mount(sheet(true));
  await tap(named(v.host, 'Photos'));
  assert.equal(hooks.signal.aborted, false);
  await v.render(sheet(false));
  assert.equal(hooks.signal.aborted, true, 'the export is told to stop');
  await act(async () => late.resolve({ picked: [], refused: [], cancelled: true }));
  await v.done();
});

test('"long videos take a while." is said only once the picker has handed over a pick with a video and reading it has run long: not while someone browses, and not for photos', async () => {
  const late = deferred<any>();
  const m = fakeMedia();
  let hooks: any = null;
  m.media.library = ((_room: number, h: any) => ((hooks = h), late.promise)) as any;
  const before = hint.after;
  hint.after = 20;
  const wait = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 60)));
  try {
    const v = await mount(createElement(AddToSessionSheet, { open: true, onClose: () => {}, media: m.media, files: fakeFiles().files }));
    await tap(named(v.host, 'Photos'));
    await wait();
    assert.doesNotMatch(v.host.textContent!, /long videos/, 'the person is still in the picker');
    await act(async () => hooks.handed({ videos: 0 }));
    await wait();
    assert.doesNotMatch(v.host.textContent!, /long videos/, 'photos only');
    await act(async () => hooks.handed({ videos: 2 }));
    assert.doesNotMatch(v.host.textContent!, /long videos/, 'not at once');
    await wait();
    assert.match(v.host.textContent!, /Getting your selection… long videos take a while\./);
    await act(async () => hooks.progress({ index: 1, count: 2, fraction: 0.1 }));
    assert.doesNotMatch(v.host.textContent!, /long videos/, 'the real progress takes its place');
    await act(async () => late.resolve({ picked: [], refused: [] }));
    await flush();
    assert.doesNotMatch(v.host.textContent!, /Getting your selection/);
    await v.done();
  } finally {
    hint.after = before;
  }
});
