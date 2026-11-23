// The browser pane's Downloads button, panel and Download complete notice (src/components/panels/browserPanel/Downloads.tsx)
// and the rules they show the list by (src/lib/browserDownloads.ts): the words per state, the button's ring and dot, which
// pane tells of a download that ended (in its slot under the toolbar), and what each action does or says when it couldn't.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement } = React;
const f: any = { calls: [] as any[][], handlers: {} as Record<string, (...a: any[]) => any>, subs: new Map<string, Function>() };
const call =
  (name: string) =>
  (...a: any[]) => (f.calls.push([name, ...a]), f.handlers[name](...a));
const sub = (name: string) => (cb: Function) => {
  f.subs.set(name, cb);
  f.calls.push(['sub', name]);
  return () => (f.subs.delete(name), f.calls.push(['unsub', name]));
};
installNativeStub({
  browser: {
    downloads: call('downloads'),
    downloadAct: call('downloadAct'),
    downloadsSeen: call('downloadsSeen'),
    openDownloadsFolder: call('openDownloadsFolder'),
    onDownloads: sub('downloads'),
    onDownloadDone: sub('done'),
  },
});
stubStore({ toast: (...a: unknown[]) => f.calls.push(['toast', ...a]) });
mockSource('src/session/clipboard.ts', { copyText: (...a: unknown[]) => f.calls.push(['copy', ...a]) });
mockSource('src/components/ui/Popover.tsx', popoverStubs({ item: 'button' }));
const { createRoot } = await import('react-dom/client');
const { BrowserDownloads, NOTICE_SLOT } = await import('../src/components/panels/browserPanel/Downloads.tsx');
const lib = await import('../src/lib/browserDownloads.ts');
const { formatBytes, downloadStatus, downloadsButton, peeks, actFailure, PEEK_MS } = lib;

const entry = (o: Partial<import('../src/lib/browserDownloads.ts').DownloadEntry> = {}) => ({
  id: 'd1',
  name: 'report.csv',
  path: '/Users/me/Downloads/report.csv',
  url: 'https://site.test/report.csv',
  state: 'completed' as const,
  received: 37,
  total: 37,
  startedAt: 1000,
  endedAt: 2000,
  agent: false,
  pageId: 10,
  exists: true,
  stopping: false,
  canResume: false,
  ...o,
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
let props: { pages: () => (number | null)[]; front: boolean };
/** Mounts the button in a pane's toolbar, beside the pane's notice slot (BrowserPanel); slot: false, a pane without one. */
async function mount(slot = true, host = 'browser-pane') {
  container = document.createElement('div');
  container.className = host;
  const bar = document.createElement('div');
  container.append(bar);
  if (slot) container.append(Object.assign(document.createElement('div'), { className: NOTICE_SLOT }));
  document.body.append(container);
  root = createRoot(bar);
  await act(async () => root!.render(createElement(BrowserDownloads, props)));
}
async function render(view: any, p: Partial<typeof props> = {}, slot = true, host?: string) {
  f.handlers.downloads = async () => view;
  f.handlers.downloadsSeen = async () => true;
  f.handlers.downloadAct = async () => ({ ok: true });
  f.handlers.openDownloadsFolder = async () => ({ ok: true });
  props = { pages: () => [10, 11], front: true, ...p };
  await mount(slot, host);
}
const rerender = (p: Partial<typeof props>) => act(async () => root!.render(createElement(BrowserDownloads, { ...props, ...p })));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  f.calls = [];
  f.subs.clear();
});
const click = (el: Element) => act(async () => void el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
const button = () => container.querySelector('.browser-downloads-btn') as HTMLButtonElement | null;
const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const byText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
const push = (view: any) => act(async () => f.subs.get('downloads')!(view));
const done = (e: any) => act(async () => f.subs.get('done')!(e));
const calls = (name: string) => f.calls.filter((c: any[]) => c[0] === name);

test('sizes and status words per state, as the Codex app writes them', () => {
  assert.deepEqual([0, 1, 37, 999, 1000, 1234, 15_500, 2_500_000, 9.99e12, 4.2e15].map(formatBytes), [
    '0 bytes',
    '1 byte',
    '37 bytes',
    '999 bytes',
    '1 KB',
    '1.2 KB',
    '16 KB',
    '2.5 MB',
    '10 TB',
    '4200 TB',
  ]);
  const time = (ms: number) => `t${ms}`;
  const s = (o: any) => downloadStatus(entry(o), time);
  assert.equal(s({}), 'Downloaded · 37 bytes · t2000');
  assert.equal(s({ total: 0, received: 12 }), 'Downloaded · 12 bytes · t2000', 'size unknown: what arrived');
  assert.equal(s({ exists: false }), 'File moved or deleted · t2000');
  assert.equal(s({ state: 'cancelled' }), 'Stopped · t2000');
  assert.equal(s({ state: 'interrupted' }), 'Download failed · t2000');
  assert.equal(s({ state: 'progressing', received: 0, total: 0, endedAt: null }), 'Starting');
  assert.equal(s({ state: 'progressing', received: 1500, total: 3_000_000, endedAt: null }), '1.5 KB of 3 MB');
  assert.equal(s({ state: 'progressing', received: 1500, total: 0, endedAt: null }), '1.5 KB');
  assert.equal(s({ state: 'progressing', stopping: true }), 'Stopping…');
  assert.equal(s({ state: 'paused', received: 10, total: 20 }), 'Paused · 10 bytes of 20 bytes');
  // the real clock words: an hour and minutes
  assert.match(downloadStatus(entry({ state: 'cancelled' })), /^Stopped · \d{1,2}:\d{2}/);
});

test('the button: hidden with nothing; a ring for downloads under way; a dot for finished ones not looked at', () => {
  const v = (downloads: any[], unseen: string[] = []) => downloadsButton({ downloads, unseen });
  assert.deepEqual(v([]), { shown: false, active: 0, percent: null, attention: null, label: 'Downloads' });
  const a = entry({ id: 'a', state: 'progressing', received: 25, total: 100 });
  const b = entry({ id: 'b', state: 'progressing', received: 300, total: 100 });
  assert.deepEqual(v([a, b]), {
    shown: true,
    active: 2,
    percent: 63,
    attention: null,
    label: 'Downloads, 2 active downloads, 63% complete',
  });
  assert.equal(v([a, entry({ id: 'c', state: 'progressing', total: 0 })]).label, 'Downloads, 2 active downloads in progress');
  assert.equal(v([entry({ state: 'paused' })]).label, 'Downloads, 1 download paused');
  assert.equal(v([entry({ state: 'paused' }), entry({ id: 'x', state: 'paused' })]).label, 'Downloads, 2 downloads paused');
  assert.equal(v([a]).label, 'Downloads, 1 active download, 25% complete');
  const ok = entry({ id: 'ok' });
  const bad = entry({ id: 'bad', state: 'interrupted' });
  assert.deepEqual([v([ok], ['ok']).attention, v([ok], ['ok']).label], ['completion', 'Downloads, 1 completed download ready']);
  assert.equal(v([ok, entry({ id: 'ok2' })], ['ok', 'ok2']).label, 'Downloads, 2 completed downloads ready');
  assert.deepEqual(
    [v([ok, bad], ['ok', 'bad']).attention, v([ok, bad], ['ok', 'bad']).label],
    ['failure', 'Downloads, 1 failed download needs attention'],
  );
  assert.equal(
    v([bad, entry({ id: 'bad2', state: 'interrupted' })], ['bad', 'bad2']).label,
    'Downloads, 2 failed downloads need attention',
  );
  assert.equal(v([entry({ id: 's', state: 'cancelled' })], ['s']).attention, null, 'Stopped calls nobody back');
});

test('which pane peeks: a download the user started that Downloaded or failed, from a page it shows in front', () => {
  assert.equal(peeks(entry(), [10], true), true);
  assert.equal(peeks(entry({ state: 'interrupted' }), [null, 10], true), true);
  assert.equal(peeks(entry(), [10], false), false, 'behind another tab');
  assert.equal(peeks(entry({ agent: true }), [10], true), false, "the agent's result says where it went");
  assert.equal(peeks(entry({ pageId: null }), [null], true), false);
  assert.equal(peeks(entry({ pageId: 12 }), [10, 11], true), false, 'another pane');
  assert.equal(peeks(entry({ state: 'cancelled' }), [10], true), false, 'the user stopped it');
});

test('what a failed action says', () => {
  assert.equal(actFailure('open', { ok: true }), null);
  assert.equal(actFailure('show', { ok: false, reason: 'missing' }), 'This download is no longer available');
  assert.equal(actFailure('open', { ok: false, reason: 'open-failed', message: 'No app' }), 'Unable to open the downloaded file: No app');
  assert.equal(actFailure('open', { ok: false, reason: 'failed' }), 'Unable to open the downloaded file');
  assert.equal(actFailure('show', { ok: false, reason: 'failed' }), 'Unable to show the downloaded file in its folder');
  assert.equal(actFailure('resume', { ok: false, reason: 'not-resumable' }), 'This download cannot be resumed');
  assert.equal(actFailure('remove', { ok: false, reason: 'active' }), 'Active downloads cannot be removed');
  assert.equal(actFailure('cancel', { ok: false, reason: 'not-active' }), 'Unable to complete the download action');
});

test('the list is read once, followed while shown, and let go with the last pane; a failed read changes nothing', async () => {
  await render({ downloads: [], unseen: [] });
  assert.equal(button(), null, 'no download yet: no button');
  assert.deepEqual(
    calls('sub').map((c) => c[1]),
    ['downloads', 'done'],
  );
  assert.equal(calls('downloads').length, 1);
  await push({ downloads: [entry({ state: 'progressing', received: 50, total: 200 })], unseen: [] });
  assert.equal(button()!.getAttribute('aria-label'), 'Downloads, 1 active download, 25% complete');
  assert.equal(button()!.getAttribute('data-active'), 'true');
  assert.equal(button()!.style.getPropertyValue('--download-progress'), '25%');
  assert.equal(button()!.getAttribute('data-sized'), 'true');
  await push({ downloads: [entry({ state: 'progressing', total: 0 })], unseen: [] });
  assert.equal(button()!.getAttribute('data-sized'), 'false', 'sizes unknown: the ring turns');
  await push({ downloads: [entry({ state: 'interrupted' })], unseen: ['d1'] });
  assert.equal(button()!.getAttribute('data-attention'), 'failure');
  await act(async () => root!.unmount());
  root = null;
  assert.deepEqual(
    calls('unsub')
      .map((c) => c[1])
      .sort(),
    ['done', 'downloads'],
  );
  // a read that fails leaves what the window had
  f.handlers.downloads = async () => {
    throw new Error('main gone');
  };
  await mount();
  assert.ok(button(), 'the last list it had');
  // two panes share one subscription
  const second = createRoot(document.createElement('div'));
  await act(async () => second.render(createElement(BrowserDownloads, props)));
  assert.equal(calls('sub').filter((c) => c[1] === 'downloads').length, 2, 'one more for this mount, none for the second pane');
  await act(async () => second.unmount());
  assert.equal(calls('unsub').filter((c) => c[1] === 'downloads').length, 1, 'still followed for the first pane');
});

test('the panel: opening marks everything seen and reads the files again; rows, their buttons and menus act by id', async () => {
  const rows = [
    entry({ id: 'live', name: 'live.zip', state: 'progressing', received: 10, total: 40 }),
    entry({ id: 'odd', name: 'odd.bin', state: 'progressing', received: 10, total: 0, url: '', path: '' }),
    entry({ id: 'paused', name: 'paused.zip', state: 'paused', canResume: true, received: 5, total: 10 }),
    entry({ id: 'ok', name: 'report.csv' }),
    entry({ id: 'gone', name: 'gone.csv', exists: false }),
    entry({ id: 'stop', name: 'stop.csv', state: 'cancelled' }),
    entry({ id: 'bad', name: 'bad.csv', state: 'interrupted' }),
  ];
  await render({ downloads: rows, unseen: ['ok'] });
  assert.equal(button()!.getAttribute('data-attention'), 'completion');
  await click(button()!);
  assert.equal(button()!.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(calls('downloadsSeen'), [['downloadsSeen']]);
  assert.equal(calls('downloads').length, 2, 'read again as it opens');
  const items = [...container.querySelectorAll('.browser-download')];
  assert.deepEqual(
    items.map((li) => [
      li.getAttribute('data-state'),
      li.hasAttribute('data-gone'),
      li.querySelector('.browser-download-status')!.textContent,
    ]),
    [
      ['progressing', false, '10 bytes of 40 bytes'],
      ['progressing', false, '10 bytes'],
      ['paused', false, 'Paused · 5 bytes of 10 bytes'],
      ['completed', false, downloadStatus(rows[3])],
      ['completed', true, downloadStatus(rows[4])],
      ['cancelled', false, downloadStatus(rows[5])],
      ['interrupted', false, downloadStatus(rows[6])],
    ],
  );
  assert.equal((items[0].querySelector('.browser-download-bar > span') as HTMLElement).style.width, '25%');
  assert.equal(items[1].querySelector('.browser-download-bar')!.getAttribute('data-known'), 'false');
  assert.equal(items[3].querySelector('.browser-download-bar'), null);
  // the file's place as its tooltip; behind an unanswered save sheet there is none yet, so its name
  assert.equal(items[3].querySelector('.browser-download-text')!.getAttribute('title'), '/Users/me/Downloads/report.csv');
  assert.equal(items[1].querySelector('.browser-download-text')!.getAttribute('title'), 'odd.bin');
  // the name opens a Downloaded file; nothing else opens
  await click(byLabel('Open report.csv'));
  assert.deepEqual(calls('downloadAct').at(-1), ['downloadAct', 'ok', 'open']);
  assert.equal((items[4].querySelector('.browser-download-text') as HTMLButtonElement).disabled, true);
  await click(byLabel('Show report.csv in folder'));
  assert.deepEqual(calls('downloadAct').at(-1), ['downloadAct', 'ok', 'show']);
  assert.equal(byLabel('Show stop.csv in folder').disabled, true);
  await click(byLabel('Cancel download live.zip'));
  assert.deepEqual(calls('downloadAct').at(-1), ['downloadAct', 'live', 'cancel']);
  // the menus: what each state can do
  const menu = async (name: string) => {
    await click(byLabel(`Download actions for ${name}`));
    const labels = [...container.querySelectorAll('[role=menuitem]')].map((m) => m.textContent);
    return labels;
  };
  assert.deepEqual(await menu('report.csv'), ['Open', 'Show in folder', 'Copy download link', 'Remove from list']);
  await click(byText('Copy download link'));
  assert.deepEqual(calls('copy').at(-1), ['copy', 'https://site.test/report.csv', 'Copied download link']);
  await menu('report.csv');
  await click(byText('Open'));
  await menu('report.csv');
  await click(byText('Show in folder'));
  await menu('report.csv');
  await click(byText('Remove from list'));
  assert.deepEqual(
    calls('downloadAct')
      .slice(-3)
      .map((c) => c.slice(1)),
    [
      ['ok', 'open'],
      ['ok', 'show'],
      ['ok', 'remove'],
    ],
  );
  assert.deepEqual(await menu('paused.zip'), ['Resume download', 'Copy download link', 'Cancel download']);
  await click(byText('Resume download'));
  await menu('paused.zip');
  await click(byText('Cancel download'));
  assert.deepEqual(
    calls('downloadAct')
      .slice(-2)
      .map((c) => c.slice(1)),
    [
      ['paused', 'resume'],
      ['paused', 'cancel'],
    ],
  );
  assert.deepEqual(await menu('odd.bin'), ['Cancel download'], 'no link to copy');
  await click(byLabel('Download actions for odd.bin'));
  // an action that couldn't happen says why; one whose call failed says so too
  f.handlers.downloadAct = async () => ({ ok: false, reason: 'missing' });
  await click(byLabel('Open report.csv'));
  assert.deepEqual(calls('toast').at(-1), ['toast', 'This download is no longer available', 'error']);
  f.handlers.downloadAct = async () => {
    throw new Error('ipc');
  };
  await click(byLabel('Show report.csv in folder'));
  assert.deepEqual(calls('toast').at(-1), ['toast', 'Unable to show the downloaded file in its folder', 'error']);
  // a cancel already asked for can't be asked again
  await push({ downloads: [entry({ id: 'live', name: 'live.zip', state: 'progressing', stopping: true })], unseen: [] });
  assert.equal(byLabel('Cancel download live.zip').disabled, true);
  assert.deepEqual(await menu('live.zip'), ['Copy download link', 'Cancel download']);
  assert.equal(byText('Cancel download').disabled, true);
});

test('the panel: Open folder, and an empty list while it is open', async () => {
  await render({ downloads: [entry()], unseen: [] });
  await click(button()!);
  await click(byLabel('Open folder'));
  assert.equal(calls('openDownloadsFolder').length, 1);
  assert.equal(calls('toast').length, 0);
  f.handlers.openDownloadsFolder = async () => ({ ok: false, reason: 'open-failed' });
  await click(byLabel('Open folder'));
  f.handlers.openDownloadsFolder = async () => {
    throw new Error('ipc');
  };
  await click(byLabel('Open folder'));
  assert.deepEqual(calls('toast'), [
    ['toast', 'Unable to open the downloads folder', 'error'],
    ['toast', 'Unable to open the downloads folder', 'error'],
  ]);
  // the last one removed while the panel shows: the button stays with it, which says so
  await push({ downloads: [], unseen: [] });
  assert.ok(button());
  assert.match(container.querySelector('.browser-downloads-empty')!.textContent!, /No downloads yet/);
  // seen fails quietly
  f.handlers.downloadsSeen = async () => {
    throw new Error('ipc');
  };
  await click(button()!);
  assert.equal(button(), null, 'closed with nothing listed: no button');
});

test('the notice: Download complete under the toolbar for 5s; held while pointed at or focused; Show in folder and Open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render({ downloads: [entry()], unseen: [] });
  const peek = () => container.querySelector(`.${NOTICE_SLOT} > .browser-download-notice`) as HTMLElement | null;
  await done(entry());
  assert.equal(peek()!.getAttribute('aria-label'), 'Download complete: report.csv');
  assert.equal(container.querySelector('.browser-download-notice b')!.textContent, 'Download complete');
  assert.equal(container.querySelector('.browser-download-notice-name')!.textContent, 'report.csv');
  // progress pushes don't restart its time
  await act(async () => t.mock.timers.tick(PEEK_MS - 1));
  await push({ downloads: [entry()], unseen: ['d1'] });
  await act(async () => t.mock.timers.tick(1));
  assert.equal(peek(), null);
  // held while the pointer is on it, or focus is in it
  await done(entry());
  await act(async () => void peek()!.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }) as any));
  await act(async () => void peek()!.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }) as any));
  await act(async () => t.mock.timers.tick(PEEK_MS * 2));
  assert.ok(peek());
  await act(async () => void peek()!.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }) as any));
  await act(async () => t.mock.timers.tick(PEEK_MS * 2));
  assert.ok(peek(), 'focus still holds it');
  await act(async () => void peek()!.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as any));
  await act(async () => void peek()!.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as any));
  await act(async () => t.mock.timers.tick(PEEK_MS));
  assert.equal(peek(), null, 'let go: gone after its time');
  // Show in folder: done, the peek goes
  await done(entry());
  await click(byText('Show in folder'));
  assert.deepEqual(calls('downloadAct').at(-1), ['downloadAct', 'd1', 'show']);
  assert.equal(peek(), null);
  // Open that fails: it stays, and says why
  await done(entry());
  f.handlers.downloadAct = async () => ({ ok: false, reason: 'open-failed', message: 'No app' });
  await click(byText('Open'));
  assert.ok(peek());
  assert.deepEqual(calls('toast').at(-1), ['toast', 'Unable to open the downloaded file: No app', 'error']);
  await click(byLabel('Dismiss'));
  assert.equal(peek(), null);
});

test('the notice: failed or a file already gone offers View downloads; a newer end takes its place; where it does not show', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render({ downloads: [entry()], unseen: [] });
  const peek = () => container.querySelector(`.${NOTICE_SLOT} > .browser-download-notice`) as HTMLElement | null;
  await done(entry({ id: 'f', name: 'f.zip', state: 'interrupted' }));
  assert.equal(container.querySelector('.browser-download-notice b')!.textContent, 'Download failed');
  assert.equal(peek()!.getAttribute('data-state'), 'interrupted');
  await done(entry({ id: 'g', name: 'g.csv', exists: false }));
  assert.equal(container.querySelector('.browser-download-notice-name')!.textContent, 'g.csv', 'the newer one');
  await click(byText('View downloads'));
  assert.equal(peek(), null);
  assert.equal(button()!.getAttribute('aria-expanded'), 'true', 'the panel opened');
  // while the panel is open nothing peeks
  await done(entry());
  assert.equal(peek(), null);
  await click(button()!);
  // behind another tab, an agent's, or another pane's page: no peek
  await rerender({ front: false });
  await done(entry());
  await rerender({ front: true });
  await done(entry({ agent: true }));
  await done(entry({ pageId: 99 }));
  await done(entry({ state: 'cancelled' }));
  assert.equal(peek(), null);
  // a popup of this tab is this pane's page too
  await rerender({ pages: () => [10, 42] });
  await done(entry({ pageId: 42 }));
  assert.ok(peek());
});

test('a pane without a notice slot shows none (the button and the panel still work)', async () => {
  await render({ downloads: [entry()], unseen: [] }, {}, false);
  await done(entry());
  assert.equal(container.querySelector('.browser-download-notice'), null);
  assert.ok(button());
});

test('an Artifact pane tells of its download in its own slot, as the browser pane does (#2595)', async () => {
  await render({ downloads: [entry()], unseen: [] }, {}, true, 'artifact-pane');
  await done(entry());
  assert.equal(
    container.querySelector(`.${NOTICE_SLOT} > .browser-download-notice`)?.getAttribute('aria-label'),
    'Download complete: report.csv',
  );
  assert.ok(button());
});

afterEach(() => mock.timers.reset());
