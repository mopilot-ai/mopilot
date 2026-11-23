// A user message's pictures read back from their machine when the chat is drawn from history (src/components/thread/view/MessageImages.tsx, src/lib/hostPicture.ts): a placeholder while fetched, the thumbnail, "offline" and "no longer on" lines, and a chat that runs here untouched.
import { test, beforeEach } from 'node:test';
import { waitFor } from './support/waitFor.ts';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement: h } = await import('react');

const asked: string[][] = [];
let answer: (chatId: string, url: string) => Promise<any> = async () => ({ gone: true });
const fileReads: string[] = [];
installNativeStub({
  host: {
    picture: (chatId: string, url: string) => (asked.push([chatId, url]), answer(chatId, url)),
  },
  fs: {
    readImageDataUrl: async (p: string) => (fileReads.push(p), p.includes('pruned') ? Promise.reject(new Error('ENOENT')) : `data:${p}`),
  },
});
let machines: any[] = [];
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
stubStore({ useStore: fakeStore<any>({ runtime: {} }).useStore });
mockSource('src/components/tasks/TasksPill.tsx', { InlineTasksCount: () => null });
const { createRoot } = await import('react-dom/client');
const { MessageImages } = await import('../src/components/thread/view/MessageImages.tsx');
const { resetHostPictures, isHostPicture, MAX_KEPT_CHARS, RE_ASK_MS, useHostPicture } = await import('../src/lib/hostPicture.ts');

const REF = 'host-image:abc';
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function mount(t: any, element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(element));
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  return { host, root };
}

beforeEach(() => {
  machines = [];
  resetHostPictures();
  asked.length = 0;
  fileReads.length = 0;
});

test('a reopened machine chat shows a placeholder, then the picture the machine returns, which opens in the lightbox', async (t) => {
  let release!: (v: any) => void;
  answer = () => new Promise((r) => (release = r));
  const { host } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  assert.ok(host.querySelector('.user-image-loading'), 'a placeholder while it is fetched');
  assert.equal(host.querySelector('img'), null);
  await act(async () => release({ picture: 'data:image/png;base64,AA' }));
  assert.equal(host.querySelector('.user-image-loading'), null);
  const img = host.querySelector('img')!;
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,AA');
  assert.equal(img.getAttribute('role'), 'button');
  assert.deepEqual(asked, [['chat', REF]]);
});

test('a machine that is away says so by name, and is asked again when the message is drawn again', async (t) => {
  answer = async () => ({ offline: 'Studio' });
  const first = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.equal(first.host.querySelector('.user-image-missing')!.textContent, 'Picture is on Studio, offline Try again');
  answer = async () => ({ picture: 'data:p' });
  await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.equal(asked.length, 2);
});

test('a picture the machine no longer has, or a read that fails, says it is no longer there', async (t) => {
  answer = async () => ({ gone: true, machine: 'Studio' });
  const named = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.equal(named.host.querySelector('.user-image-missing')!.textContent, 'Picture is no longer on Studio');
  answer = async () => Promise.reject(new Error('bridge down'));
  const failed = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:other' }] }));
  await settle();
  assert.equal(failed.host.querySelector('.user-image-missing')!.textContent, 'Picture is no longer on the machine');
});

test('a fetched picture is kept: the same picture drawn again, or twice at once, asks the machine once', async (t) => {
  answer = async () => ({ picture: 'data:kept' });
  await mount(
    t,
    h('div', null, [
      h(MessageImages, { key: 'a', chatId: 'chat', images: [{ src: REF }] }),
      h(MessageImages, { key: 'b', chatId: 'chat', images: [{ src: REF }] }),
    ]),
  );
  await settle();
  const again = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.equal(again.host.querySelector('img')!.getAttribute('src'), 'data:kept');
  assert.equal(asked.length, 1);
});

test('a message gone from the screen before the machine answers is left alone, and the oldest kept pictures are let go', async (t) => {
  let release!: (v: any) => void;
  answer = () => new Promise((r) => (release = r));
  const { host, root } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await act(async () => root.render(h('div')));
  await act(async () => release({ picture: 'data:late' }));
  assert.equal(host.querySelector('img'), null);
  answer = async (_c, url) => ({ picture: `data:${url}` });
  for (let i = 0; i < 66; i++) {
    const one = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: `host-image:${i}` }] }));
    await settle();
    assert.equal(one.host.querySelector('img')!.getAttribute('src'), `data:host-image:${i}`);
  }
  asked.length = 0;
  await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:0' }] }));
  await settle();
  assert.deepEqual(asked, [['chat', 'host-image:0']], 'the first was let go, so it is asked again');
});

test('a failure says what it is, in plain words: not paired, a Host to update, or a plain failure with Try again that asks again at once', async (t) => {
  answer = async () => ({ blocked: 'Studio' });
  const blocked = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.equal(blocked.host.querySelector('.user-image-missing')!.textContent, 'Pair with Studio again to see this picture');
  answer = async () => ({ update: 'Studio' });
  const old = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:old' }] }));
  await settle();
  assert.equal(old.host.querySelector('.user-image-missing')!.textContent, 'Update Studio to see this picture');
  answer = async () => ({ retry: 'Studio' });
  const failed = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:flaky' }] }));
  await settle();
  const line = failed.host.querySelector('.user-image-missing')!;
  assert.equal(line.textContent, "Couldn't load the picture Try again");
  asked.length = 0;
  answer = async () => ({ picture: 'data:back' });
  await act(async () => (line.querySelector('button') as HTMLButtonElement).click());
  await settle();
  assert.deepEqual(asked, [['chat', 'host-image:flaky']]);
  assert.equal(failed.host.querySelector('img')!.getAttribute('src'), 'data:back');
});

test('a picture this Mac just sent is drawn from the file it attached, and from the machine once that file is gone', async (t) => {
  const here = await mount(
    t,
    h(MessageImages, {
      chatId: 'chat',
      images: [{ src: REF, path: '/tmp/paste.png' }],
    }),
  );
  await settle();
  assert.equal(here.host.querySelector('img')!.getAttribute('src'), 'data:/tmp/paste.png');
  assert.deepEqual(asked, [], 'the machine is not asked while the file is there');
  // while it is being sent the file's picture does not open
  const pending = await mount(
    t,
    h(MessageImages, {
      chatId: 'chat',
      pending: true,
      images: [{ src: REF, path: '/tmp/paste.png' }],
    }),
  );
  await settle();
  assert.equal(pending.host.querySelector('img')!.getAttribute('role'), null);
  // a day later the temporary file is pruned: the machine has the picture
  answer = async () => ({ picture: 'data:from-machine' });
  const later = await mount(
    t,
    h(MessageImages, {
      chatId: 'chat',
      images: [{ src: REF, path: '/tmp/pruned.png' }],
    }),
  );
  await settle();
  assert.equal(later.host.querySelector('img')!.getAttribute('src'), 'data:from-machine');
  assert.deepEqual(asked, [['chat', REF]]);
  assert.ok(fileReads.includes('/tmp/pruned.png'), 'its file was tried first');
});

test('what is kept is bounded by weight too: pictures over the bound push the oldest out, and one over it alone is not kept', async (t) => {
  const heavy = (c: string) => `data:${c.repeat(Math.floor(MAX_KEPT_CHARS * 0.6))}`;
  answer = async (_c, url) => ({ picture: heavy(url.slice(-1)) });
  for (const name of ['host-image:a', 'host-image:b']) {
    await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: name }] }));
    await settle();
  }
  asked.length = 0;
  await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:b' }] }));
  await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:a' }] }));
  await settle();
  assert.deepEqual(asked, [['chat', 'host-image:a']], 'b is kept, a was pushed out by its weight');
  answer = async () => ({ picture: `data:${'z'.repeat(MAX_KEPT_CHARS)}` });
  asked.length = 0;
  for (let i = 0; i < 2; i++) {
    await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:huge' }] }));
    await settle();
  }
  assert.equal(asked.length, 2, 'too heavy to keep, so asked each time it is drawn');
});

test('a chat that runs here is untouched: a data URL and an image file never ask a machine', async (t) => {
  const { host } = await mount(t, h(MessageImages, { images: [{ src: 'data:image/png;base64,BB' }, { path: '/tmp/a.png' }] }));
  await settle();
  assert.deepEqual(
    [...host.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    ['data:image/png;base64,BB', 'data:/tmp/a.png'],
  );
  assert.deepEqual(asked, []);
  assert.deepEqual([isHostPicture(undefined), isHostPicture('data:x'), isHostPicture(REF)], [false, false, true]);
});

test('an offline picture offers Try again and asks again when a machine comes back online, not for machines already online', async (t) => {
  machines = [{ id: 'other', status: 'online' }];
  answer = async () => ({ offline: 'Studio' });
  const { host, root } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.match(host.querySelector('.user-image-missing')!.textContent!, /^Picture is on Studio, offline/);
  assert.equal(asked.length, 1, 'a machine already online is not news');
  machines = [
    { id: 'other', status: 'online' },
    { id: 'box', status: 'online' },
  ];
  answer = async () => ({ picture: 'data:image/png;base64,AA' });
  await act(async () => root.render(h(MessageImages, { chatId: 'chat', images: [{ src: REF }] })));
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(host.querySelector('img')!.getAttribute('src'), 'data:image/png;base64,AA');
  // Try again asks at once
  resetHostPictures();
  answer = async () => ({ offline: 'Studio' });
  const manual = await mount(t, h(MessageImages, { chatId: 'chat2', images: [{ src: REF }] }));
  await settle();
  answer = async () => ({ picture: 'data:p2' });
  await act(async () => (manual.host.querySelector('.user-image-retry') as any).click());
  await settle();
  assert.equal(manual.host.querySelector('img')!.getAttribute('src'), 'data:p2');
});

/** Moves the clock the re-asks wait on, then lets what it started settle. */
async function wait(t: any, ms: number) {
  await act(async () => t.mock.timers.tick(ms));
  await settle();
}
const bubble = (host: any) => host.querySelector('.user-image-missing')?.textContent;

test('a picture that answered retry is asked again by itself after the first wait, and draws without a click once the machine answers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async () => ({ retry: 'Studio' });
  const { host } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  assert.match(bubble(host), /^Couldn't load the picture/);
  await wait(t, RE_ASK_MS[0] - 1);
  assert.equal(asked.length, 1, 'not before the wait is over');
  answer = async () => ({ picture: 'data:image/png;base64,AA' });
  await wait(t, 1);
  await waitFor(() => host.querySelector('img'), 'the picture drawn after the re-ask');
  assert.equal(asked.length, 2);
  await wait(t, RE_ASK_MS[1]);
  assert.equal(asked.length, 2, 'a drawn picture is not asked again');
});

test('a machine that stays unreachable is asked a bounded number of times, then keeps Try again, which starts the waits over', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let release: ((v: any) => void) | undefined;
  answer = async () => ({ retry: 'Studio' });
  const { host } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  for (const [i, ms] of RE_ASK_MS.entries()) {
    await wait(t, ms - 1);
    assert.equal(asked.length, i + 1);
    await wait(t, 1);
    assert.equal(asked.length, i + 2, `re-ask ${i + 1} after ${ms} ms`);
  }
  await wait(t, 10 * RE_ASK_MS[2]);
  assert.equal(asked.length, RE_ASK_MS.length + 1, 'no more by itself');
  assert.match(bubble(host), /Try again$/);
  // a pending ask is never joined by another: nothing is armed while the answer is on its way
  answer = () => new Promise((r) => (release = r));
  await act(async () => (host.querySelector('.user-image-retry') as any).click());
  const afterClick = asked.length;
  await wait(t, RE_ASK_MS[0] * 3);
  assert.equal(asked.length, afterClick, 'one ask at a time');
  await act(async () => release!({ retry: 'Studio' }));
  await settle();
  await wait(t, RE_ASK_MS[0]);
  assert.equal(asked.length, afterClick + 1, 'the click started the waits from the first');
});

test('leaving the screen or drawing another picture stops the waiting re-ask', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async (_c, url) => (url === REF ? { retry: 'Studio' } : { picture: 'data:other' });
  const { root } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  await act(async () => root.render(h(MessageImages, { chatId: 'chat', images: [{ src: 'host-image:other' }] })));
  await settle();
  asked.length = 0;
  await wait(t, 10 * RE_ASK_MS[2]);
  assert.deepEqual(asked, [], 'the first picture is not asked after another is drawn');
  await act(async () => root.render(h(MessageImages, { chatId: 'chat', images: [{ src: REF }] })));
  await settle();
  asked.length = 0;
  await act(async () => root.render(h('div')));
  await wait(t, 10 * RE_ASK_MS[2]);
  assert.deepEqual(asked, [], 'an unmounted picture is not asked');
});

test('an offline picture is asked again by itself only while its machine reports online', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  machines = [{ id: 'box', name: 'Studio', status: 'offline' }];
  answer = async () => ({ offline: 'Studio' });
  const { host, root } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  await wait(t, 10 * RE_ASK_MS[2]);
  assert.equal(asked.length, 1, 'an offline machine waits for the machine, not the clock');
  // the machine reports online again, and the picture is there
  machines = [{ id: 'box', name: 'Studio', status: 'online' }];
  answer = async () => ({ picture: 'data:back' });
  await act(async () => root.render(h(MessageImages, { chatId: 'chat', images: [{ src: REF }] })));
  await settle();
  await waitFor(() => host.querySelector('img'), 'the picture once the machine is back');
  // an online machine that still answers offline is asked on the clock
  resetHostPictures();
  asked.length = 0;
  answer = async () => ({ offline: 'Studio' });
  await mount(t, h(MessageImages, { chatId: 'chat3', images: [{ src: REF }] }));
  await settle();
  await wait(t, RE_ASK_MS[0]);
  assert.equal(asked.length, 2);
});

test('one hook instance moved to another picture starts the waits over for it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async () => ({ retry: 'Studio' });
  const Probe = ({ src }: { src: string }) => h('p', { className: 'state' }, useHostPicture('chat', src).state);
  const { host, root } = await mount(t, h(Probe, { src: 'host-image:a' }));
  await settle();
  await wait(t, RE_ASK_MS[0]);
  assert.equal(asked.length, 2, 'the first picture used its first wait');
  await act(async () => root.render(h(Probe, { src: 'host-image:b' })));
  await settle();
  asked.length = 0;
  await wait(t, RE_ASK_MS[0]);
  assert.deepEqual(asked, [['chat', 'host-image:b']], 'the second picture waits its own first wait');
  assert.equal(host.querySelector('.state')!.textContent, 'retry');
});

test('a window that takes focus before the wait is over does not spend the schedule', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async () => ({ retry: 'Studio' });
  await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  for (let i = 0; i < 3; i++) {
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await wait(t, 1000);
  }
  assert.equal(asked.length, 1, 'three focus events inside the first wait asked nothing');
  await wait(t, RE_ASK_MS[0]);
  assert.equal(asked.length, 2, 'the first wait still ends at its time');
});

test('while an automatic re-ask is on its way the last answer and its Try again stay, and the next wait starts only after it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async () => ({ retry: 'Studio' });
  const { host } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  let release!: (v: any) => void;
  answer = () => new Promise((r) => (release = r));
  await wait(t, RE_ASK_MS[0]);
  assert.equal(asked.length, 2);
  assert.equal(host.querySelector('.user-image-loading'), null, 'no placeholder for a re-ask');
  assert.match(bubble(host), /Trying…$/);
  await wait(t, 10 * RE_ASK_MS[2]);
  assert.equal(asked.length, 2, 'nothing else is asked while it is pending');
  await act(async () => release({ retry: 'Studio' }));
  await settle();
  await wait(t, RE_ASK_MS[1]);
  assert.equal(asked.length, 3, 'the next wait is the second one');
});

test('a picture drawn again after another starts its waits from the first', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async () => ({ retry: 'Studio' });
  const Probe = ({ src }: { src: string }) => h('p', null, useHostPicture('chat', src).state);
  const { root } = await mount(t, h(Probe, { src: 'host-image:a' }));
  await settle();
  await wait(t, RE_ASK_MS[0]);
  await act(async () => root.render(h(Probe, { src: 'host-image:b' })));
  await settle();
  await act(async () => root.render(h(Probe, { src: 'host-image:a' })));
  await settle();
  asked.length = 0;
  await wait(t, RE_ASK_MS[0]);
  assert.equal(asked.length, 1, 'A waits its first wait again, not its second');
});

test('Try again keeps the last line on screen, with a disabled Trying…, while the ask is pending, then shows its result', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  answer = async () => ({ offline: 'Studio' });
  const { host } = await mount(t, h(MessageImages, { chatId: 'chat', images: [{ src: REF }] }));
  await settle();
  const button = () => host.querySelector('.user-image-retry') as any;
  let release!: (v: any) => void;
  answer = () => new Promise((r) => (release = r));
  await act(async () => button().click());
  for (const ms of [100, 400, 5000, 10_000]) {
    await wait(t, ms);
    assert.equal(host.querySelector('.user-image-loading'), null, `no placeholder after ${ms} ms`);
    assert.match(bubble(host), /^Picture is on Studio, offline Trying…$/);
    assert.equal(button().disabled, true);
  }
  assert.equal(asked.length, 2, 'one ask while it is pending');
  await act(async () => release({ retry: 'Studio' }));
  await settle();
  assert.match(bubble(host), /^Couldn't load the picture Try again$/);
  assert.equal(button().disabled, false);
  answer = async () => ({ picture: 'data:p3' });
  await act(async () => button().click());
  await settle();
  assert.equal(host.querySelector('img')!.getAttribute('src'), 'data:p3');
});
