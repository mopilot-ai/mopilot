// Side-panel onboarding, pin tip, minimal greeting, sidebar task discovery and retry for history that will not load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelWelcome, SEEN, RISKS, SLIDES } = await import('../electron/chrome-extension/src/panelWelcome.mjs');
const { PanelThread, LOAD_MS } = await import('../electron/chrome-extension/src/panelThread.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

/** The first run on a fake document and Chrome. */
function welcome(o: { seen?: Record<string, boolean>; getFails?: boolean; setFails?: boolean; toolbar?: any; tasks?: any } = {}) {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) };
  const store: Record<string, any> = { ...o.seen };
  const opened: string[] = [];
  let changes = 0;
  const chrome: any = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          if (o.getFails) throw new Error('storage gone');
          return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        set: async (v: any) => {
          if (o.setFails) throw new Error('quota');
          Object.assign(store, v);
        },
      },
    },
    action: 'toolbar' in o ? o.toolbar : { getUserSettings: async () => ({ isOnToolbar: false }) },
  };
  const w = new PanelWelcome({
    document,
    chrome,
    request: async () => {
      if (o.tasks instanceof Error) throw o.tasks;
      return o.tasks ?? { tasks: [] };
    },
    onOpen: (page: string) => opened.push(page),
    onChange: () => changes++,
    now: () => new Date(2026, 9, 22, 9, 0),
  });
  return { w, els, store, opened, changes: () => changes };
}

test('the first run: the consent names the risks, then the intro’s two slides, each kept once done', async () => {
  const t = welcome();
  // before what was seen is read, the chat waits too
  assert.equal(t.w.blocking, true);
  await t.w.start();
  assert.equal(t.w.blocking, true);
  assert.equal(t.els.consent.hidden, false);
  assert.deepEqual(
    t.els.risks.children.map((li: any) => li.children[0].textContent),
    RISKS.map((r: any) => r.title),
  );
  t.els['consent-ok'].listeners.click();
  await tick();
  assert.equal(t.store[SEEN.consent], true);
  assert.equal(t.els.intro.hidden, false);
  assert.equal(t.els['intro-title'].textContent, SLIDES[0].title);
  assert.equal(t.els['intro-dots'].textContent, '● ○');
  assert.equal(t.els['intro-next'].textContent, 'Next');
  t.els['intro-next'].listeners.click();
  assert.equal(t.els['intro-title'].textContent, SLIDES[1].title);
  assert.equal(t.els['intro-next'].textContent, 'Let’s go');
  t.els['intro-next'].listeners.click();
  await tick();
  assert.equal(t.store[SEEN.intro], true);
  assert.equal(t.w.blocking, false);
  assert.equal(t.els.welcome.hidden, true);
  assert.ok(t.changes() >= 3);
  // agreed before: the intro only; both done: nothing
  const back = welcome({ seen: { [SEEN.consent]: true } });
  await back.w.start();
  assert.equal(back.w.step, 'intro');
  const done = welcome({ seen: { [SEEN.consent]: true, [SEEN.intro]: true } });
  await done.w.start();
  assert.equal(done.w.blocking, false);
});

test('storage that can’t be read shows the consent again; a step that can’t be kept still moves on', async () => {
  const unread = welcome({ getFails: true });
  await unread.w.start();
  assert.equal(unread.w.step, 'consent');
  const unkept = welcome({ setFails: true });
  await unkept.w.start();
  unkept.els['consent-ok'].listeners.click();
  await tick();
  assert.equal(unkept.w.step, 'intro');
  // storage that answers nothing at all reads as nothing seen
  const empty = welcome();
  (empty.w as any).o.chrome.storage.local.get = async () => undefined;
  await empty.w.start();
  assert.equal(empty.w.step, 'consent');
});

test('the pin tip: shown while the extension isn’t on the toolbar, until dismissed; kept dismissed', async () => {
  const t = welcome({ seen: { [SEEN.consent]: true, [SEEN.intro]: true } });
  await t.w.start();
  await t.w.pinTip();
  assert.equal(t.els['pin-tip'].hidden, false);
  t.els['pin-off'].listeners.click();
  await tick();
  assert.equal(t.els['pin-tip'].hidden, true);
  assert.equal(t.store[SEEN.pinTip], true);
  // pinned while it shows: it goes
  let changed: (s: any) => void = () => undefined;
  const pinned = welcome({
    toolbar: { getUserSettings: async () => ({ isOnToolbar: false }), onUserSettingsChanged: { addListener: (f: any) => (changed = f) } },
  });
  await pinned.w.start();
  await pinned.w.pinTip();
  assert.equal(pinned.els['pin-tip'].hidden, false);
  changed({ isOnToolbar: false });
  assert.equal(pinned.els['pin-tip'].hidden, false);
  changed({ isOnToolbar: true });
  assert.equal(pinned.els['pin-tip'].hidden, true);
  // dismissed before: never asked
  const dismissed = welcome({ seen: { [SEEN.pinTip]: true }, toolbar: { getUserSettings: async () => assert.fail('asked') } });
  await dismissed.w.start();
  await dismissed.w.pinTip();
  for (const toolbar of [
    { getUserSettings: async () => ({ isOnToolbar: true }) },
    { getUserSettings: async () => Promise.reject(new Error('no action')) },
    {},
    undefined,
  ]) {
    const x = welcome({ toolbar });
    await x.w.start();
    await x.w.pinTip();
    assert.equal(x.els['pin-tip'].hidden, true);
  }
});

test('a chat’s first read: a spinner, then its rows; Try again after 15 s or a failure, and Try again reads again', async () => {
  const els: Record<string, any> = {};
  const timeouts: { f: Function; ms: number; id: number }[] = [];
  let n = 0;
  const timers = {
    setTimeout: (f: Function, ms: number) => (timeouts.push({ f, ms, id: ++n }), n),
    clearTimeout: (id: number) => {
      const i = timeouts.findIndex((x) => x.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    },
  };
  const reads: { answer: (r: any) => void; fail: (e: Error) => void }[] = [];
  const errors: string[] = [];
  const thread = new PanelThread({
    document: {
      getElementById: (id: string) => (els[id] ??= el()),
      createElement: (tag: string) => el(tag),
      createTextNode: (text: string) => ({ textContent: text }),
    },
    request: () => new Promise((answer, fail) => reads.push({ answer, fail })),
    onError: (t: string) => errors.push(t),
    onOpen: () => undefined,
    timers,
  });
  const opened = thread.open('c1');
  assert.equal(els.loading.hidden, false);
  assert.equal(timeouts[0].ms, LOAD_MS);
  reads[0].answer({ rows: [{ role: 'assistant', text: 'hi' }] });
  await opened;
  assert.equal(els.loading.hidden, true);
  assert.equal(timeouts.length, 0);
  // a read that takes too long
  void thread.open('c2');
  timeouts[0].f();
  assert.equal(els['load-error'].hidden, false);
  assert.equal(els.loading.hidden, true);
  // Try again: the spinner and another read; this one fails at once
  els['load-again'].listeners.click();
  assert.equal(els.loading.hidden, false);
  reads[1].answer({ rows: [] });
  await tick();
  // the slow read's answer arrived: it loaded after all
  assert.equal(els.loading.hidden, true);
  // Try again while that read was out queued one more read of the same chat (one read at a time)
  reads.at(-1)!.answer({ rows: [] });
  await tick();
  const third = thread.open('c3');
  reads.at(-1)!.fail(new Error("That chat isn't in MoPilot."));
  await third;
  assert.equal(els['load-error'].hidden, false);
  assert.deepEqual(errors, ["That chat isn't in MoPilot."]);
  // a watchdog for a chat no longer open says nothing; New chat clears the line
  void thread.open('c4');
  const stale = timeouts.at(-1)!;
  thread.close();
  stale.f();
  assert.equal(els['load-error'].hidden, true);
  assert.equal(els.loading.hidden, true);
  // c4's read, still out, ends
  reads.at(-1)!.answer({ rows: [] });
  await tick();
  // a later read failing on a chat that loaded leaves the rows as they are
  const fifth = thread.open('c5');
  reads.at(-1)!.answer({ rows: [] });
  await fifth;
  const again = thread.read();
  reads.at(-1)!.fail(new Error('flaky'));
  await again;
  assert.equal(els['load-error'].hidden, true);
  // the page's own timers when none are given
  const plain = new PanelThread({
    document: { getElementById: () => el(), createElement: () => el() },
    request: async () => ({}),
    onError: () => undefined,
    onOpen: () => undefined,
  });
  assert.equal(plain.timers, globalThis);
});

test('the page: a first run shows the consent before the composer; once agreed, the intro, then the chat', async () => {
  const p = panelPage({ firstRun: true, tab: null });
  await startSidePanel(p.g).ready;
  await tick();
  await tick();
  assert.equal(p.els.welcome.hidden, false);
  assert.equal(p.els.composer.hidden, true);
  assert.equal(p.els.empty.hidden, true);
  p.els['consent-ok'].listeners.click();
  await tick();
  assert.equal(p.els.intro.hidden, false);
  p.els['intro-next'].listeners.click();
  p.els['intro-next'].listeners.click();
  await tick();
  assert.equal(p.els.welcome.hidden, true);
  assert.equal(p.els.composer.hidden, false);
  assert.equal(p.els.empty.hidden, false);
  // The minimal empty state does not fetch a hidden task list.
  const tasks = p.sent().filter((m: any) => m.method === 'scheduled');
  assert.equal(tasks.length, 0);
});

test('scheduled tasks are fetched on opening history, not on the minimal greeting', async () => {
  const next = new Date(2026, 9, 22, 15, 2).getTime();
  const p = panelPage({
    tab: null,
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'scheduled') return { status: 'connected', result: { tasks: [{ id: 't1', name: 'Morning brief', next }] } };
      return { status: 'connected', result: { opened: true } };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  await tick();
  assert.equal(p.sent().filter((m: any) => m.method === 'scheduled').length, 0);
  p.els.side.listeners.click();
  await tick();
  assert.equal(p.els.tasks.children[0].children[0].textContent, 'Morning brief');
});
