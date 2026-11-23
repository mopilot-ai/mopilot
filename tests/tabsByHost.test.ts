// Browser tabs owned by (hostId, chatId) (electron/capabilities/browser/tabsByHost.cjs, hostTabKey.cjs, package 3.4): a continue moves the chat, not its tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
import { world, sent } from './support/remote-tabs-kit.ts';

const require = createRequire(import.meta.url);
const { TabsByHost, RELEASED_IDLE_MS } = require('../electron/capabilities/browser/tabsByHost.cjs');
const { encodeTabKey, decodeTabKey, LOCAL_HOST } = require('../electron/capabilities/browser/hostTabKey.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

/** This Mac's tabs, as far as the router sees them: what it calls, recorded. */
function localTabs() {
  const calls: any[][] = [];
  const t: any = {
    calls,
    o: { marker: 'local-options' },
    chats: new Map(),
    leaseList: [{ surface: 'iab', id: 'tab_local', origin: 'agent' }],
    resolve: (...a: any[]) => (calls.push(['resolve', ...a]), { host: t, id: 'tab_local' }),
    create: (...a: any[]) => (calls.push(['create', ...a]), { host: t, id: 'tab_local' }),
    run: (...a: any[]) => (calls.push(['run', ...a]), 'ran-local'),
    list: () => [],
    change: () => undefined,
    mark: () => undefined,
    readPage: (...a: any[]) => (calls.push(['readPage', ...a]), { lines: ['local page'] }),
    leases: (c: string) => (calls.push(['leases', c]), t.leaseList),
    turnEnded: async (c: string) => void calls.push(['turnEnded', c]),
    forget: (c: string) => void calls.push(['forget', c]),
    turnEndListeners: new Set<(c: string) => void>(),
    onTurnEnd: (fn: (c: string) => void) => (t.turnEndListeners.add(fn), () => t.turnEndListeners.delete(fn)),
  };
  return t;
}

/** A router over this Mac and real RemoteTabs on two fake Hosts; `owner.of` is the chat's Host now. */
function rig(t: any, o: any = {}) {
  const local = localTabs();
  const h1 = world(t, { hostId: 'h1' });
  const h2 = world(t, { hostId: 'h2' });
  const worlds: Record<string, any> = { h1, h2 };
  const owner = { of: 'h1' as string };
  const timers: { fn: Function; ms: number; cleared: boolean; unref: () => void }[] = [];
  const made: string[] = [];
  const router = new TabsByHost({
    local,
    ownerOf: (c: string) => (c === 'localChat' ? LOCAL_HOST : owner.of),
    make: (id: string) => (made.push(id), worlds[id]?.tabs ?? null),
    setTimer: (fn: Function, ms: number) => {
      const timer = { fn, ms, cleared: false, unref: () => undefined };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: any) => {
      timer.cleared = true;
    },
    ...o,
  });
  const spy = (name: string, tabs: any) => {
    const seen: string[] = [];
    const real = tabs.turnEnded.bind(tabs);
    tabs.turnEnded = (c: string) => (seen.push(`${name}:${c}`), real(c));
    return seen;
  };
  return { local, h1, h2, owner, router, timers, made, spy };
}

test('I2: the pane key keeps a tab here as it was and names the Host of every other; no hostId or tab id can collide through a delimiter', () => {
  assert.equal(encodeTabKey(LOCAL_HOST, 'tab_a'), 'tab_a');
  assert.equal(encodeTabKey(LOCAL_HOST, null), null);
  assert.deepEqual(decodeTabKey('tab_a'), { hostId: LOCAL_HOST, tabKey: 'tab_a' });
  assert.deepEqual(decodeTabKey(null), { hostId: LOCAL_HOST, tabKey: null });
  assert.deepEqual(decodeTabKey(''), { hostId: LOCAL_HOST, tabKey: null });
  assert.deepEqual(decodeTabKey(7), { hostId: LOCAL_HOST, tabKey: null });
  // the same tab id on two Hosts is two keys
  assert.notEqual(encodeTabKey('h1', 'tab_a'), encodeTabKey('h2', 'tab_a'));
  assert.notEqual(encodeTabKey('h1', 'tab_a'), encodeTabKey(LOCAL_HOST, 'tab_a'));
  // delimiters and quotes in a hostId or a tab id round-trip: a Host "a|b" with tab "c" is not Host "a" with tab "b|c"
  for (const [hostId, tabKey] of [
    ['a|b', 'c'],
    ['a', 'b|c'],
    ['a","b', 'c'],
    ['["host","x","y"]', 'z'],
    ['__proto__', 'tab_1'],
  ]) {
    assert.deepEqual(decodeTabKey(encodeTabKey(hostId, tabKey)), { hostId, tabKey });
  }
  assert.notEqual(encodeTabKey('a|b', 'c'), encodeTabKey('a', 'b|c'));
  // anything else that merely looks like a key is a plain tab id here
  for (const odd of [
    '[',
    '[not json',
    '{"a":1}',
    '[1,2,3]',
    '["host","h1"]',
    '["tab","h1","t"]',
    '["host","","t"]',
    '["host","local","t"]',
    '["host","h1",""]',
    '["host","h1",3]',
    '["host",5,"t"]',
  ]) {
    assert.deepEqual(decodeTabKey(odd), { hostId: LOCAL_HOST, tabKey: odd }, odd);
  }
});

test('the Host a call reaches is the chat’s Host when it is called: a continue mid-action leaves the old tab on the source and opens a fresh one on the target', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  const old = await tabs.create('c');
  assert.equal(r.router.ids.get(old.host), 'h1');
  assert.equal(r.h1.tabs.list('c').length, 1);
  const targetOnSource = old.backend.targetId;

  // the continue commits while the agent's step on the old tab is still running
  const step = deferred<void>();
  const running = (async () => {
    await step.promise;
    return tabs.readPage(old);
  })();
  r.owner.of = 'h2';
  step.resolve();
  const read = await running;
  assert.deepEqual(read.lines, ['- button "Go" [ref_1]']);
  // the step went to the Host the tab is on, not to the Host the chat is on now
  assert.equal(r.h2.chromium.log.length, 0);
  assert.equal(sent(r.h1, 'Accessibility.getFullAXTree').length + sent(r.h1, 'Runtime.evaluate').length > 0, true);

  // the target starts with none; the agent's next call opens one there
  assert.equal(r.h2.tabs.list('c').length, 0);
  const fresh = await tabs.create('c');
  assert.equal(r.router.ids.get(fresh.host), 'h2');
  assert.equal(r.h2.tabs.list('c').length, 1);
  // the source still has its tab, open, and resolving the chat’s tab goes to the target
  assert.equal(r.h1.tabs.list('c').length, 1);
  assert.equal(r.h1.chromium.targets.has(targetOnSource), true);
  assert.equal((await tabs.resolve('c', null)).id, fresh.id);
  // the source's tab is no more the target's: the Host refuses it
  await assert.rejects(r.h2.tabs.resolve('c', old.id), (e: any) => /No tab/.test(e.message));
});

test('I2: leases list the chat’s tabs under their own Host, this Mac included', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  await tabs.create('c');
  r.owner.of = 'h2';
  await tabs.create('c');
  const leases = r.router.leases('c');
  assert.deepEqual(
    leases.map((l: any) => [l.hostId, l.surface]),
    [
      ['local', 'iab'],
      ['h1', 'iab'],
      ['h2', 'iab'],
    ],
  );
  // routed() hands the same answer to the turn-end sweep and the handoff record
  assert.deepEqual(tabs.leases('c'), leases);
  // a Host that cannot say what it holds lists nothing; the others still do
  r.h1.tabs.leases = () => {
    throw new Error('Host gone');
  };
  assert.deepEqual(
    r.router.leases('c').map((l: any) => l.hostId),
    ['local', 'h2'],
  );
});

test('A3: the end of a turn that ran on the source Host lets go of the source only; the target’s tabs are let go of by the turn that acted on them', async (t) => {
  const r = rig(t);
  const onSource = r.spy('h1', r.h1.tabs);
  const onTarget = r.spy('h2', r.h2.tabs);
  const tabs = r.router.routed();
  await tabs.create('c');
  // the continue commits; the old turn ends before the new one acts
  r.owner.of = 'h2';
  await r.router.turnEnded('c');
  assert.deepEqual(onSource, ['h1:c']);
  assert.deepEqual(onTarget, [], 'the target has nothing of the old turn to let go of');
  // the new turn acts on the target and ends: only the target, the source is not let go of again
  await tabs.create('c');
  await r.router.turnEnded('c');
  assert.deepEqual(onSource, ['h1:c']);
  assert.deepEqual(onTarget, ['h2:c']);
  await r.router.turnEnded('c');
  assert.deepEqual([onSource.length, onTarget.length], [1, 1], 'a turn that acted on no Host lets go of none');
});

test('A3: a step running when the chat moves goes on, and what follows it, on the Host it started on; the next pick of a tab follows the chat', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  const old = await tabs.create('c');
  r.owner.of = 'h2';
  // the running step's follow-ups (a note, the tab list) still reach the source, where the step is
  tabs.change('c', 'download_started a.txt');
  assert.equal(r.h1.tabs.chats.get('c').changes.includes('download_started a.txt'), true);
  assert.equal(tabs.list('c').length, 1);
  assert.equal(r.h2.tabs.list('c').length, 0);
  // picking a tab again follows the chat to the target
  const fresh = await tabs.create('c');
  assert.equal(r.router.ids.get(fresh.host), 'h2');
  assert.equal(tabs.list('c')[0].id, fresh.id);
  // the turn's end forgets where it acted: the next turn's first call goes to the chat's Host
  await r.router.turnEnded('c');
  r.owner.of = 'h1';
  assert.equal(tabs.list('c')[0].id, old.id);
  // the Host it acted on went away meanwhile: the call follows the chat
  await tabs.resolve('c', null);
  r.router.dropHost('h1');
  r.owner.of = 'h2';
  assert.equal(tabs.list('c')[0].id, fresh.id);
});

test('a turn that only closes or marks a tab on a Host still lets go there at its end', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  const tab = await tabs.create('c');
  await r.router.turnEnded('c');
  const h1 = r.spy('h1', r.h1.tabs);
  tabs.mark('c', tab.id, 'deliverable');
  await r.router.turnEnded('c');
  assert.deepEqual(h1, ['h1:c']);
});

test('a turn end with the chat on a Host it did not act on lets go of nothing there; a chat here lets go here whether or not a tool ran', async (t) => {
  const r = rig(t);
  const h2 = r.spy('h2', r.h2.tabs);
  const h1 = r.spy('h1', r.h1.tabs);
  // the chat moved to h2 and no tool ran yet: nothing to let go of on h2, the source was not acted on
  r.owner.of = 'h2';
  await r.router.turnEnded('c');
  assert.deepEqual([...h1, ...h2], []);
  assert.equal(r.local.calls.filter((c: any[]) => c[0] === 'turnEnded').length, 0);
  // a chat that lives here is let go of here on every turn end, as before hosts existed
  await r.router.turnEnded('localChat');
  assert.deepEqual(
    r.local.calls.filter((c: any[]) => c[0] === 'turnEnded'),
    [['turnEnded', 'localChat']],
  );
  // a Host dropped since the turn acted on it has nothing to let go of
  await r.router.routed().create('c');
  r.router.dropHost('h2');
  await r.router.turnEnded('c');
});

test('a Host that fails to let go is reported and the others still let go', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  await tabs.create('c');
  r.owner.of = 'h2';
  await tabs.create('c');
  r.h1.tabs.turnEnded = async () => {
    throw new Error('tunnel closed');
  };
  const h2 = r.spy('h2', r.h2.tabs);
  await r.router.turnEnded('c');
  assert.deepEqual(h2, ['h2:c']);
  // one that throws before it returns a promise does not keep the others from letting go either
  await tabs.create('c');
  r.owner.of = 'h1';
  await tabs.create('c');
  r.h1.tabs.turnEnded = () => {
    throw new Error('closed already');
  };
  await r.router.turnEnded('c');
  assert.deepEqual(h2, ['h2:c', 'h2:c']);
});

test('the source Host’s tabs close once the chat stayed away, not before, and never come back with the chat’s return', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  await tabs.create('c');
  await tabs.create('d');
  // the chat moves; nothing is closed on the source yet
  r.owner.of = 'h2';
  r.router.leases('c');
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, RELEASED_IDLE_MS);
  assert.equal(r.h1.tabs.list('c').length, 1);
  // coming back before the end of the wait cancels it
  r.owner.of = 'h1';
  r.router.leases('c');
  assert.equal(r.timers[0].cleared, true);
  // away again: a new wait; looking again does not restart it twice
  r.owner.of = 'h2';
  r.router.leases('c');
  assert.equal(r.timers.length, 2);
  r.router.leases('c');
  assert.equal(r.timers.length, 2);
  r.timers[1].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.h1.calls.includes('release c'), true);
  assert.equal(r.h1.calls.includes('release d'), false, 'another chat’s tabs stay');
  assert.equal(r.h1.tabs.list('c').length, 0);
  assert.equal(r.h1.tabs.list('d').length, 1);
  assert.equal(
    r.h2.calls.some((c: string) => c.startsWith('release')),
    false,
    'the target’s tabs stay',
  );
});

test('a chat that moved and is never called again still starts its countdown once ownership is looked at again', async (t) => {
  const r = rig(t);
  await r.router.routed().create('c');
  r.owner.of = 'h2';
  assert.equal(r.timers.length, 0, 'nothing has looked yet');
  r.router.noticeAll();
  assert.equal(r.timers.length, 1);
  r.router.noticeAll();
  assert.equal(r.timers.length, 1, 'looking again does not restart it');
});

test('a chat that leaves this Mac keeps its tabs here (a deliverable stays open); a chat deleted, or a Host dropped, ends the wait', async (t) => {
  const r = rig(t);
  r.owner.of = LOCAL_HOST;
  r.router.leases('c');
  r.owner.of = 'h2';
  r.router.leases('c');
  assert.equal(r.timers.length, 0);
  // a chat that left a Host and is then deleted: the wait ends and every Host forgets it
  await r.router.routed().create('c');
  r.owner.of = 'h1';
  r.router.leases('c');
  assert.equal(r.timers.length, 1);
  r.router.forget('c');
  assert.equal(r.timers[0].cleared, true);
  assert.deepEqual(
    r.local.calls.filter((c: any[]) => c[0] === 'forget'),
    [['forget', 'c']],
  );
  assert.equal(r.h2.calls.includes('release c'), true);
  // a Host dropped with a wait pending: the wait ends too
  r.owner.of = 'h2';
  await r.router.routed().create('e');
  r.owner.of = 'h1';
  r.router.leases('e');
  assert.equal(r.timers.filter((x) => !x.cleared).length, 1);
  r.router.dropHost('h2');
  assert.equal(r.timers.filter((x) => !x.cleared).length, 0);
});

test('forget goes on to every Host when one fails; dispose lets go of all of them', async (t) => {
  const r = rig(t);
  await r.router.routed().create('c');
  r.owner.of = 'h2';
  await r.router.routed().create('c');
  r.h1.tabs.forget = () => {
    throw new Error('release failed');
  };
  r.router.forget('c');
  assert.equal(r.h2.calls.includes('release c'), true);
  const disposed: string[] = [];
  r.h1.tabs.dispose = () => disposed.push('h1');
  r.h2.tabs.dispose = () => disposed.push('h2');
  r.owner.of = 'h1';
  r.router.leases('c');
  r.owner.of = 'h2';
  r.router.leases('c');
  r.router.dispose();
  assert.deepEqual(disposed.sort(), ['h1', 'h2']);
  assert.equal(
    r.timers.every((x) => x.cleared),
    true,
  );
  assert.deepEqual(
    r.router.entries().map(([id]: any) => id),
    [LOCAL_HOST],
  );
});

test('a Host without a browser service refuses the call, saying so; one made later is used from then on; dropped, it is made anew', async (t) => {
  const r = rig(t);
  r.owner.of = 'h3';
  const tabs = r.router.routed();
  await assert.rejects(
    async () => tabs.create('c'),
    (e: any) => e instanceof ToolError && e.code === 'host_unavailable',
  );
  assert.equal(r.router.existing('h3'), null);
  r.owner.of = 'h1';
  await tabs.create('c');
  await tabs.create('c');
  assert.deepEqual(r.made, ['h3', 'h1'], 'one RemoteTabs per Host');
  r.router.dropHost('h1');
  assert.equal(r.router.existing('h1'), null);
  await tabs.create('c');
  assert.deepEqual(r.made, ['h3', 'h1', 'h1']);
  // this Mac is never dropped
  r.router.dropHost(LOCAL_HOST);
  assert.equal(r.router.existing(LOCAL_HOST), r.local);
  r.router.dropHost('nobody');
});

test('the default router has no Host to make: only this Mac answers', async () => {
  const local = localTabs();
  const router = new TabsByHost({ local, ownerOf: () => 'h9' });
  await assert.rejects(
    Promise.resolve().then(() => router.routed().create('c')),
    (e: any) => e.code === 'host_unavailable',
  );
  const mine = new TabsByHost({ local, ownerOf: () => LOCAL_HOST });
  assert.equal(mine.routed().create('c').id, 'tab_local');
  // real timers, unref'd, when none are injected
  const away = new TabsByHost({ local, ownerOf: () => LOCAL_HOST, make: () => ({ list: () => [{}], forget: () => undefined }) });
  away.forHost('h9');
  away.reapLater('h9', 'c');
  assert.equal(away.reaping.size, 1);
  away.dispose();
  assert.equal(away.reaping.size, 0);
});

test('the routed view: a Tab goes to the tabs that made it, anything else and non-methods to this Mac', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  const remote = await tabs.create('c');
  // a Tab's own call reaches its Host even when the chat has moved
  r.owner.of = 'h2';
  assert.equal(r.router.routeOf(remote, 'run'), r.h1.tabs);
  // objects of no known host, empty strings, null and numbers are this Mac's
  for (const odd of [{}, { host: {} }, '', null, undefined, 3]) assert.equal(r.router.routeOf(odd, 'run'), r.local);
  assert.equal(tabs.run({ host: r.local }), 'ran-local');
  assert.equal(tabs.o.marker, 'local-options');
  // symbols and numbers are read as the properties they are
  assert.equal(typeof (tabs as any)[Symbol.toStringTag], 'undefined');
  // turn end, forget and leases are the router's, which spans Hosts
  assert.equal(Array.isArray(tabs.leases('c')), true);
});

test('A3: what the tools keep per turn is let go of at the end of a turn that ran on a Host, once, even when this Mac was not touched', async (t) => {
  const r = rig(t);
  const tabs = r.router.routed();
  const ended: string[] = [];
  const off = tabs.onTurnEnd((c: string) => void ended.push(c));
  tabs.onTurnEnd(() => {
    throw new Error('a listener that fails');
  });
  // the chat lives on h1 and its tools ran there: the listeners are this Mac's all the same
  await tabs.create('c');
  await r.router.turnEnded('c');
  assert.deepEqual(ended, ['c']);
  // a chat here is told by this Mac's own turn end, which the router does not repeat
  await r.router.turnEnded('localChat');
  assert.deepEqual(ended, ['c']);
  r.local.turnEndListeners.forEach((fn: (c: string) => void) => {
    try {
      fn('localChat');
    } catch {
      // the local tabs tell each listener on its own; one that fails is theirs to report
    }
  });
  assert.deepEqual(ended, ['c', 'localChat']);
  off();
  await tabs.create('c');
  await r.router.turnEnded('c');
  assert.deepEqual(ended, ['c', 'localChat']);
  // this Mac's tabs without a listener set (a stand-in) have no one to tell
  delete r.local.turnEndListeners;
  await tabs.create('c');
  await r.router.turnEnded('c');
});
