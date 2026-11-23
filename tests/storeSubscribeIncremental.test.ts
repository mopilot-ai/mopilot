// Guard: a store write costs O(changed keys), not O(all chats), in the non-React store listeners.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ownInputsChanged } from '../src/harness/claude/own.ts';
import { createOwnSettingsSync } from '../src/harness/claude/ownSettings.ts';
import { startPresencePolling } from '../src/harness/claude/presencePolling.ts';
import { eachNewlyCrashed } from '../src/store/crashedSessions.ts';
import { onlyChatStreams } from '../src/harness/onlyChatStreams.ts';

const CHATS = 200;
const ids = Array.from({ length: CHATS }, (_, i) => `c${i}`);
const base = (): any => {
  const settings = Object.fromEntries(ids.map((id) => [id, { model: 'sonnet', effort: 'low' }]));
  return {
    runtime: Object.fromEntries(ids.map((id) => [id, { turns: [], settings: settings[id] }])) as Record<string, any>,
    chatConfig: {} as Record<string, any>,
    claudeChats: {} as Record<string, any>,
    claude: { models: [{ id: 'sonnet' }] },
    momoModels: {} as Record<string, string>,
  };
};

function harness() {
  const looked: string[] = [];
  const calls: [string, any][] = [];
  const sync = createOwnSettingsSync({
    familyOf: (id) => (looked.push(id), 'claude'),
    send: async (id, own) => void calls.push([id, own]),
  });
  return { looked, calls, sync };
}

test('1000 unrelated runtime writes across 200 chats look at no chat', () => {
  const { looked, calls, sync } = harness();
  let s = base();
  sync(s);
  assert.equal(calls.length, CHATS);
  looked.length = 0;
  for (let i = 0; i < 1000; i++) {
    const id = ids[i % CHATS];
    const prev = s;
    s = { ...s, runtime: { ...s.runtime, [id]: { ...s.runtime[id], turns: [i] } } };
    sync(s, prev);
  }
  assert.equal(looked.length, 0);
  assert.equal(calls.length, CHATS);
});

test('only the chats whose settings, config, login or MoMo model changed are sent', () => {
  const { looked, calls, sync } = harness();
  let s = base();
  sync(s);
  looked.length = 0;
  calls.length = 0;
  const step = (patch: any) => {
    const prev = s;
    s = { ...s, ...patch };
    sync(s, prev);
  };
  step({ runtime: { ...s.runtime, c1: { settings: { model: 'sonnet', effort: 'high' } } } });
  assert.deepEqual(looked, ['c1']);
  assert.equal(calls.length, 1);
  step({ chatConfig: { c2: { model: 'sonnet', effort: 'low' } } });
  step({ claudeChats: { c3: { id: 'login' } } });
  step({ momoModels: { c4: 'sonnet' } });
  assert.deepEqual(
    calls.map(([id]) => id),
    ['c1', 'c3'],
    'c2 and c4 resolve to what was already sent',
  );
  // a chat dropped from runtime, and a chat config removed, are looked at once
  const { c5: _gone, ...rest } = s.runtime;
  looked.length = 0;
  step({ runtime: rest });
  assert.deepEqual(looked, ['c5']);
  looked.length = 0;
  step({ chatConfig: {} });
  assert.deepEqual(looked, ['c2']);
});

test('a harness switch (segments only) looks at that chat once', () => {
  const { looked, sync } = harness();
  let s: any = base();
  sync(s);
  looked.length = 0;
  const prev = s;
  s = { ...s, segments: { c9: [{ harness: 'claude' }] } };
  sync(s, prev);
  assert.deepEqual(looked, ['c9']);
  // and the production gate sees segments as an input
  assert.equal(ownInputsChanged(s, prev), true);
  assert.equal(ownInputsChanged({ ...s, claude: { models: [] } }, s), true, 'the model list alone');
});

test('a new model list re-reads every chat', () => {
  const { looked, sync } = harness();
  let s = base();
  sync(s);
  looked.length = 0;
  const prev = s;
  s = { ...s, claude: { models: [{ id: 'opus' }] } };
  sync(s, prev);
  assert.equal(looked.length, CHATS);
});

function fakeDoc(hidden = false) {
  const listeners: Record<string, () => void> = {};
  return {
    hidden,
    addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
    removeEventListener: (type: string) => void delete listeners[type],
    fire: (type: string) => listeners[type]?.(),
  };
}

test('presence polling: every 4 s in front, 20 s behind, parked while hidden, once on return', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  try {
    let scans = 0;
    let front = true;
    const doc = fakeDoc();
    const stop = startPresencePolling(
      () => void scans++,
      () => front,
      doc as any,
    );
    mock.timers.tick(4000);
    mock.timers.tick(4000);
    assert.equal(scans, 2);
    front = false;
    mock.timers.tick(4000);
    assert.equal(scans, 2, 'behind: waits for 20 s since the last scan');
    mock.timers.tick(16_000);
    assert.equal(scans, 3);
    doc.hidden = true;
    mock.timers.tick(60_000);
    assert.equal(scans, 3, 'hidden: no scan');
    doc.fire('visibilitychange');
    assert.equal(scans, 3, 'still hidden');
    doc.hidden = false;
    doc.fire('visibilitychange');
    assert.equal(scans, 4, 'visible again: one scan');
    doc.fire('visibilitychange');
    assert.equal(scans, 4, 'events landing together share the scan');
    stop();
    doc.hidden = false;
    doc.fire('visibilitychange');
    mock.timers.tick(60_000);
    assert.equal(scans, 4, 'stopped: no timer, no listener');
  } finally {
    mock.timers.reset();
  }
});

test('presence polling also scans when the window regains focus', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 2_000_000 });
  const listeners: Record<string, () => void> = {};
  const removed: string[] = [];
  (globalThis as any).window = {
    addEventListener: (t: string, f: () => void) => void (listeners[t] = f),
    removeEventListener: (t: string) => void removed.push(t),
  };
  try {
    let scans = 0;
    const stop = startPresencePolling(
      () => void scans++,
      () => true,
      fakeDoc() as any,
    );
    listeners.focus();
    assert.equal(scans, 1);
    stop();
    assert.deepEqual(removed, ['focus']);
  } finally {
    delete (globalThis as any).window;
    mock.timers.reset();
  }
  // no window or document (a non-browser host), then the page's own document by default
  const bare = startPresencePolling(
    () => {},
    () => true,
  );
  bare();
  const real = fakeDoc();
  (globalThis as any).document = real;
  try {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 3_000_000 });
    let scans = 0;
    const stop = startPresencePolling(
      () => void scans++,
      () => true,
    );
    mock.timers.tick(4000);
    real.fire('visibilitychange');
    assert.equal(scans, 1, 'the interval scan, then the event within a second shares it');
    stop();
  } finally {
    delete (globalThis as any).document;
    mock.timers.reset();
  }
});

test('crash listener visits only replaced sessions and fires once per new crash', () => {
  const seen: [string, unknown][] = [];
  const mk = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { turn: 'idle' }]));
  const prev: any = mk(CHATS);
  eachNewlyCrashed(prev, prev, (id, c) => seen.push([id, c]));
  assert.equal(seen.length, 0, 'same map');
  const next = { ...prev, s7: { turn: 'crashed', crashed: 'boom' }, s8: { turn: 'idle' } };
  eachNewlyCrashed(next, prev, (id, c) => seen.push([id, c]));
  assert.deepEqual(seen, [['s7', 'boom']]);
  eachNewlyCrashed({ ...next, s7: { ...next.s7 } }, next, (id, c) => seen.push([id, c]));
  assert.equal(seen.length, 1, 'already crashed');
  eachNewlyCrashed({ s9: undefined, n: { turn: 'crashed', crashed: null } }, {}, (id, c) => seen.push([id, c]));
  assert.equal(seen.length, 2, 'a new crashed session counts; an undefined entry does not');
});

test('limit watch skips writes that only moved chats, not ones that add a chat or touch anything else', () => {
  const runtime = { a: {}, b: {} };
  const s: any = { runtime, accounts: {}, prefs: {} };
  assert.equal(onlyChatStreams(s, { ...s, runtime: { ...runtime, a: { turns: 1 } } }), true);
  assert.equal(onlyChatStreams(s, s), false, 'nothing changed in runtime');
  assert.equal(onlyChatStreams({ ...s, runtime: { ...runtime }, accounts: {} }, s), false, 'another slice moved');
  assert.equal(onlyChatStreams({ ...s, runtime: { ...runtime, c: {} } }, s), false, 'a chat added');
  assert.equal(onlyChatStreams({ ...s, runtime: { a: runtime.a, c: {} } }, s), false, 'a chat swapped for another');
  assert.equal(onlyChatStreams({ ...s, runtime: { a: runtime.a } }, s), false, 'a chat dropped');
});
