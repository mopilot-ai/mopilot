// The browser host's turns (electron/capabilities/browser/host.cjs): when a tab is ready for an action, actions
// running one at a time and settling, the turn end, forgetting a chat, downloads and the sign-in hand-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FRAME_SCRIPT, raw, image, flush, drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);

test('ready fails closed: another chat, a closed tab, a bad target or an open dialog', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await assert.rejects(h.tabs.ready(tab, 'other'), { code: 'bad_target', message: "Tab tab_aaaaaa is not this chat's." });
  tab.dialog = { type: 'confirm', message: 'Sure?\nReally' };
  await assert.rejects(drive(t, h.tabs.ready(tab, 'c')), {
    code: 'dialog_open',
    message: 'A confirm dialog is open in tab_aaaaaa: "Sure? Really". Answer it with browser_handle_dialog first.',
  });
  assert.equal(await drive(t, h.tabs.ready(tab, 'c', { allowDialog: true })), null);
  tab.dialog = null;
  tab.wc.session = {};
  await assert.rejects(h.tabs.ready(tab, 'c'), { code: 'bad_target' });
  tab.wc.destroy();
  await assert.rejects(h.tabs.ready(tab, 'c'), { code: 'tab_closed' });
});

test('ready for input: a hidden tab is brought forward and polled; still hidden fails; popups are not reselected', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  let hiddenFor = 3;
  tab.wc.ops.state = () => ({ w: 800, h: 600, visibility: hiddenFor-- > 0 ? 'hidden' : 'visible', quietMs: 1000 });
  const st = await drive(t, h.tabs.ready(tab, 'c', { input: true }));
  assert.equal(st.visibility, 'visible');
  assert.equal(h.log.select.filter((x: string) => x === 'tab_aaaaaa').length, 2, 'revealed, then selected for input');

  tab.wc.ops.state = () => ({ w: 800, h: 600, visibility: 'hidden', quietMs: 1000 });
  await assert.rejects(drive(t, h.tabs.ready(tab, 'c', { input: true })), { code: 'hidden' });
  const throwing = setup(t, {
    select: () => {
      throw new Error('gone');
    },
  });
  const t2 = tabOf(throwing);
  t2.wc.ops.state = tab.wc.ops.state;
  await assert.rejects(drive(t, throwing.tabs.ready(t2, 'c', { input: true })), { code: 'hidden' });

  const popup = h.tabs.adoptPopup(tab.wc, h.popupWC());
  popup.wc.ops.state = () => ({ w: 800, h: 600, visibility: 'hidden', quietMs: 1000 });
  const before = h.log.select.length;
  assert.equal((await drive(t, h.tabs.ready(popup, 'c', { input: true }))).visibility, 'hidden');
  assert.equal(h.log.select.length, before);
});

/* ------------------------------------------------------------------ */
/* turn end, forget, downloads, state, the action queue                */
/* ------------------------------------------------------------------ */

test('turnEnded: closes the unmarked tabs the agent opened, keeps the rest (detached) and releases waits', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  assert.deepEqual(await h.tabs.turnEnded('nobody'), { closed: [], kept: [] });
  const original = tabOf(h, null);
  const older = await drive(t, h.tabs.create('c'));
  const opened = await drive(t, h.tabs.create('c'));
  const marked = await drive(t, h.tabs.create('c'));
  h.tabs.mark('c', marked.id, 'handoff');
  const taken = await drive(t, h.tabs.create('c'));
  h.tabs.takeOver('c', taken.id);
  await drive(t, h.tabs.ready(original, 'c'));
  const dialogAnswers: any[] = [];
  original.dialogWaiters.add((d: any) => dialogAnswers.push(d));
  // a create still waiting for its pane tab, in this chat and another
  h.autoAttach = false;
  const pending = h.tabs.create('c').catch((e: any) => e);
  const elsewhere = h.tabs.create('d').catch((e: any) => e);
  await flush();
  const result = await drive(t, h.tabs.turnEnded('c'));
  // the agent-opened tab it used last stays open as the turn's result
  assert.deepEqual(result, { closed: [older.id], kept: [original.id, opened.id, marked.id, taken.id] });
  assert.equal(opened.result, true);
  assert.equal(older.closed, true);
  assert.equal((await pending).code, 'no_browser', 'the waiting create is released at once');
  assert.deepEqual(dialogAnswers, [null]);
  assert.deepEqual(
    [original.held, original.listening, opened.held, opened.created, marked.created, taken.created, taken.takenOver],
    [false, false, false, false, false, false, false],
  );
  assert.equal(marked.mark, 'handoff', 'the mark stays');
  assert.equal(h.tabs.chats.get('c').changes.length, 0);
  assert.ok(h.tabs.waiting.has(`d ${h.log.open.at(-1)[1].tabKey}`), "another chat's wait is untouched");
  assert.equal((await drive(t, elsewhere)).code, 'no_browser');
  // idempotent; the result is an ordinary tab after the next turn end
  assert.deepEqual(await drive(t, h.tabs.turnEnded('c')), { closed: [], kept: [original.id, opened.id, marked.id, taken.id] });
  assert.equal(opened.result, false);
});

test('turnEnded: bounded by TURN_END_MS when a tab never closes; such a tab is let go', async (t) => {
  const h = setup(t, { attachMs: 1000, close: () => {} });
  const stuck = await drive(t, h.tabs.create('c'));
  await drive(t, h.tabs.ready(stuck, 'c'));
  const last = await drive(t, h.tabs.create('c'));
  stuck.wc.isDestroyed = () => false;
  // close() itself waits CLOSE_MS for the page; make close hang past the turn-end cap
  h.tabs.close = () => new Promise(() => {});
  const result = await drive(t, h.tabs.turnEnded('c'), { step: 1000 });
  assert.deepEqual(result.closed, [stuck.id]);
  assert.equal(stuck.closed, false);
  assert.equal(stuck.held, false, 'detached after the cap');
  // a closed tab left in the map is skipped
  stuck.closed = true;
  assert.deepEqual(await drive(t, h.tabs.turnEnded('c')), { closed: [], kept: [last.id] });
});

test('turnEnded: a tab that fails to close is let go like one that never closes', async (t) => {
  const h = setup(t, { attachMs: 1000, close: () => {} });
  const broken = await drive(t, h.tabs.create('c'));
  await drive(t, h.tabs.ready(broken, 'c'));
  await drive(t, h.tabs.create('c'));
  h.tabs.close = async () => {
    throw new Error('the pane is gone');
  };
  const result = await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(result.closed, [broken.id]);
  assert.equal(broken.closed, false);
  assert.equal(broken.held, false, 'detached');
});

test('turnEnded: the agent-opened tab used last stays as the result, comes forward, and is ordinary from the next action', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const first = await drive(t, h.tabs.create('c'));
  const second = await drive(t, h.tabs.create('c'));
  // acting on the first again makes it the most recent; a popup's actions count for the tab that opened it
  await drive(t, h.tabs.ready(first, 'c'));
  const popup = h.tabs.adoptPopup(first.wc, h.popupWC());
  await drive(t, h.tabs.ready(second, 'c'));
  await drive(t, h.tabs.ready(popup, 'c'));
  h.log.select.length = 0;
  h.log.changes.length = 0;
  const result = await drive(t, h.tabs.turnEnded('c'));
  assert.ok(result.closed.includes(second.id));
  assert.ok(result.kept.includes(first.id));
  assert.equal(first.result, true);
  assert.equal(first.held, false, 'detached like any kept tab');
  assert.deepEqual(h.log.select, [first.id], 'brought to the front of its pane');
  assert.ok(h.log.changes.includes('c'));

  // the next agent action in the chat makes it an ordinary tab (and the pane hears it); a later one changes nothing
  const other = tabOf(h, 'tab_bbbbbb');
  h.log.changes.length = 0;
  await drive(t, h.tabs.ready(other, 'c'));
  assert.equal(first.result, false);
  assert.ok(h.log.changes.includes('c'));
  await drive(t, h.tabs.ready(other, 'c'));
  // it is no longer the agent's: the next turn end keeps it without a result
  assert.deepEqual((await drive(t, h.tabs.turnEnded('c'))).closed, []);
  assert.equal(first.result, false);
});

test('turnEnded: no result tab when the agent opened none, the pane was hidden, or the pane cannot select it', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const original = tabOf(h, null);
  await drive(t, h.tabs.ready(original, 'c'));
  h.log.select.length = 0;
  await drive(t, h.tabs.turnEnded('c'));
  assert.equal(original.result, false);
  assert.deepEqual(h.log.select, []);

  const opened = await drive(t, h.tabs.create('c'));
  h.tabs.paneHidden('c');
  h.log.select.length = 0;
  await drive(t, h.tabs.turnEnded('c'));
  assert.equal(opened.result, true, 'kept open');
  assert.deepEqual(h.log.select, [], 'but not brought forward');

  const throwing = setup(t, {
    attachMs: 1000,
    select: () => {
      throw new Error('window gone');
    },
  });
  const kept = await drive(t, throwing.tabs.create('c'));
  await drive(t, throwing.tabs.turnEnded('c'));
  assert.equal(kept.result, true);
  assert.equal(kept.closed, false);
});

test("forget: a deleted chat's tabs are let go and forgotten", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, h.tabs.ready(tab, 'c'));
  h.tabs.forget('c');
  h.tabs.forget('c');
  assert.equal(tab.held, false);
  assert.equal(h.tabs.chats.has('c'), false);
  assert.deepEqual(h.tabs.list('c'), []);
  // the page closing afterwards reports nothing for the forgotten chat
  tab.wc.destroy();
  assert.equal(h.tabs.chats.has('c'), false);
});

test("download: a tab an agent holds saves into the chat's folder and reports start and end; others are left to the user", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const item = (name: string) => Object.assign(new EventEmitter(), { getFilename: () => name });
  const h = setup(t, { downloadsDir: (chatId: string) => path.join(dir, chatId) });
  const tab = tabOf(h);
  assert.equal(h.tabs.download(item('a.pdf'), tab.wc), null, 'not held by an agent');
  assert.equal(h.tabs.download(item('a.pdf'), null), null);
  assert.equal(h.tabs.download(item('a.pdf'), h.newWC()), null, 'not a tab');
  tab.hold();
  const downloadEvents: any[] = [];
  const stopDownloads = h.tabs.onDownload((event: any) => downloadEvents.push(event));
  const it = item('report.pdf');
  const file = h.tabs.download(it, tab.wc);
  assert.equal(file, path.join(dir, 'c', 'report.pdf'));
  assert.match(h.tabs.state('c'), /downloading in tab_aaaaaa: report.pdf\nchanges: download_started report.pdf in tab_aaaaaa/);
  it.emit('updated');
  it.emit('done', {}, 'completed');
  assert.deepEqual(
    downloadEvents.map((event) => [event.tab, event.filename, event.status]),
    [
      [tab, file, 'started'],
      [tab, file, 'in_progress'],
      [tab, file, 'complete'],
    ],
  );
  stopDownloads();
  assert.equal(tab.downloads[0].state, 'completed');
  assert.match(h.tabs.state('c'), new RegExp(`changes: download_completed report.pdf -> ${file.replace(/[\\.]/g, '\\$&')}`));
  // the same name again while the first is still downloading (no file yet): a new name, not the same file
  const first = item('export.csv');
  const a = h.tabs.download(first, tab.wc);
  assert.equal(h.tabs.download(item('export.csv'), tab.wc), path.join(dir, 'c', 'export (1).csv'));
  assert.equal(a, path.join(dir, 'c', 'export.csv'));
  first.emit('done', {}, 'cancelled');
  assert.equal(h.tabs.download(item('export.csv'), tab.wc), a, 'free again once it ended without a file');
  // separators in the name stay inside the chat's folder
  assert.equal(h.tabs.download(item('../x:y.txt'), tab.wc), path.join(dir, 'c', '.._x_y.txt'));
  for (let i = 0; i < 21; i++) h.tabs.download(item(`f${i}`), tab.wc);
  assert.equal(tab.downloads.length, 20);
  assert.equal(tab.downloads[0].name, 'f1');
  assert.equal(downloadEvents.length, 3, 'unsubscribed listeners receive no subsequent downloads');
  // the user took over (or is signing in): their download is theirs, left to their settings and never reported
  h.tabs.takeOver('c', tab.id, true);
  const before = tab.downloads.length;
  assert.equal(h.tabs.download(item('recovery-codes.txt'), tab.wc), null);
  assert.equal(tab.downloads.length, before);
  assert.doesNotMatch(h.tabs.state('c'), /recovery-codes/);
  h.tabs.takeOver('c', tab.id, false);
  assert.ok(h.tabs.download(item('again.txt'), tab.wc), 'handed back: the agent drives it again');
  // the folder can't be made: left to the user's download settings
  fs.writeFileSync(path.join(dir, 'blocked'), '');
  const b = setup(t, { downloadsDir: () => path.join(dir, 'blocked', 'sub') });
  const bt = tabOf(b);
  bt.hold();
  assert.equal(b.tabs.download(item('x'), bt.wc), null);
  // no downloads folder configured
  const n = setup(t);
  const nt = tabOf(n);
  nt.hold();
  assert.equal(n.tabs.download(item('x'), nt.wc), null);
});

test('run: actions on one tab never interleave, and each is capped at ACTION_MS', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const order: string[] = [];
  let release!: () => void;
  const first = h.tabs.run(tab, async () => {
    order.push('a:start');
    await new Promise<void>((r) => (release = r));
    order.push('a:end');
    return 'a';
  });
  const second = h.tabs.run(tab, () => {
    order.push('b');
    return 'b';
  });
  await flush();
  assert.deepEqual(order, ['a:start']);
  release();
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
  // a failure does not block the queue
  await assert.rejects(
    h.tabs.run(tab, () => {
      throw new Error('x');
    }),
    /x/,
  );
  assert.equal(await h.tabs.run(tab, () => 'next'), 'next');
  const hung = h.tabs.run(tab, () => new Promise(() => {}));
  await assert.rejects(drive(t, hung, { step: 10_000 }), { code: 'timeout', message: 'The browser action took too long.' });
  assert.equal(
    await drive(
      t,
      h.tabs.run(tab, () => 'after'),
    ),
    'after',
  );
});

test('run: an action that timed out is over, so what it still sends never reaches the page beside the next one', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.url = 'https://a.test/';
  let late!: () => void;
  let lateError: any = null;
  const order: string[] = [];
  const slow = h.tabs.run(tab, async () => {
    // an answer that comes after the action's time is up (not through awaitUser)
    await new Promise<void>((r) => (late = r));
    try {
      await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    } catch (e) {
      lateError = e;
    }
    try {
      await h.tabs.history(tab, 'back');
    } catch (e) {
      order.push(`history ${(e as any).code}`);
    }
  });
  const next = h.tabs.run(tab, async () => {
    order.push('next');
    await tab.send('Input.insertText', { text: 'x' });
  });
  await assert.rejects(drive(t, slow, { step: 10_000 }), { code: 'timeout' });
  await drive(t, next);
  late();
  await flush();
  assert.equal(lateError?.code, 'timeout');
  assert.deepEqual(order, ['next', 'history timeout']);
  assert.deepEqual(tab.wc.debugger.sent('Input.dispatchMouseEvent'), []);
  assert.deepEqual(tab.wc.navs, []);
  assert.equal(tab.wc.debugger.sent('Input.insertText').length, 1);
  // outside any action, and in a live one, sending works
  await tab.send('Page.enable');
  assert.equal(
    await drive(
      t,
      h.tabs.run(tab, async () => (await tab.send('Runtime.enable'), 'ok')),
    ),
    'ok',
  );
});

test('awaitUser: a card does not use up the action time, the queue holds meanwhile, and the action then runs on its page', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.url = 'https://a.test/x';
  let answer!: (v: string) => void;
  const card = new Promise<string>((r) => (answer = r));
  const order: string[] = [];
  const first = h.tabs.run(tab, async () => {
    // two waits at once: the clock stays stopped until both are answered
    const [a, b] = await Promise.all([h.tabs.awaitUser(tab, card), h.tabs.awaitUser(tab, Promise.resolve('also'))]);
    order.push(`answered ${a} ${b}`);
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    return 'clicked';
  });
  const second = h.tabs.run(tab, () => order.push('second'));
  for (let i = 0; i < 30; i++) t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(order, [], 'five minutes on the card: no timeout, and the next action waits');
  answer('yes');
  assert.equal(await drive(t, first), 'clicked');
  await drive(t, second);
  assert.deepEqual(order, ['answered yes also', 'second']);
  // after the answer the action has its full time again
  let release!: () => void;
  const after = h.tabs.run(tab, async () => {
    await h.tabs.awaitUser(tab, Promise.resolve(1));
    await new Promise<void>((r) => (release = r));
  });
  await assert.rejects(drive(t, after, { step: 10_000 }), { code: 'timeout' });
  release();
  // outside an action it just waits, and checks the tab all the same
  assert.equal(await h.tabs.awaitUser(tab, Promise.resolve(7)), 7);
  // the call that asked ended meanwhile (a stopped turn, a script out of time): nothing is done
  const ended = new AbortController();
  assert.equal(await h.tabs.awaitUser(tab, Promise.resolve(8), ended.signal), 8);
  ended.abort();
  await assert.rejects(h.tabs.awaitUser(tab, Promise.resolve(9), ended.signal), {
    code: 'aborted',
    message: 'The call ended while the user was being asked, so nothing was done.',
  });
  // the answer and the end of the call in the same moment: nothing is done
  const both = new AbortController();
  const racing = h.tabs.awaitUser(tab, Promise.resolve(10), both.signal);
  queueMicrotask(() => both.abort());
  await assert.rejects(racing, { code: 'aborted' });
  // a refusal on the card still reaches the caller with a signal
  await assert.rejects(h.tabs.awaitUser(tab, Promise.reject(new Error('denied')), new AbortController().signal), /denied/);
  // the call ends while its card is open: the action ends at once and the queue moves on, whatever the answer
  const stop = new AbortController();
  let late!: (v: boolean) => void;
  const held = h.tabs.run(tab, async () => {
    await h.tabs.awaitUser(tab, new Promise<boolean>((r) => (late = r)), stop.signal);
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2 });
  });
  const queued = h.tabs.run(tab, () => 'next');
  await flush();
  stop.abort();
  await assert.rejects(held, { code: 'aborted' });
  assert.equal(await queued, 'next');
  late(true);
  await flush();
  assert.deepEqual(
    tab.wc.debugger.sent('Input.dispatchMouseEvent').filter((c: any) => c.params.x === 2),
    [],
  );
});

test('awaitUser: an action that timed out before its card throws when the answer comes', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  let late!: () => void;
  let error: any = null;
  const slow = h.tabs.run(tab, async () => {
    await new Promise<void>((r) => (late = r));
    try {
      await h.tabs.awaitUser(tab, Promise.resolve('yes'));
    } catch (e) {
      error = e;
    }
  });
  await assert.rejects(drive(t, slow, { step: 10_000 }), { code: 'timeout' });
  late();
  await flush();
  assert.equal(error?.code, 'timeout');
});

test('awaitUser: the tab is checked again after the answer (closed, taken over, signing in, moved to another site)', async (t) => {
  const h = setup(t);
  const asked = async (tab: any, during: () => void) => {
    let answer!: (v: boolean) => void;
    const p = h.tabs.awaitUser(tab, new Promise<boolean>((r) => (answer = r)));
    during();
    answer(true);
    return p;
  };
  const tab = tabOf(h);
  tab.wc.url = 'https://a.test/one';
  // the same site (another page of it) is fine
  assert.equal(await asked(tab, () => (tab.wc.url = 'https://a.test/two#x')), true);
  await assert.rejects(
    asked(tab, () => (tab.wc.url = 'https://b.test/')),
    {
      code: 'tab_changed',
      message:
        'tab_aaaaaa moved to https://b.test/ while the user was being asked about https://a.test. Look at the page again before acting.',
    },
  );
  await assert.rejects(
    asked(tab, () => (tab.wc.url = 'about:blank')),
    { code: 'tab_changed', message: /moved to about:blank/ },
  );
  await assert.rejects(
    asked(tab, () => (tab.wc.url = 'https://c.test/')),
    { code: 'tab_changed', message: /asked about a blank page\./ },
  );
  // a new tab has no url until its page reports one: that is not a move to another site
  tab.wc.url = '';
  assert.equal(await asked(tab, () => (tab.wc.url = 'about:blank')), true);
  tab.wc.url = 'about:blank';
  assert.equal(await asked(tab, () => (tab.wc.url = '')), true);
  tab.wc.url = '';
  await assert.rejects(
    asked(tab, () => (tab.wc.url = 'https://c.test/')),
    { code: 'tab_changed', message: /moved to https:\/\/c\.test\/ while the user was being asked about a blank page\./ },
  );
  // a tab that goes back to having no page is a move too, said as a blank page
  tab.wc.url = 'https://a.test/';
  await assert.rejects(
    asked(tab, () => (tab.wc.url = '')),
    { code: 'tab_changed', message: /moved to a blank page while the user was being asked about https:\/\/a\.test\./ },
  );
  tab.wc.url = 'https://a.test/';
  await assert.rejects(
    asked(tab, () => h.tabs.takeOver('c', tab.id, true)),
    {
      code: 'taken_over',
      message: "The user took over tab_aaaaaa while being asked. Don't act on it again this turn.",
    },
  );
  h.tabs.takeOver('c', tab.id, false);
  const popup = h.tabs.adoptPopup(tab.wc, h.popupWC());
  popup.wc.url = 'https://a.test/pop';
  await assert.rejects(
    asked(popup, () => h.tabs.takeOver('c', tab.id, true)),
    { code: 'taken_over', message: /took over tab_aaaaaa/ },
  );
  h.tabs.takeOver('c', tab.id, false);
  await assert.rejects(
    asked(popup, () => (popup.takenOver = true)),
    { code: 'taken_over', message: `The user took over ${popup.id} while being asked. Don't act on it again this turn.` },
  );
  popup.takenOver = false;
  await assert.rejects(
    asked(tab, () => {
      h.tabs.requestSignin(tab);
    }),
    {
      code: 'signin_pending',
      message: "It is the user's turn on tab_aaaaaa, so agent input to it is paused. Use another tab, or end your turn.",
    },
  );
  await assert.rejects(
    asked(popup, () => {}),
    { code: 'signin_pending', message: /user's turn on tab_aaaaaa/ },
  );
  await h.tabs.signinDone('c', tab.id);
  h.tabs.requestSignin(popup);
  await assert.rejects(
    asked(popup, () => {}),
    { code: 'signin_pending', message: /user's turn on tab_/ },
  );
  await h.tabs.signinDone('c', popup.id, false);
  await assert.rejects(
    asked(tab, () => tab.wc.destroy()),
    { code: 'tab_closed' },
  );
});

/* ------------------------------------------------------------------ */
/* settling, navigation and history                                    */
/* ------------------------------------------------------------------ */

test('settle: waits for the load and network quiet, then a stable DOM, all capped; a gone tab or dialog ends it', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  // loading for a while, with a request in flight
  tab.wc.loading = true;
  tab.inflight.add('x');
  tab.lastNet = 0;
  setTimeout(() => {
    tab.wc.loading = false;
  }, 700);
  let quiet = [0, 100];
  tab.wc.ops.state = () => ({ quietMs: quiet.length ? quiet.shift() : 400 });
  const start = Date.now();
  await drive(t, h.tabs.settle(tab), { step: 10 });
  assert.ok(Date.now() - start >= 700, 'waited for the load to stop');
  assert.equal(quiet.length, 0, 'polled the DOM until it was quiet');
  // the cap: a page that never stops loading
  tab.wc.loading = true;
  const s2 = Date.now();
  await drive(t, h.tabs.settle(tab, { grace: 0 }), { step: 100 });
  assert.ok(Date.now() - s2 >= 5000 && Date.now() - s2 < 5300);
  tab.wc.loading = false;
  // a DOM that never settles is capped too
  tab.wc.ops.state = () => ({ quietMs: 0 });
  const s3 = Date.now();
  await drive(t, h.tabs.settle(tab, { grace: 0 }), { step: 100 });
  assert.ok(Date.now() - s3 >= 5000);
  // reading the page fails: done
  tab.wc.ops.state = () => raw({ exceptionDetails: { text: 'x' } });
  await drive(t, h.tabs.settle(tab, { grace: 0 }));
  // a page that can't be watched for changes has no quiet DOM to wait for: recorded, and done at once
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  tab.wc.ops.state = () => ({ quietMs: 0, observeError: 'MutationObserver is not defined' });
  const s4 = Date.now();
  await drive(t, h.tabs.settle(tab, { grace: 0 }), { step: 100 });
  assert.ok(Date.now() - s4 < 1000);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['watch the page for DOM changes after an action', 'MutationObserver is not defined']],
  );
  // a dialog or a closed page ends either wait
  tab.dialog = { type: 'confirm', message: '' };
  await drive(t, h.tabs.settle(tab, { grace: 0 }));
  tab.wc.loading = true;
  await drive(t, h.tabs.settle(tab, { grace: 0 }));
  tab.dialog = null;
  tab.wc.loading = false;
  let checks = 0;
  tab.wc.isLoading = () => {
    checks++;
    return false;
  };
  tab.wc.ops.state = () => {
    tab.wc.destroyed = true;
    return { quietMs: 0 };
  };
  await drive(t, h.tabs.settle(tab, { grace: 0 }));
  assert.ok(checks >= 1);
  tab.wc.destroyed = true;
  await drive(t, h.tabs.settle(tab, { grace: 0 }));
});

test('ready for input: a page the pane does not lay out is shown (or painted behind) first, then gets a frame', async (t) => {
  const h = setup(t);
  const frames = (tab: any) => tab.wc.debugger.sent('Runtime.evaluate').filter((c: any) => c.params.expression === FRAME_SCRIPT);
  const front = tabOf(h);
  await drive(t, h.tabs.ready(front, 'c', { input: true }));
  assert.equal(frames(front).length, 0, 'already in front: no wait');
  const back = tabOf(h, 'tab_bbbbbb', 'c', h.newWC(), 'back');
  await drive(t, h.tabs.ready(back, 'c', { input: true }));
  assert.equal(frames(back).length, 0, 'painted behind the pane: no wait');

  // display: none (another tab in front): the window is asked to show it, and the action waits for that
  const hidden = tabOf(h, 'tab_cccccc', 'c', h.newWC(), 'none');
  h.log.select.length = 0;
  const p = h.tabs.ready(hidden, 'c', { input: true });
  setTimeout(() => h.tabs.layer(hidden.wc, 'back', h.owner), 120);
  const st = await drive(t, p);
  assert.equal(st.visibility, 'visible');
  assert.deepEqual(h.log.select, ['tab_cccccc', 'tab_cccccc'], 'revealed (first action), then asked to show it for input');
  assert.deepEqual(
    frames(hidden).map((c: any) => c.params),
    [{ expression: FRAME_SCRIPT, awaitPromise: true, returnByValue: true }],
  );

  // a frame that never comes is not waited for past FRAME_MS, and a failing one is ignored
  for (const [key, frame] of [
    ['tab_dddddd', () => new Promise(() => {})],
    [
      'tab_eeeeee',
      () => {
        throw new Error('gone');
      },
    ],
  ] as const) {
    const tab = tabOf(h, key, 'c', h.newWC(), null);
    const cdp = tab.wc.cdp.bind(tab.wc);
    tab.wc.cdp = (method: string, params: any, sessionId?: string) =>
      method === 'Runtime.evaluate' && params.expression === FRAME_SCRIPT ? frame() : cdp(method, params, sessionId);
    setTimeout(() => h.tabs.layer(tab.wc, 'front', h.owner), 10);
    assert.equal((await drive(t, h.tabs.ready(tab, 'c', { input: true }), { step: 100 })).visibility, 'visible');
  }
});

test('ready for input: the layer is only a hint: with none reported (or still not painted) the action is tried after a short wait; a closed tab fails', async (t) => {
  const h = setup(t, {
    select: () => {
      throw new Error('window gone');
    },
    showMs: 500,
  });
  // never reported (a window that doesn't report, or a report that hasn't arrived): tried anyway
  const unknown = tabOf(h, 'tab_aaaaaa', 'c', h.newWC(), null);
  const start = Date.now();
  assert.equal((await drive(t, h.tabs.ready(unknown, 'c', { input: true }))).visibility, 'visible');
  assert.ok(Date.now() - start >= 500, 'waited for the report first');
  // reported not laid out and still not shown: tried too (a blank capture is what fails, with its own error)
  const none = tabOf(h, 'tab_dddddd', 'c', h.newWC(), 'none');
  assert.equal((await drive(t, h.tabs.ready(none, 'c', { input: true }))).visibility, 'visible');
  none.wc.handlers['Page.captureScreenshot'] = () => ({ data: '' });
  h.tabs.o.images.fromBuffer = () => image({}, true);
  none.wc.captureImpl = () => image({}, true);
  await assert.rejects(drive(t, h.tabs.capture(none, { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 })), {
    code: 'capture_failed',
    message: /came back blank/,
  });
  const closing = tabOf(h, 'tab_bbbbbb', 'c', h.newWC(), null);
  const p = h.tabs.ready(closing, 'c', { input: true });
  setTimeout(() => closing.wc.destroy(), 100);
  await assert.rejects(drive(t, p), { code: 'tab_closed', message: 'Tab tab_bbbbbb was closed.' });
  // popups are windows of their own: no layer to wait for
  const owner = tabOf(h, 'tab_cccccc');
  const popup = h.tabs.adoptPopup(owner.wc, h.popupWC());
  assert.equal(popup.layer, null);
  assert.equal((await drive(t, h.tabs.ready(popup, 'c', { input: true }))).visibility, 'visible');
});

/* ------------------------------------------------------------------ */
/* locators (browser_script)                                           */
/* ------------------------------------------------------------------ */

test('onTurnEnd: listeners hear each turn end and a forgotten chat; a failing one does not stop the rest; unsubscribe works', async (t) => {
  const h = setup(t);
  const heard: string[] = [];
  const off = h.tabs.onTurnEnd((chatId: string) => heard.push(`a:${chatId}`));
  h.tabs.onTurnEnd(() => {
    throw new Error('listener failed');
  });
  h.tabs.onTurnEnd((chatId: string) => heard.push(`b:${chatId}`));
  await h.tabs.turnEnded('c');
  h.tabs.forget('d');
  off();
  await h.tabs.turnEnded('e');
  assert.deepEqual(heard, ['a:c', 'b:c', 'a:d', 'b:d', 'b:e']);
});
