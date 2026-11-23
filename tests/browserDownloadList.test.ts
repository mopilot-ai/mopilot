// The browser pane's Downloads list in main (electron/capabilities/browser/downloadList.cjs) and how every panel session's
// download reaches it (electron/app/browserDownloads.cjs): the user's and an agent's, a save sheet answered or cancelled,
// overlapping downloads, a cancel racing completion, progress pushed at most every PROGRESS_MS, actions by id only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DownloadList, MAX, PROGRESS_MS } = require('../electron/capabilities/browser/downloadList.cjs');
const { browserDownloads } = require('../electron/app/browserDownloads.cjs');

/** A fake Electron DownloadItem. */
class Item extends EventEmitter {
  savePath = '';
  received = 0;
  total = 0;
  paused = false;
  resumable = false;
  cancelled = 0;
  resumed = 0;
  dialog: any = null;
  filename: string;
  url: string;
  constructor(filename = 'report.csv', url = 'https://site.test/report.csv') {
    super();
    this.filename = filename;
    this.url = url;
  }
  getFilename = () => this.filename;
  getURL = () => this.url;
  getSavePath = () => this.savePath;
  setSavePath = (p: string) => void (this.savePath = p);
  setSaveDialogOptions = (o: any) => void (this.dialog = o);
  getReceivedBytes = () => this.received;
  getTotalBytes = () => this.total;
  isPaused = () => this.paused;
  canResume = () => this.resumable;
  cancel = () => void this.cancelled++;
  resume = () => void this.resumed++;
}

function setup(o: { exists?: (p: string) => boolean; opened?: string } = {}) {
  const sent: [string, any][] = [];
  const shell = { opened: [] as string[], shown: [] as string[], fail: '' };
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let ids = 0;
  let clock = 1000;
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++ids;
      pending.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    setImmediate: (fn: () => void) => pending.push({ fn, ms: 0, id: ++ids }),
  };
  const files = new Set<string>();
  const list = new DownloadList({
    broadcast: (channel: string, payload: any) => sent.push([channel, payload]),
    shell: {
      openPath: async (p: string) => (shell.opened.push(p), shell.fail),
      showItemInFolder: (p: string) => void shell.shown.push(p),
    },
    folder: () => o.opened ?? '/Users/me/Downloads',
    now: () => clock,
    exists: o.exists ?? ((p: string) => files.has(p)),
    timers,
  });
  /** Runs what is due: the deferred pushes, then (all: true) the progress timer too. */
  const run = (all = false) => {
    const due = pending.filter((p) => all || p.ms === 0);
    for (const p of due) pending.splice(pending.indexOf(p), 1);
    for (const p of due) p.fn();
  };
  const pushes = () => sent.filter(([c]) => c === 'browser:downloadsChanged').map(([, v]) => v);
  return {
    list,
    sent,
    shell,
    files,
    pending,
    run,
    pushes,
    tick: (ms: number) => (clock += ms),
  };
}

test('a download is listed from Starting to Downloaded; its end pushes the list and a done event; the file is checked', () => {
  const h = setup();
  const item = new Item();
  item.savePath = '/Users/me/Downloads/report.csv';
  const id = h.list.track(item, { pageId: 12 });
  assert.equal(typeof id, 'string');
  h.run();
  const first = h.pushes()[0].downloads[0];
  assert.deepEqual(
    { ...first, id: undefined },
    {
      id: undefined,
      name: 'report.csv',
      path: '/Users/me/Downloads/report.csv',
      url: 'https://site.test/report.csv',
      state: 'progressing',
      received: 0,
      total: 0,
      startedAt: 1000,
      endedAt: null,
      agent: false,
      pageId: 12,
      exists: null,
      stopping: false,
      canResume: false,
    },
  );
  // progress waits for the timer: many updates are one push
  item.total = 100;
  item.received = 40;
  item.emit('updated', {}, 'progressing');
  item.received = 60;
  item.emit('updated', {}, 'progressing');
  h.run();
  assert.equal(h.pushes().length, 1, 'no push before PROGRESS_MS');
  assert.equal(h.pending[0].ms, PROGRESS_MS);
  h.run(true);
  assert.equal(h.pushes().length, 2);
  assert.equal(h.pushes()[1].downloads[0].received, 60);
  // done: at once, with whether the file is there, and unseen
  h.files.add('/Users/me/Downloads/report.csv');
  item.received = 100;
  h.tick(500);
  item.emit('done', {}, 'completed');
  const done = h.sent.find(([c]) => c === 'browser:downloadDone')![1];
  assert.equal(done.state, 'completed');
  assert.equal(done.exists, true);
  assert.equal(done.endedAt, 1500);
  assert.equal(done.received, 100);
  h.run();
  assert.deepEqual(h.pushes().at(-1).unseen, [id]);
  // a late update or a second end changes nothing
  const before = h.sent.length;
  item.emit('updated', {}, 'progressing');
  item.emit('done', {}, 'cancelled');
  h.run(true);
  assert.equal(h.sent.length, before);
  assert.equal(h.list.view().downloads[0].state, 'completed');
});

test('a start, a pause or an end goes at once and cancels a waiting progress push', () => {
  const h = setup();
  const item = new Item();
  h.list.track(item);
  h.run();
  item.received = 5;
  item.emit('updated', {}, 'progressing');
  assert.equal(h.pending.length, 1);
  // paused by the site's server dropping: a break it can come back from
  item.resumable = true;
  item.emit('updated', {}, 'interrupted');
  assert.equal(h.pending.length, 1, 'the timer went; a push is due at once');
  assert.equal(h.pending[0].ms, 0);
  h.run();
  assert.equal(h.pushes().at(-1).downloads[0].state, 'paused');
  assert.equal(h.pushes().at(-1).downloads[0].canResume, true);
  // the user's pause (Electron's isPaused) is a pause too; then it goes on
  item.emit('updated', {}, 'progressing');
  item.paused = true;
  item.emit('updated', {}, 'progressing');
  h.run();
  assert.equal(h.pushes().at(-1).downloads[0].state, 'paused');
  item.paused = false;
  item.emit('updated', {}, 'progressing');
  h.run();
  assert.equal(h.pushes().at(-1).downloads[0].state, 'progressing');
  // two pushes asked for in one turn are one
  h.list.changed(true);
  h.list.changed(true);
  assert.equal(h.pending.length, 1);
  h.run();
  // a progress push asked for while one is due at once waits for it
  h.list.changed(true);
  h.list.changed(false);
  assert.equal(h.pending.length, 1);
  h.run();
  // the timer, then flush directly: the timer is cleared
  h.list.changed(false);
  h.list.flush();
  assert.equal(h.pending.length, 0);
});

test('a break it cannot come back from is the end: Download failed, unseen, and the item let go', () => {
  const h = setup();
  const item = new Item('big.zip');
  const id = h.list.track(item, { pageId: 3 });
  item.emit('updated', {}, 'interrupted');
  const done = h.sent.find(([c]) => c === 'browser:downloadDone')![1];
  assert.equal(done.state, 'interrupted');
  assert.equal(done.exists, null);
  assert.equal(done.name, 'big.zip', 'no save path yet: the name it would have had');
  assert.deepEqual(h.list.view().unseen, [id]);
  item.emit('done', {}, 'interrupted');
  assert.equal(h.sent.filter(([c]) => c === 'browser:downloadDone').length, 1);
});

test('the save sheet: the name comes when the user answers it; Cancel there leaves a Stopped entry, not unseen', () => {
  const h = setup();
  const item = new Item('', 'https://site.test/x');
  h.list.track(item);
  assert.equal(h.list.view().downloads[0].name, 'download', 'nothing named yet');
  const answered = new Item('report.csv');
  h.list.track(answered);
  assert.equal(h.list.view().downloads[0].name, 'report.csv');
  answered.savePath = '/Users/me/Desktop/q3.csv';
  answered.emit('updated', {}, 'progressing');
  assert.equal(h.list.view().downloads[0].name, 'q3.csv');
  assert.equal(h.list.view().downloads[0].path, '/Users/me/Desktop/q3.csv');
  item.emit('done', {}, 'cancelled');
  const stopped = h.list.view().downloads[1];
  assert.equal(stopped.state, 'cancelled');
  assert.deepEqual(h.list.view().unseen, []);
});

test('overlapping downloads stay separate and newest first; values that are not numbers read as 0', () => {
  const h = setup();
  const a = new Item('a.pdf');
  const b = new Item('b.pdf');
  (a as any).getReceivedBytes = () => Number.NaN;
  (b as any).getTotalBytes = () => -5;
  const idA = h.list.track(a, { pageId: 1.5 });
  const idB = h.list.track(b, { pageId: 2, agent: true });
  const [first, second] = h.list.view().downloads;
  assert.deepEqual([first.id, second.id], [idB, idA]);
  assert.equal(second.pageId, null, 'not a page id');
  assert.equal(first.agent, true);
  assert.equal(second.received, 0);
  assert.equal(first.total, 0);
  b.emit('done', {}, 'completed');
  a.emit('done', {}, 'cancelled');
  assert.deepEqual(
    h.list.view().downloads.map((d: any) => d.state),
    ['completed', 'cancelled'],
  );
  // a minimal item (no optional methods) still lists
  const bare: any = Object.assign(new EventEmitter(), {});
  h.list.track(bare);
  assert.deepEqual(
    [h.list.view().downloads[0].name, h.list.view().downloads[0].url, h.list.view().downloads[0].canResume],
    ['download', '', false],
  );
  bare.emit('updated', {}, 'progressing');
  assert.equal(h.list.view().downloads[0].state, 'progressing');
  bare.emit('updated', {}, 'interrupted');
  assert.equal(h.list.view().downloads[0].state, 'interrupted');
});

test(`the list keeps ${MAX}: the oldest finished ones drop off, one still downloading never does`, () => {
  const h = setup();
  const live = new Item('live.bin');
  h.list.track(live);
  const ended: Item[] = [];
  for (let i = 0; i < MAX; i++) {
    const it = new Item(`f${i}`);
    h.list.track(it);
    it.emit('done', {}, 'interrupted');
    ended.push(it);
  }
  const view = h.list.view();
  assert.equal(view.downloads.length, MAX);
  assert.equal(view.downloads.at(-1).name, 'live.bin', 'kept though it is the oldest');
  assert.equal(view.downloads.at(-2).name, 'f1', 'the oldest finished one went');
  assert.equal(view.unseen.length, MAX - 1, 'its unseen mark went with it');
  // all of them under way: nothing can drop off
  const busy = setup();
  for (let i = 0; i < MAX + 2; i++) busy.list.track(new Item(`b${i}`));
  assert.equal(busy.list.view().downloads.length, MAX + 2);
});

test('cancel: asks the item and waits for its end; one that completed first stays Downloaded; never twice', async () => {
  const h = setup();
  const item = new Item();
  const id = h.list.track(item);
  assert.deepEqual(await h.list.act(id, 'cancel'), { ok: true });
  assert.equal(item.cancelled, 1);
  assert.equal(h.list.view().downloads[0].stopping, true);
  assert.equal(h.list.view().downloads[0].state, 'progressing');
  assert.deepEqual(await h.list.act(id, 'cancel'), { ok: false, reason: 'not-active' }, 'already stopping');
  assert.equal(item.cancelled, 1);
  // the race: Chromium finished the file before the cancel reached it
  item.savePath = '/d/report.csv';
  h.files.add('/d/report.csv');
  item.emit('done', {}, 'completed');
  const d = h.list.view().downloads[0];
  assert.deepEqual([d.state, d.stopping, d.exists], ['completed', false, true]);
  assert.deepEqual(await h.list.act(id, 'cancel'), { ok: false, reason: 'not-active' });
  // the usual order: cancelled
  const other = new Item('b.csv');
  const otherId = h.list.track(other);
  await h.list.act(otherId, 'cancel');
  other.emit('done', {}, 'cancelled');
  assert.equal(h.list.view().downloads[0].state, 'cancelled');
});

test('resume: only a paused download that can come back', async () => {
  const h = setup();
  const item = new Item();
  const id = h.list.track(item);
  assert.deepEqual(await h.list.act(id, 'resume'), { ok: false, reason: 'not-resumable' }, 'not paused');
  item.resumable = true;
  item.emit('updated', {}, 'interrupted');
  item.resumable = false;
  assert.deepEqual(await h.list.act(id, 'resume'), { ok: false, reason: 'not-resumable' }, 'can no longer resume');
  item.resumable = true;
  assert.deepEqual(await h.list.act(id, 'resume'), { ok: true });
  assert.equal(item.resumed, 1);
  assert.equal(h.list.view().downloads[0].state, 'progressing');
  item.emit('done', {}, 'completed');
  assert.deepEqual(await h.list.act(id, 'resume'), { ok: false, reason: 'not-resumable' }, 'ended');
});

test('open and show: only a Downloaded file still there, found by id; a gone file is marked; open failures say why', async () => {
  const h = setup();
  const item = new Item();
  item.savePath = '/d/report.csv';
  const id = h.list.track(item);
  assert.deepEqual(await h.list.act(id, 'open'), { ok: false, reason: 'missing' }, 'still downloading');
  h.files.add('/d/report.csv');
  item.emit('done', {}, 'completed');
  assert.deepEqual(await h.list.act(id, 'show'), { ok: true });
  assert.deepEqual(h.shell.shown, ['/d/report.csv']);
  assert.deepEqual(h.list.view().unseen, [], 'looked at');
  assert.deepEqual(await h.list.act(id, 'open'), { ok: true });
  assert.deepEqual(h.shell.opened, ['/d/report.csv']);
  h.shell.fail = 'No application knows how to open it';
  assert.deepEqual(await h.list.act(id, 'open'), { ok: false, reason: 'open-failed', message: 'No application knows how to open it' });
  // the user deleted it
  h.files.delete('/d/report.csv');
  assert.deepEqual(await h.list.act(id, 'show'), { ok: false, reason: 'missing' });
  assert.equal(h.list.view().downloads[0].exists, false);
  assert.deepEqual(await h.list.act(id, 'open'), { ok: false, reason: 'missing' });
  // back again: the panel's read sees it
  h.files.add('/d/report.csv');
  assert.equal(h.list.snapshot().downloads[0].exists, true);
  // a stopped one has no file
  const stopped = new Item('s.csv');
  const sid = h.list.track(stopped);
  stopped.emit('done', {}, 'cancelled');
  assert.deepEqual(await h.list.act(sid, 'show'), { ok: false, reason: 'missing' });
  assert.equal(h.list.snapshot().downloads[0].exists, null);
});

test('remove: a finished one leaves the list and its dot; one under way stays; unknown ids and actions do nothing', async () => {
  const h = setup();
  const item = new Item();
  const id = h.list.track(item);
  assert.deepEqual(await h.list.act(id, 'remove'), { ok: false, reason: 'active' });
  item.emit('done', {}, 'interrupted');
  assert.deepEqual(h.list.view().unseen, [id]);
  assert.deepEqual(await h.list.act(id, 'remove'), { ok: true });
  assert.deepEqual(h.list.view(), { downloads: [], unseen: [] });
  for (const [i, a] of [
    ['nope', 'open'],
    [42, 'open'],
    [id, 'delete'],
    [id, 7],
  ])
    assert.deepEqual(await h.list.act(i, a), { ok: false, reason: 'missing' });
});

test('seen: the panel opening marks every finished one; named ids only those; nothing changed, no push', () => {
  const h = setup();
  const a = new Item('a');
  const b = new Item('b');
  const idA = h.list.track(a);
  const idB = h.list.track(b);
  a.emit('done', {}, 'completed');
  b.emit('done', {}, 'interrupted');
  h.run();
  const before = h.pushes().length;
  assert.equal(h.list.seen(['other']), true);
  h.run();
  assert.equal(h.pushes().length, before, 'nothing changed');
  h.list.seen([idA]);
  assert.deepEqual(h.list.view().unseen, [idB]);
  h.list.seen(undefined);
  h.run();
  assert.deepEqual(h.pushes().at(-1).unseen, []);
});

test("Open folder opens the user's downloads folder and says when it couldn't; the IPC handlers reach the list", async () => {
  const h = setup({ opened: '/Users/me/Exports' });
  assert.deepEqual(await h.list.openFolder(), { ok: true });
  assert.deepEqual(h.shell.opened, ['/Users/me/Exports']);
  h.shell.fail = 'gone';
  assert.deepEqual(await h.list.openFolder(), { ok: false, reason: 'open-failed', message: 'gone' });
  const handlers = new Map<string, Function>();
  h.list.register({ handle: (channel: string, fn: Function) => handlers.set(channel, fn) });
  assert.deepEqual(
    [...handlers.keys()],
    ['browser:downloads', 'browser:downloadAct', 'browser:downloadsSeen', 'browser:openDownloadsFolder'],
  );
  const item = new Item();
  const id = h.list.track(item);
  assert.equal(handlers.get('browser:downloads')!().downloads[0].id, id);
  assert.deepEqual(await handlers.get('browser:downloadAct')!({}, id, 'cancel'), { ok: true });
  assert.equal(handlers.get('browser:downloadsSeen')!({}, [id]), true);
  assert.deepEqual(await handlers.get('browser:openDownloadsFolder')!(), { ok: false, reason: 'open-failed', message: 'gone' });
});

test('the real defaults: a list with no clock, timers or file check of its own still works', async () => {
  const sent: any[] = [];
  const list = new DownloadList({ broadcast: (...a: any[]) => sent.push(a), shell: {}, folder: () => '' });
  const item = new Item();
  item.savePath = '/no/such/file.csv';
  list.track(item);
  item.emit('done', {}, 'completed');
  assert.equal(list.view().downloads[0].exists, false);
  assert.equal(list.exists(''), false);
  await new Promise((r) => setImmediate(r));
  const pushed = sent.filter(([c]) => c === 'browser:downloadsChanged').length;
  assert.ok(pushed > 0);
  list.changed(false);
  await new Promise((r) => setTimeout(r, PROGRESS_MS + 20));
  assert.equal(sent.filter(([c]) => c === 'browser:downloadsChanged').length, pushed + 1);
});

test('browserDownloads: every panel download is listed (the user’s, an agent’s, one behind the save sheet); one that could not be placed is not', () => {
  const sent: [string, any][] = [];
  const handled: string[] = [];
  let agentFile: string | null = null;
  let throwOnTabs = false;
  const d = browserDownloads({
    app: { getPath: () => '/Users/me/Downloads' },
    session: { fromPartition: () => ({ on: () => undefined }) },
    partition: 'persist:browser',
    tabs: () => ({
      download: () => {
        if (throwOnTabs) throw new Error('host gone');
        return agentFile;
      },
    }),
    ipcMain: { handle: (channel: string) => handled.push(channel) },
    shell: { openPath: async () => '', showItemInFolder: () => undefined },
    broadcast: (channel: string, payload: any) => sent.push([channel, payload]),
  });
  assert.ok(d.list);
  assert.equal(handled.length, 4);
  const wc = { id: 21 };
  // the user's: into the chosen folder
  const user = new Item('a.csv');
  d.onBrowserDownload({}, user, wc);
  assert.match(user.savePath, /^\/Users\/me\/Downloads\/a( \(\d+\))?\.csv$/);
  // an agent's: into its chat's folder, marked
  agentFile = '/chats/c/b.csv';
  const agent = new Item('b.csv');
  d.onBrowserDownload({}, agent, wc);
  agentFile = null;
  // the save sheet: in the chosen folder
  d.setupDownloads('/Users/me/Exports', true);
  const asked = new Item('c.csv');
  d.onBrowserDownload({}, asked, null);
  assert.match(asked.dialog.defaultPath, /^\/Users\/me\/Exports\/c/);
  // where it would go couldn't be decided: cancelled at once, never redirected, not listed
  throwOnTabs = true;
  const broken = new Item('d.csv');
  d.onBrowserDownload({}, broken, wc);
  assert.equal(broken.cancelled, 1);
  assert.equal(broken.listenerCount('done'), 0);
  const rows = d.list.view().downloads;
  assert.deepEqual(
    rows.map((r: any) => [r.name, r.agent, r.pageId, r.state]),
    [
      ['c.csv', false, null, 'progressing'],
      ['b.csv', true, 21, 'progressing'],
      [rows[2].name, false, 21, 'progressing'],
    ],
  );
  // without the list's dependencies (tests that look only at where a file goes) nothing is listed
  const bare = browserDownloads({
    app: { getPath: () => '/tmp' },
    session: { fromPartition: () => ({ on: () => undefined }) },
    partition: 'p',
    tabs: () => null,
  });
  assert.equal(bare.list, null);
  const noIpc = browserDownloads({
    app: { getPath: () => '/tmp' },
    session: { fromPartition: () => ({ on: () => undefined }) },
    partition: 'p',
    tabs: () => null,
    broadcast: () => undefined,
  });
  assert.ok(noIpc.list, 'a list with no IPC to register');
});
