// A user message's pictures (src/components/thread/view/MessageImages.tsx), and a new chat's starting bubble
// (src/components/thread/StartingChat.tsx) drawing a pasted image as its picture rather than a "Pasted image" chip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement: h } = await import('react');

const reads: string[] = [];
installNativeStub({
  fs: {
    readImageDataUrl: async (p: string) => {
      reads.push(p);
      return p.includes('gone') ? null : `data:${p}`;
    },
  },
});
const store = fakeStore<any>({ runtime: {} });
stubStore({ useStore: store.useStore });
mockSource('src/components/tasks/TasksPill.tsx', { InlineTasksCount: () => null });
const { createRoot } = await import('react-dom/client');
const { rememberSentImages } = await import('../src/lib/sentImages.ts');
const { MessageImages } = await import('../src/components/thread/view/MessageImages.tsx');
const { StartingChat } = await import('../src/components/thread/StartingChat.tsx');

async function mount(t: any, element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  // the pictures a message reads from their files arrive inside act
  await act(async () => {
    root.render(element);
    await new Promise((r) => setTimeout(r, 0));
  });
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  return host;
}

test('a new chat starting with a pasted image shows the picture, pulsing and not yet zoomable, never a "Pasted image" chip', async (t) => {
  const host = await mount(
    t,
    h(StartingChat, {
      text: 'Why is this here?',
      ux: 'dots',
      attachments: [
        { kind: 'image', path: '/tmp/paste-1.png', name: 'Pasted image', previewUrl: 'data:image/png;base64,AA' },
        { kind: 'file', path: '/repo/a.ts', name: 'a.ts' },
        { kind: 'skill', path: '/skills/review', name: 'review', displayName: 'Review' },
      ],
    }),
  );
  const row = host.querySelector('.user-message > .user-images')!;
  assert.equal(row.className, 'user-images pending');
  const img = row.querySelector('img')!;
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,AA');
  assert.equal(img.className, 'user-image');
  assert.equal(img.getAttribute('role'), null, 'not a button while it is being sent');
  const chips = [...host.querySelectorAll('.mention-chip')].map((c) => c.textContent);
  assert.deepEqual(chips, ['@a.ts', 'review'], 'the names the sent message shows');
  assert.ok(!host.textContent!.includes('Pasted image'));
  assert.equal(host.querySelector('.user-bubble')!.textContent, 'Why is this here?');
});

test('a starting image without a preview is read from its file; one that is gone leaves no picture and no chip', async (t) => {
  const host = await mount(
    t,
    h(StartingChat, {
      text: '',
      ux: 'shimmer',
      attachments: [
        { kind: 'image', path: '/tmp/shot.png', name: 'Pasted image' },
        { kind: 'image', path: '/tmp/gone.png', name: 'Pasted image' },
      ],
    }),
  );
  assert.deepEqual(reads.slice(-2), ['/tmp/shot.png', '/tmp/gone.png']);
  const imgs = [...host.querySelectorAll('.user-images img')].map((i) => i.getAttribute('src'));
  assert.deepEqual(imgs, ['data:/tmp/shot.png']);
  assert.equal(host.querySelector('.user-images')!.className, 'user-images several pending');
  assert.equal(host.querySelector('.user-mentions'), null);
  assert.equal(host.querySelector('.user-bubble'), null);
});

test('a sent message’s pictures open in the lightbox; several are laid out side by side; none draws nothing', async (t) => {
  const host = await mount(
    t,
    h('div', null, [
      h(MessageImages, { key: 'one', images: [{ src: 'data:one' }] }),
      h(MessageImages, { key: 'two', images: [{ src: 'data:a' }, { path: '/tmp/b.png' }] }),
      h(MessageImages, { key: 'none', images: [] }),
    ]),
  );
  const rows = [...host.querySelectorAll('.user-images')];
  assert.deepEqual(
    rows.map((r) => r.className),
    ['user-images', 'user-images several'],
  );
  const first = rows[0].querySelector('img')!;
  assert.equal(first.getAttribute('role'), 'button');
  assert.match(first.className, /zoomable-image user-image/);
  assert.deepEqual(
    [...rows[1].querySelectorAll('img')].map((i) => i.getAttribute('src')),
    ['data:a', 'data:/tmp/b.png'],
  );
});

test('a picture the composer sent is shown from memory, not read again; only the latest 32 are kept', async (t) => {
  const image = (path: string, previewUrl?: string) => ({ kind: 'image' as const, path, name: 'Pasted image', previewUrl });
  rememberSentImages([image('/tmp/kept.png', 'data:kept'), { kind: 'file', path: '/repo/a.ts', name: 'a.ts' }, image('/tmp/none.png')]);
  rememberSentImages([image('/tmp/kept.png', 'data:kept-again')]);
  rememberSentImages(Array.from({ length: 32 }, (_, i) => image(`/tmp/n${i}.png`, `data:n${i}`)));
  rememberSentImages([image('/tmp/n0.png', 'data:n0-again')]);
  const before = reads.length;
  const host = await mount(t, h(MessageImages, { images: [{ path: '/tmp/n0.png' }, { path: '/tmp/n31.png' }, { path: '/tmp/kept.png' }] }));
  assert.deepEqual(
    [...host.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    ['data:n0-again', 'data:n31', 'data:/tmp/kept.png'],
  );
  assert.deepEqual(reads.slice(before), ['/tmp/kept.png'], 'the oldest picture went, so only it is read from its file');
});
