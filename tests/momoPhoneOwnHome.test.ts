// The phone reads its own home only while no Mac answers: with the Mac answering the Mac's home is read; the moment it is silent (the phone is away from it, or it does not answer) the phone's own home on its Hosts is read, for an account a Mac once allowed; when the Mac answers again the phone's own home is let go. Over real in-process Hosts.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { A, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { homeIs, mount as mountScreen } from './support/phone/momo-screens';
import { fixtureView } from './support/phone/momo-screens';

// the device's own sealed container is the platform's: here it is an in-memory one
const deviceSealed = { store: { s: { value: null as string | null } } as Any, crypto: null as Any, newId: () => 'device-token-0001' };
mock.module('../mobile/src/platform/momoPhoneHome.ts', {
  namedExports: {
    openPhoneHomeSealed: async () => ({ store: deviceSealed.store, crypto: deviceSealed.crypto, newId: deviceSealed.newId }),
  },
});
const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const memoryPath = '../mobile/src/momoPhone/phoneHome/memory';
const { useMomoHome, forgetMomoHomeAnswers } = await import(hookPath);
// a variable path: a test under tests/ never names mobile's screen code literally (tests/phoneTestsNoStaticMobileImport.invariant.test.ts)
const cachePath = '../mobile/src/screens/momoPhone/HomeCacheProvider';
const { HomeCacheContext } = await import(cachePath);
const { openPhoneHomeMemory } = await import(memoryPath);

type Any = any;
const crypto = {
  key: async () => new Uint8Array(32).fill(5),
  randomBytes: (n: number) => new Uint8Array(n).fill(1),
  seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
    Uint8Array.from([...new TextEncoder().encode(`${aad}|`), ...plain]),
  open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) =>
    new TextDecoder().decode(box).startsWith(`${aad}|`) ? box.slice(aad.length + 1) : null,
};
const sealedStore = () => {
  const s = { value: null as string | null };
  return { s, read: async () => s.value, write: async (v: string) => void (s.value = v), clear: async () => void (s.value = null) };
};

deviceSealed.store = sealedStore();
deviceSealed.crypto = crypto;

/** A runtime whose Mac says what `mac.hello` says (a throw is a Mac that does not answer) and whose Hosts are the world's real ones. */
async function rig(
  t: Any,
  o: {
    hosts?: boolean;
    openFails?: boolean;
    user?: boolean;
    device?: boolean;
    noDirect?: boolean;
    pair?: string | null;
    cache?: boolean;
    silentMs?: number;
  } = {},
) {
  forgetMomoHomeAnswers();
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const mac = { hello: (): unknown => ({ capabilities: { momo: true, momoHome: true } }), viewCalls: 0, viewFails: false };
  const hostCalls: string[] = [];
  const listeners = new Set<() => void>();
  const records = o.hosts === false ? [] : w.machines.map((m: Any) => ({ machineId: m.id, name: m.name, hostKey: m.hostId }));
  const direct = {
    phones: {
      records: () => records,
      reachable: () => true,
      agents: () => null,
      session: async (id: string) => ({
        request: async (method: string, params: object = {}) => {
          hostCalls.push(`${id}:${method}`);
          return w.asHost(id, method, params);
        },
      }),
    },
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  };
  const view = structuredClone(fixtureView().view);
  view.home.machineName = 'From the Mac';
  const events = new Set<(e: Any) => void>();
  const runtime: Any = {
    snapshot: () => ({ user: o.user === false ? null : { id: 'u1' }, selectedPair: o.pair === undefined ? 'p1' : o.pair }),
    subscribe: () => () => undefined,
    onEvent: (fn: (e: Any) => void) => (events.add(fn), () => void events.delete(fn)),
    ...(o.noDirect ? {} : { direct }),
    request: async (method: string) => {
      if (method === 'machine.hello') return mac.hello();
      if (method === 'momo.home.view') {
        mac.viewCalls++;
        if (mac.viewFails) throw new Error('view failed');
        return { view };
      }
      throw new Error(`no ${method}`);
    },
  };
  const store = sealedStore();
  let ids = 0;
  const open = async () => {
    if (o.openFails) throw new Error('keychain locked');
    return { store, crypto, newId: () => `token-${++ids}` };
  };
  const out: { last: Any } = { last: null };
  /** What the phone kept for MoMo's home: a fake home cache the screens save to. */
  const saved: { at: Any; copy: Any }[] = [];
  const cache: Any = {
    load: async () => ({ status: 'none' }),
    save: async (at: Any, copy: Any) => void saved.push({ at, copy }),
  };
  const access = {
    get: async () => cache,
    mark: async () => undefined,
    stamps: async () => ({ view: () => true, stamp: () => true }),
    forgetScope: async () => undefined,
  };
  const Probe = ({ online }: { online: boolean }) => {
    out.last = useMomoHome(runtime, online, o.device ? undefined : open, o.silentMs ?? 30);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = async (online = true) => {
    await act(async () =>
      root.render(
        o.cache
          ? createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe, { online }))
          : createElement(Probe, { online }),
      ),
    );
    for (let i = 0; i < 6; i++) await flush();
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const invited = async () => (await openPhoneHomeMemory({ store, crypto, user: 'u1' })).invited.read();
  const known = async () => (await openPhoneHomeMemory({ store, crypto, user: 'u1' })).known();
  return { w, mac, out, show, hostCalls, store, invited, runtime, listeners, saved, view, known, events };
}

test('with the Mac answering the Mac’s home is read, and the account is remembered as allowed', async (t) => {
  const r = await rig(t);
  await r.show();
  assert.equal(r.out.last.settled, true);
  await r.out.last.store.load();
  assert.equal(r.out.last.store.get().view.view.home.machineName, 'From the Mac');
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  assert.equal(r.hostCalls.filter((c) => c.includes('host.momoHomeLook')).length, 0, 'the Hosts are not asked while a Mac answers');
});

test('with no Mac in reach the phone reads its own home on its Hosts, and the Mac’s again when it answers', async (t) => {
  const r = await rig(t);
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  // the phone is away from its Mac
  await r.show(false);
  // until the silence has held long enough the Mac's home is still what is read
  assert.deepEqual(r.hostCalls, []);
  await waitFor(async () => {
    await r.out.last.store?.load();
    return r.out.last.store?.get().view?.view.home.machineName === 'Studio';
  }, 'the phone’s own home');
  assert.equal(r.out.last.settled, true);
  assert.equal(r.out.last.voice, false);
  assert.equal(r.out.last.failed, null);
  assert.ok(r.hostCalls.some((c) => c === 'studio:host.momoHomeLook'));
  // the Mac answers again: its home is read, and the phone's own is let go
  await r.show(true);
  await waitFor(async () => {
    await r.out.last.store?.load();
    return r.out.last.store?.get().view?.view.home.machineName === 'From the Mac';
  }, 'the Mac’s home again');
  // a call that was already out when it was let go may still land: what counts is that none follows
  await new Promise((res) => setTimeout(res, 50));
  const before = r.hostCalls.length;
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.hostCalls.length, before, 'the phone’s own home asks no Host once let go');
});

test('a Mac that is asked and does not answer is silent too', async (t) => {
  const r = await rig(t);
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  r.mac.hello = () => {
    throw new Error('no answer');
  };
  await r.show(true);
  // the next ask fails: a reload reads again
  r.out.last.retry();
  await waitFor(async () => {
    await r.out.last.store?.load();
    return r.out.last.store?.get().view?.view.home.machineName === 'Studio';
  }, 'the phone’s own home');
});

test('an account no Mac ever allowed, or a phone with no Host of its own, has no home of its own: no Host is asked', async (t) => {
  const never = await rig(t);
  never.mac.hello = () => ({ capabilities: { momo: true } });
  await never.show();
  assert.equal(never.out.last.store, null);
  await never.show(false);
  assert.deepEqual(never.hostCalls, []);
  const none = await rig(t, { hosts: false });
  await none.show();
  await waitFor(async () => (await none.invited()) === true, 'the allowed account to be kept');
  await none.show(false);
  assert.deepEqual(none.hostCalls, []);
});

test('a sealed container that cannot be opened, or nobody signed in, leaves the phone with no home of its own', async (t) => {
  const locked = await rig(t, { openFails: true });
  await locked.show();
  await locked.show(false);
  assert.deepEqual(locked.hostCalls, []);
  const nobody = await rig(t, { user: false });
  await nobody.show();
  await nobody.show(false);
  assert.deepEqual(nobody.hostCalls, []);
});

test('on the device the sealed container is the platform’s own: what the Mac allowed is kept there', async (t) => {
  const r = await rig(t, { device: true });
  await r.show();
  await waitFor(
    async () => (await openPhoneHomeMemory({ store: deviceSealed.store, crypto, user: 'u1' })).invited.read() === true,
    'the allowed account to be kept',
  );
});

test('a runtime with no Hosts of its own has none to read, and a change of the Hosts is heard while the phone’s own home is read', async (t) => {
  const none = await rig(t, { noDirect: true });
  await none.show();
  await none.show(false);
  assert.deepEqual(none.hostCalls, []);
  const r = await rig(t);
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  await r.show(false);
  await waitFor(() => r.out.last.store && r.hostCalls.length > 0, 'the phone’s own home');
  // a Host came or went: the screens hear it and read on
  await act(async () => r.listeners.forEach((fn: () => void) => fn()));
  await flush();
  assert.equal(r.out.last.failed, null);
});

test('a message typed while the phone reads its own home is kept on the phone, beside the Mac’s, even with no Mac chosen', async (t) => {
  const r = await rig(t, { pair: null, cache: true });
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  await r.show(false);
  await waitFor(() => r.out.last.store && r.hostCalls.length > 0, 'the phone’s own home');
  await r.out.last.store.load();
  r.out.last.store.sendText('Remind me to call Dana');
  await waitFor(() => r.saved.some((s: Any) => s.copy.turns.length > 0), 'the message to be kept on the phone');
  assert.deepEqual(r.saved[r.saved.length - 1]?.at, { user: 'u1', pair: 'phone-home' });
});

test('while a Mac answers, where it says MoMo lives and its lease are learned; an answer that says neither teaches nothing', async (t) => {
  const r = await rig(t);
  await r.show();
  await waitFor(r.known, 'the Mac’s home to be learned');
  const memory = await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' });
  assert.equal(memory.seen.read(), 1);
  // the home's own id is what the Mac's view names (`homeMachineId`), and the machine is the row it marks as the home: a held message is tied to the first, never to an empty one
  assert.deepEqual([memory.memory.read()?.homeId, memory.memory.read()?.machineId], ['studio', 'studio']);
  assert.equal(memory.memory.read()?.homeId === '', false);
  const blank = await rig(t);
  blank.view.home.leaseEpoch = null;
  await blank.show();
  await waitFor(async () => (await blank.invited()) === true, 'the allowed account to be kept');
  assert.equal(await blank.known(), false);
  const unnamed = await rig(t);
  unnamed.view.home.machineName = undefined;
  await unnamed.show();
  await waitFor(unnamed.known, 'the home to be learned without a name');
});

test('a hello that merely lacks a capability changes nothing the phone kept, and only an explicit revoke takes the hint away, never the held messages', async (t) => {
  const r = await rig(t);
  // a message already held on the phone when the app opens
  const held = await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' });
  held.outbox.write([{ turnId: 'turn-cccc-0001', chatId: '', text: 'wait for me', createdAt: 1, delivery: 'not-sent' }]);
  await held.settled();
  await r.show();
  await waitFor(r.known, 'the Mac’s home to be learned');
  const kept = async () => {
    const m = await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' });
    return { known: m.known(), invited: m.invited.read(), held: m.outbox.read().map((e: { text: string }) => e.text) };
  };
  // a flag not loaded yet, or a second Mac that does not host MoMo: the account is not said to be revoked
  for (const hello of [{ capabilities: { momo: true } }, { capabilities: {} }, {}]) {
    r.mac.hello = () => hello;
    await r.show(true);
    r.out.last.retry();
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(await kept(), { known: true, invited: true, held: ['wait for me'] }, JSON.stringify(hello));
  }
  // the Mac says so in so many words: the hint goes, what is held stays held (it is not sent from here, and sign-out or the owner deletes it)
  r.mac.hello = () => ({ capabilities: { momo: false } });
  r.out.last.retry();
  await waitFor(async () => (await kept()).invited === false, 'the hint to be taken away');
  assert.deepEqual(await kept(), { known: true, invited: false, held: ['wait for me'] });
});

test('a Mac that comes back within the silence window never makes the phone read its own home, and a Mac that answers with an error is not silent', async (t) => {
  const r = await rig(t, { silentMs: 400 });
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  // answer, away, answer: the window never fills, so no Host is asked
  await r.show(false);
  await new Promise((res) => setTimeout(res, 150));
  await r.show(true);
  await new Promise((res) => setTimeout(res, 600));
  assert.deepEqual(r.hostCalls, []);
  // a live Mac that refuses with an application error has answered: it is not silence
  r.mac.hello = () => {
    throw Object.assign(new Error('Not allowed right now'), { code: 'forbidden' });
  };
  await r.show(true);
  r.out.last.retry();
  await new Promise((res) => setTimeout(res, 700));
  assert.deepEqual(r.hostCalls, []);
  // a Mac that does not answer at all, for the whole window, is
  r.mac.hello = () => {
    throw new Error('Connection closed');
  };
  r.out.last.retry();
  await waitFor(() => r.hostCalls.length > 0, 'the phone’s own home after the window');
});

test('on the phone’s own home no button is offered that only the Mac can run, and on the Mac’s home every one is', async () => {
  const wake = (m: Any) => m.text().includes('Wake');
  const own = await mountScreen(homeIs('asleep'), { own: true });
  assert.equal(wake(own), false, 'no Wake on the phone’s own home');
  assert.match(own.text(), /went to sleep/i);
  const mac = await mountScreen(homeIs('asleep'));
  assert.equal(wake(mac), true);
  const signedOut = await mountScreen(homeIs('needs-sign-in', { agentProblem: { kind: 'signed-out', agent: 'Claude Code', fix: null } }), {
    own: true,
  });
  assert.doesNotMatch(signedOut.text(), /Sign in on/);
  assert.match(signedOut.text(), /signed out/i);
});

test('a Mac whose view cannot be read teaches nothing, and a change it tells teaches the newer lease', async (t) => {
  const r = await rig(t);
  r.mac.viewFails = true;
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  assert.equal(await r.known(), false);
  // the home moved: a change event names the new machine and a higher lease
  await act(async () =>
    r.events.forEach((fn: (e: Any) => void) =>
      fn({
        ev: 'momo.home.changed',
        view: {
          home: {
            homeMachineId: 'home-mini-0001',
            machineName: 'Mac mini',
            leaseEpoch: 3,
            machines: [
              { machineId: 'mini', isHome: true },
              { machineId: 'studio', isHome: false },
            ],
          },
        },
      }),
    ),
  );
  await waitFor(r.known, 'the new home to be learned');
  const memory = await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' });
  assert.deepEqual([memory.seen.read(), memory.memory.read()?.homeId, memory.memory.read()?.machineId], [3, 'home-mini-0001', 'mini']);
  // a home with no marked machine row is still learned, by its id alone
  await act(async () =>
    r.events.forEach((fn: (e: Any) => void) =>
      fn({ ev: 'momo.home.changed', view: { home: { homeMachineId: 'home-x-0001', machineName: 5, leaseEpoch: 4 } } }),
    ),
  );
  await waitFor(
    async () => (await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' })).memory.read()?.homeId === 'home-x-0001',
    'the unnamed machine to be learned',
  );
  const bare = (await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' })).memory.read();
  assert.deepEqual([bare?.machineId, bare?.name], [null, '']);
  // a change with no view in it, and an event of another kind, teach nothing
  await act(async () => r.events.forEach((fn: (e: Any) => void) => fn({ ev: 'momo.home.changed' })));
  await act(async () => r.events.forEach((fn: (e: Any) => void) => fn({ ev: 'machines.changed' })));
  assert.equal((await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' })).seen.read(), 4);
});

test('the older MoMos the Mac says the owner kept are learned, and nothing else is: a card that is merely not shown, or a change with no list, teaches nothing', async (t) => {
  const r = await rig(t);
  const card = { id: 'older:studio', code: 'older_home', cause: 'two MoMos', fix: { id: 'use-older:studio', label: 'Use' }, since: null };
  const kept = async () => (await openPhoneHomeMemory({ store: r.store, crypto, user: 'u1' })).kept.read();
  r.view.problems = [card];
  await r.show();
  await waitFor(r.known, 'the Mac’s home to be learned');
  assert.deepEqual(await kept(), []);
  const send = (view: object) =>
    act(async () => r.events.forEach((fn: (e: Any) => void) => fn({ ev: 'momo.home.changed', view: { ...r.view, ...view } })));
  // the older machine went to sleep: its card is no longer shown, and the phone must still ask about that MoMo
  await send({ problems: [] });
  await new Promise((res) => setTimeout(res, 80));
  assert.deepEqual(await kept(), [], 'a card that went away is not a decision');
  // a change that carries no problems at all is not "all gone" either
  await act(async () => r.events.forEach((fn: (e: Any) => void) => fn({ ev: 'momo.home.changed', view: { home: r.view.home } })));
  assert.deepEqual(await kept(), []);
  // the Mac says the owner kept one: that is learned, once, and a list that is not a list teaches nothing
  await send({ problems: [], keptOlder: ['studio:h2:1', 7] });
  await waitFor(async () => (await kept()).length === 1, 'the kept one to be learned');
  assert.deepEqual(await kept(), ['studio:h2:1']);
  await send({ problems: [], keptOlder: ['studio:h2:1'] });
  await send({ problems: [], keptOlder: 'nope' });
  assert.deepEqual(await kept(), ['studio:h2:1']);
});

test('a grant a Host refuses is reported, with the cause and a label, and the phone’s own home goes on', async (t) => {
  const warned: string[] = [];
  const warn = mock.method(console, 'warn', (...args: unknown[]) => void warned.push(args.map(String).join(' ')));
  t.after(() => warn.mock.restore());
  const r = await rig(t);
  r.w.overrides.set('studio', (method: string) => {
    if (method === 'host.momoGrant') throw new Error('Unknown request: host.momoGrant');
    return undefined;
  });
  await r.show();
  await waitFor(async () => (await r.invited()) === true, 'the allowed account to be kept');
  await r.show(false);
  await waitFor(() => warned.some((w) => /momo-home .*Unknown request: host\.momoGrant/.test(w)), 'the refusal to be reported');
  await waitFor(async () => {
    await r.out.last.store?.load();
    return r.out.last.store?.get().view?.view.home.machineName === 'Studio';
  }, 'the phone’s own home goes on');
});
