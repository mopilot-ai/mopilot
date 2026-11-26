// What the phone does so that a message the person sent is never lost or sent twice: the draft goes only once the message is on the phone, a failed keep says why with Try again, a computer that fails to answer never makes the phone forget, and one that does not answer is said so.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fakeDraft } from './support/phone/drafts';
import { waitFor } from './support/waitFor';
import { createFixtureTransport, createMomoStore, fixtureView, mount, tap, unmountAll, type Any } from './support/phone/momo-screens';

const parts = '../mobile/src/screens/momoPhone/ChatParts';
const transportPath = '../mobile/src/momoPhone/transport';
const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const cachePath = '../mobile/src/screens/momoPhone/HomeCacheProvider';
const entryPath = '../mobile/src/screens/momoPhone/MomoEntry';
const { HeaderPill, ProblemBanners, HomeBanner } = await import(parts);
const { parseHomeView, parseIntentResult } = await import(transportPath);
const { useMomoHome, useMomoHomeStore, HELLO_WAIT_MS, forgetMomoHomeAnswers } = await import(hookPath);
const { HomeCacheContext } = await import(cachePath);
const { MomoEntry } = await import(entryPath);
const storeCtx = '../mobile/src/screens/momoPhone/useMomoStore';
const { MomoStoreContext } = await import(storeCtx);

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ids = () => {
  let n = 0;
  return () => `t${++n}`;
};
const quiet = (over: Any = {}) => ({
  load: async () => fixtureView(),
  subscribe: () => () => undefined,
  send: async () => ({ ok: true }),
  ...over,
});
const send = () => [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Send').at(-1) as HTMLElement;

test('sendText answers only once the message is on the phone: the draft is not cleared before', async () => {
  const waiting: (() => void)[] = [];
  const persist = { load: async () => ({ status: 'none' }), save: () => new Promise<void>((resolve) => waiting.push(resolve)) };
  const store = createMomoStore(quiet(), { newId: ids(), persist });
  await store.load();
  let kept: boolean | undefined;
  void store.sendText('hello').then((v: boolean) => (kept = v));
  await settle();
  assert.equal(kept, undefined, 'the write has not finished');
  // the writes go one after another; the message is kept when its own write is done
  await waitFor(() => (waiting.shift()?.(), kept), 'the message to be kept');
  assert.equal(kept, true);
  // a second message waits behind the first: one save at a time
  assert.equal(await store.sendText('   '), false, 'nothing to send');
  store.dispose();
  assert.equal(await store.sendText('late'), false);
});

test('a message waiting to be saved when the screen goes is not taken', async () => {
  const persist = { load: async () => ({ status: 'none' }), save: () => new Promise<void>(() => undefined) };
  const store = createMomoStore(quiet(), { newId: ids(), persist });
  await store.load();
  const pending = store.sendText('one');
  store.dispose();
  assert.equal(await pending, false);
});

test('a doubt that could not be written is not sent; the cause says so with Try again, and Try again goes on', async () => {
  const sent: string[] = [];
  let broken = true;
  const persist = {
    load: async () => ({ status: 'none' }),
    save: async (copy: Any) => {
      if (broken && copy.turns.some((t: Any) => t.delivery === 'not-sure')) throw new Error('disk full');
    },
  };
  const store = createMomoStore(quiet({ send: async (i: Any) => (sent.push(i.kind), { ok: true }) }), { newId: ids(), persist });
  await store.load();
  assert.equal(await store.sendText('hello'), true, 'the message itself was kept');
  await settle();
  assert.deepEqual(sent, []);
  assert.deepEqual(store.get().failure.fix, { label: 'Try again', intent: { kind: 'retry-held' } });
  assert.equal(store.get().turns[0].delivery, 'queued');
  broken = false;
  await store.act({ kind: 'retry-held' });
  await settle();
  assert.deepEqual(sent, ['send']);
  assert.equal(store.get().failure, null);
  assert.equal(store.get().turns[0].delivery, 'accepted');
});

test('the composer keeps the draft when the message could not be kept, puts the keyboard away on Send, and clears it when it was kept', async () => {
  const failing = { load: async () => ({ status: 'none' }), save: async () => Promise.reject(new Error('disk full')) };
  const store = createMomoStore(createFixtureTransport(fixtureView()), { newId: ids(), persist: failing });
  const m = await mount(undefined, {}, { store });
  (globalThis as Any).__keyboardDismissed = 0;
  await act(async () => m.drafts.set('keep me'));
  await act(async () => send().click());
  await flush();
  await settle();
  assert.equal((globalThis as Any).__keyboardDismissed, 1);
  assert.equal(m.drafts.get(), 'keep me', 'the message could not be kept: the text stays');
  assert.match(m.text(), /Couldn't save the message on this phone\. It was not sent\./);
  const fine = createMomoStore(createFixtureTransport(fixtureView()), {
    newId: ids(),
    persist: { load: async () => ({ status: 'none' }), save: async () => undefined },
  });
  const ok = await mount(undefined, {}, { store: fine });
  await act(async () => ok.drafts.set('go'));
  await act(async () => send().click());
  await flush();
  await settle();
  assert.equal(ok.drafts.get(), '');
});

test('cards act on the first tap with the keyboard up, and Where MoMo runs reaches the classic screen with Channels and Pause', async () => {
  let opened = 0;
  const m = await mount(undefined, {}, { classic: () => opened++ });
  assert.equal(
    (globalThis as Any).__scrollEvents.keyboardShouldPersistTaps,
    'handled',
    'taps reach their buttons while the keyboard is up',
  );
  await tap('MoMo · Studio');
  await tap('Channels and Pause');
  assert.deepEqual([opened, m.backs], [1, []], 'it opens the classic screen and does not leave MoMo');
});

function hooked(hello: () => Promise<unknown>) {
  forgetMomoHomeAnswers();
  const forgotten: Any[] = [];
  const access = {
    get: async () => null,
    mark: async () => undefined,
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async (at: Any) => void forgotten.push(at),
  };
  const snap = { user: { id: 'u1' } as Any, selectedPair: 'p1', phase: 'online' };
  const runtime: Any = {
    snapshot: () => snap,
    request: async (method: string) => {
      if (method === 'machine.hello') return hello();
      throw new Error(method);
    },
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = () => ((out.home = useMomoHome(runtime, true)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    out,
    forgotten,
    show: async () => {
      await act(async () => root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe))));
      await flush();
      await flush();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a computer that fails to answer never makes the phone forget what it kept; only its own "not a MoMo home" does', async () => {
  const failed = hooked(() => Promise.reject(new Error('relay down')));
  await failed.show();
  assert.deepEqual(failed.forgotten, [], 'an error is not a no');
  assert.equal(failed.out.home.failed, 'relay down');
  assert.equal(failed.out.home.settled, false);
  await failed.close();
  const no = hooked(async () => ({ capabilities: { momo: true } }));
  await no.show();
  assert.deepEqual(no.forgotten, [{ user: 'u1', pair: 'p1' }]);
  await no.close();
});

test('a computer that does not answer is told after a while, with Try again', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const silent = hooked(() => new Promise(() => undefined));
    await silent.show();
    assert.equal(silent.out.home.failed, null, 'still waiting');
    await act(async () => mock.timers.tick(HELLO_WAIT_MS));
    await flush();
    assert.equal(silent.out.home.failed, "Your computer didn't answer.");
    assert.deepEqual(silent.forgotten, []);
    await silent.close();
  } finally {
    mock.timers.reset();
  }
});

test('the door says a computer that does not answer, with Try again, and Try again asks again', async () => {
  let answers = 0;
  const calls: string[] = [];
  const snap = { phase: 'online', outbox: [], generation: 1, user: { id: 'u' }, pairs: [], selectedPair: 'p-kept' };
  const runtime: Any = {
    snapshot: () => snap,
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    request: async (method: string) => {
      calls.push(method);
      if (method === 'machine.hello') {
        if (answers++ === 0) throw new Error('relay down');
        return { capabilities: { momo: true, momoHome: true } };
      }
      if (method === 'momo.home.view') return { view: fixtureView().view };
      throw new Error(`no ${method}`);
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MomoEntry, {
        runtime,
        state: snap,
        cache: Promise.resolve(null),
        back: () => undefined,
        focus: null,
        drafts: fakeDraft(),
      }),
    ),
  );
  await flush();
  assert.match(host.textContent ?? '', /MoMo isn't reachable/);
  assert.match(host.textContent ?? '', /relay down/);
  await tap('Try again');
  await flush();
  assert.match(host.textContent ?? '', /MoMo · Studio/);
  await act(async () => root.unmount());
  host.remove();
});

test('the home is read for what the screens draw from: an element that is not that is left out', () => {
  const view = fixtureView().view;
  const read = parseHomeView(
    {
      view: {
        ...view,
        problems: [null, { id: 'p' }, { id: 'p', cause: 'c', fix: { id: 'f', label: 'Fix' } }],
        rules: [null, { name: 'no id' }, { id: 'r' }],
        home: {
          ...view.home,
          machines: [null, { name: 'no id' }, { machineId: 'm', name: 'Mini' }],
          sources: [{ id: 'gmail' }, { id: 'g', status: 'ok' }],
        },
      },
    },
    1,
  );
  assert.deepEqual(
    read.view.problems.map((p: Any) => p.id),
    ['p'],
  );
  assert.deepEqual(
    read.view.rules.map((r: Any) => r.id),
    ['r'],
  );
  assert.deepEqual(
    read.view.home.machines.map((m: Any) => [m.machineId, m.agentsSignedIn, m.status]),
    [['m', [], 'offline']],
  );
  assert.deepEqual(
    read.view.home.sources.map((s: Any) => s.id),
    ['g'],
  );
});

test('the home’s status for a turn is read as has, missing or unknown, and nothing else is taken as one', () => {
  for (const turn of ['has', 'missing', 'unknown']) assert.equal(parseIntentResult({ ok: true, turn }, 1).turn, turn);
  for (const turn of ['MISSING', 3, null, undefined]) assert.equal('turn' in parseIntentResult({ ok: true, turn }, 1), false);
});

test('one malformed delivery problem, a header and a banner that cannot be drawn are replaced by nothing or a stand-in, and the rest still draws', async () => {
  const bad = { id: 'bad', cause: { not: 'text' }, fix: { id: 'f', label: 'Fix' } };
  const good = { id: 'good', cause: 'Notifications are off.', fix: { id: 'f2', label: 'Turn on' } };
  const v = fixtureView();
  v.view.problems = [bad, good];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const act1 = () => undefined;
  await act(async () =>
    root.render(
      createElement(
        MomoStoreContext.Provider,
        { value: createMomoStore(quiet()) },
        createElement(
          'div',
          null,
          createElement(ProblemBanners, { view: v, act: act1 }),
          createElement(HeaderPill, { view: v, open: act1 }),
          createElement(HomeBanner, { view: v, act: act1 }),
        ),
      ),
    ),
  );
  assert.match(host.textContent ?? '', /Notifications are off\./);
  await act(async () => root.unmount());
  const sick = createRoot(host);
  const hurt = { ...v, view: { ...v.view, home: null } };
  await act(async () =>
    sick.render(
      createElement(
        'div',
        null,
        createElement(HeaderPill, { view: hurt, open: act1 }),
        createElement(HomeBanner, { view: hurt, act: act1 }),
      ),
    ),
  );
  assert.match(host.textContent ?? '', /MoMo/, 'the way to Where MoMo runs stays');
  await act(async () => sick.unmount());
  host.remove();
});

test('an answer that comes after the screen went changes nothing, and whoever asked still gets it', async () => {
  let release: (r: Any) => void = () => undefined;
  const persist = { load: async () => ({ status: 'none' }), save: async () => undefined };
  const store = createMomoStore(quiet({ send: () => new Promise((resolve) => (release = resolve)) }), { newId: ids(), persist });
  await store.load();
  await store.sendText('hello');
  await settle();
  store.dispose();
  release({ ok: true });
  await settle();
  assert.deepEqual(store.get().turns, []);
  // the same when the send never got an answer
  let fail: (e: unknown) => void = () => undefined;
  const lost = createMomoStore(quiet({ send: () => new Promise((_, reject) => (fail = reject)) }), { newId: ids(), persist });
  await lost.load();
  await lost.sendText('hello');
  await settle();
  lost.dispose();
  fail(new Error('gone'));
  await settle();
  assert.deepEqual(lost.get().turns, []);
});

test('Check again with a home that says it has the turn lets it go without listing it; reading again what cannot be read is told once', async () => {
  const has = await (async () => {
    const persist = { load: async () => ({ status: 'none' }), save: async () => undefined };
    const store = createMomoStore(
      quiet({
        send: async (i: Any) => {
          if (i.kind === 'send') throw new Error('lost');
          return { ok: true, turn: 'has' };
        },
      }),
      { newId: ids(), persist },
    );
    await store.load();
    await store.sendText('hello');
    await settle();
    await store.act({ kind: 'check-turn', turnId: 't1' });
    await settle();
    return store.get().turns[0].delivery;
  })();
  assert.equal(has, 'accepted');
  let reads = 0;
  const persist = { load: async () => (reads++, { status: 'unreadable' }), save: async () => undefined };
  const store = createMomoStore(quiet(), { newId: ids(), persist });
  await store.load();
  await store.load();
  assert.equal(reads, 2, 'Try again reads it again');
  assert.deepEqual([store.get().lost, store.get().failure], [true, null]);
});

test('More on Where MoMo runs opens the classic screen, and its Back returns to the home screens', async () => {
  await unmountAll();
  const snap = { phase: 'online', outbox: [], generation: 1, user: { id: 'u' }, pairs: [], selectedPair: 'p-classic' };
  const runtime: Any = {
    snapshot: () => snap,
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    request: async (method: string) => {
      if (method === 'machine.hello') return { capabilities: { momo: true, momoHome: true } };
      if (method === 'momo.home.view') return { view: fixtureView().view };
      throw new Error(`no ${method}`);
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MomoEntry, {
        runtime,
        state: snap,
        cache: Promise.resolve(null),
        back: () => undefined,
        focus: null,
        drafts: fakeDraft(),
      }),
    ),
  );
  await flush();
  await tap('MoMo · Studio');
  await tap('Channels and Pause');
  assert.doesNotMatch(host.textContent ?? '', /Channels and Pause/, 'the classic screen is up');
  await tap('Back');
  assert.match(host.textContent ?? '', /MoMo · Studio/, 'Back returns to the home screens');
  await act(async () => root.unmount());
  host.remove();
});

test('a copy that was there to read and is gone when the message is to be kept fails the keep: nothing is sent', async () => {
  let asked = 0;
  const cache = { load: async () => ({ status: 'none' }), save: async () => undefined };
  const access = {
    get: async () => (asked++ === 0 ? cache : null),
    mark: async () => undefined,
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async () => undefined,
  };
  const snap = { user: { id: 'u1' } as Any, selectedPair: 'p1', phase: 'online' };
  const runtime: Any = {
    snapshot: () => snap,
    request: async (method: string) => (method === 'momo.home.view' ? { view: fixtureView().view } : { ok: true }),
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = () => ((out.store = useMomoHomeStore(runtime, JSON.stringify(['u1', 'p1']), true)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe))));
  await out.store.load();
  assert.equal(await out.store.sendText('hi'), false);
  assert.match(out.store.get().failure.cause, /Couldn't save the message/);
  await act(async () => root.unmount());
  host.remove();
});

test('a read of what was kept that comes after the screen went changes nothing', async () => {
  let done: (r: Any) => void = () => undefined;
  const persist = { load: () => new Promise((resolve) => (done = resolve)), save: async () => undefined };
  const store = createMomoStore(quiet(), { newId: ids(), persist });
  const loading = store.load();
  store.dispose();
  done({ status: 'ok', copy: { notes: [], turns: [{ id: 'k', text: 'old', at: 1, delivery: 'queued' }] } });
  await loading;
  assert.deepEqual(store.get().turns, []);
});

test('a write that comes after a sign-out or a switch is not kept: it must not bring back what was forgotten', async () => {
  const saved: Any[] = [];
  const cache = { load: async () => ({ status: 'none' }), save: async (_at: Any, copy: Any) => void saved.push(copy) };
  const access = {
    get: async () => cache,
    mark: async () => undefined,
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async () => undefined,
  };
  const snap: Any = { user: { id: 'u1' }, selectedPair: 'p1', phase: 'online' };
  const runtime: Any = {
    snapshot: () => snap,
    request: async () => ({ view: fixtureView().view }),
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = () => ((out.store = useMomoHomeStore(runtime, JSON.stringify(['u1', 'p1']), true)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe))));
  await out.store.load();
  assert.equal(await out.store.sendText('before'), true);
  snap.user = null;
  assert.equal(await out.store.sendText('after sign-out'), false);
  assert.equal(
    saved.some((c) => c.turns.some((t: Any) => t.text === 'after sign-out')),
    false,
  );
  await act(async () => root.unmount());
  host.remove();
});
