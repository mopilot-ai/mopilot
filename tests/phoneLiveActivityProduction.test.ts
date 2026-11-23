// The Live Activity controller's production parts with Expo replaced by recorders: the saved switch, the chat counts, the account events and the native module wrapper.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
// imported by a path held in a variable so the type check of the shared tests does not load React Native's globals
const productionPath = '../mobile/src/push/liveActivityProduction.ts';
const nativePath = '../mobile/src/platform/liveActivity.ts';
const production = await import(productionPath);
const { liveActivityNative } = await import(nativePath);

test('the switch is saved in the native defaults and read back; an unreadable or missing one reads as off', async () => {
  let saved: string | null = null;
  const native: any = {
    loadPrefs: async () => saved,
    savePrefs: async (raw: string) => void (saved = raw),
  };
  const store = production.prefsStore(native);
  assert.deepEqual(await store.read(), { enabled: false, titles: false });
  await store.write({ enabled: true, titles: false });
  assert.deepEqual(await store.read(), { enabled: true, titles: false });
  saved = '{bad';
  assert.deepEqual(await store.read(), { enabled: false, titles: false });
  const broken = production.prefsStore({
    ...native,
    loadPrefs: async () => {
      throw new Error('defaults unavailable');
    },
  });
  assert.deepEqual(await broken.read(), { enabled: false, titles: false });
  // without the module there is nothing to keep, and nothing breaks
  const none = production.prefsStore(null);
  assert.deepEqual(await none.read(), { enabled: false, titles: false });
  await none.write({ enabled: true, titles: true });
});

test('chats count by state among the recent ones, and nothing is counted while no computer is connected', async () => {
  const asked: unknown[] = [];
  const runtime = (phase: string) => ({
    snapshot: () => ({ phase }) as any,
    request: async (method: string, params: unknown) => {
      asked.push([method, params]);
      return {
        chats: [
          { id: 'a', state: 'waiting' },
          { id: 'b', state: 'waiting' },
          { id: 'c', state: 'running' },
          { id: 'd', state: 'idle' },
          { id: 'e' },
        ],
      };
    },
  });
  assert.equal(await production.countChats(runtime('offline')), null);
  assert.deepEqual(asked, []);
  assert.deepEqual(await production.countChats(runtime('online')), { needs: 2, running: 1 });
  assert.deepEqual(asked, [['chats.recent', { limit: 50 }]]);
  await assert.rejects(production.countChats({ ...runtime('online'), request: async () => ({ nope: 1 }) }), /Could not read chats/);
});

test('account events fire when the signed-in account or whether a computer is connected changes, not on every snapshot', () => {
  let snapshot: any = { user: null, phase: 'signedOut' };
  const listeners = new Set<() => void>();
  const runtime = { snapshot: () => snapshot, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
  const seen: number[] = [];
  const off = production.accountEvents(runtime)(() => seen.push(seen.length));
  const emit = (next: any) => {
    snapshot = next;
    listeners.forEach((l) => l());
  };
  emit({ user: null, phase: 'signedOut', error: 'x' });
  assert.equal(seen.length, 0);
  emit({ user: { id: 'u1' }, phase: 'ready' });
  assert.equal(seen.length, 1);
  emit({ user: { id: 'u1' }, phase: 'ready', pairs: [] });
  assert.equal(seen.length, 1);
  emit({ user: { id: 'u1' }, phase: 'online' });
  assert.equal(seen.length, 2);
  emit({ user: { id: 'u2' }, phase: 'online' });
  assert.equal(seen.length, 3);
  off();
  emit({ user: null, phase: 'signedOut' });
  assert.equal(seen.length, 3);
});

test('the production controller is built from the runtime and the native module', async () => {
  const calls: string[] = [];
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u' }, phase: 'online' }),
    subscribe: () => () => {},
    request: async () => ({ chats: [] }),
    activityRegister: async (token: string) => void calls.push(`register:${token}`),
    activityUnregister: async () => void calls.push('unregister'),
  };
  const controller = production.createProductionLiveActivity(runtime);
  assert.equal(controller.ui().status, 'unsupported');
  await controller.start();
  controller.stop();
  assert.deepEqual(calls, []);
});

test('the native wrapper is null without the module, and passes calls and events through with bad events dropped', async () => {
  assert.equal(liveActivityNative(null), null);
  const calls: string[] = [];
  const handlers: Record<string, (e: any) => void> = {};
  let removed = 0;
  const raw: any = {
    isEnabled: async () => true,
    start: async () => true,
    update: async () => void calls.push('update'),
    stripTitles: async () => void calls.push('strip'),
    end: async () => void calls.push('end'),
    token: async () => 'tok',
    setTitlesSwitch: async (on: boolean) => (calls.push(`switch:${on}`), true),
    loadPrefs: async () => '{"enabled":true}',
    savePrefs: async (raw: string) => void calls.push(`save:${raw}`),
    addListener: (name: string, l: (e: any) => void) => {
      handlers[name] = l;
      return { remove: () => void removed++ };
    },
  };
  const native = liveActivityNative(raw)!;
  assert.equal(await native.isEnabled(), true);
  assert.equal(await native.start({ needs: 0, running: 1, kind: 'running', since: 1, rows: [] }), true);
  await native.update({ needs: 0, running: 1, kind: 'running', since: 1, rows: [] });
  await native.stripTitles();
  await native.end();
  assert.equal(await native.token(), 'tok');
  assert.equal(await native.setTitlesSwitch(true), true);
  assert.equal(await native.loadPrefs(), '{"enabled":true}');
  await native.savePrefs('{}');
  assert.deepEqual(calls, ['update', 'strip', 'end', 'switch:true', 'save:{}']);
  const tokens: string[] = [];
  const offToken = native.onToken((t) => tokens.push(t));
  handlers.onToken({ token: 'aa' });
  handlers.onToken({ token: '' });
  handlers.onToken({});
  handlers.onToken(undefined);
  assert.deepEqual(tokens, ['aa']);
  const ended: boolean[] = [];
  const offEnded = native.onEnded((byPerson) => ended.push(byPerson));
  handlers.onEnded({ dismissed: true });
  handlers.onEnded({ dismissed: false });
  handlers.onEnded({});
  handlers.onEnded(undefined);
  assert.deepEqual(ended, [true, false, false, false]);
  offToken();
  offEnded();
  assert.equal(removed, 2);
  // the default lookup reads the module Expo registers on its global, and finds none where it is not linked
  const g = globalThis as any;
  assert.equal(liveActivityNative(), null);
  g.expo = { modules: { MoPilotLiveActivity: raw } };
  assert.ok(liveActivityNative());
  g.expo = {};
  assert.equal(liveActivityNative(), null);
  delete g.expo;
});

test('the production controller drives the native module with the runtime: counts from its chats, the token to its relay calls, signed-in from its snapshot', async () => {
  const calls: string[] = [];
  const events: Record<string, (e: any) => void> = {};
  (globalThis as any).expo = {
    modules: {
      MoPilotLiveActivity: {
        isEnabled: async () => true,
        start: async (state: any) => (calls.push(`start:${state.needs}/${state.running}`), true),
        update: async () => {},
        stripTitles: async () => {},
        end: async () => void calls.push('end'),
        token: async () => null,
        setTitlesSwitch: async (on: boolean) => (calls.push(`switch:${on}`), true),
        loadPrefs: async () => stored,
        savePrefs: async (raw: string) => void (stored = raw),
        addListener: (name: string, l: (e: any) => void) => ((events[name] = l), { remove() {} }),
      },
    },
  };
  let stored: string | null = null;
  let user: { id: string } | null = { id: 'u' };
  const runtime: any = {
    snapshot: () => ({ user, phase: 'online' }),
    subscribe: () => () => {},
    request: async () => ({
      chats: [
        { id: 'a', state: 'waiting' },
        { id: 'b', state: 'running' },
      ],
    }),
    activityRegister: async (token: string) => void calls.push(`register:${token}`),
    activityUnregister: async () => void calls.push('unregister'),
  };
  const controller = production.createProductionLiveActivity(runtime);
  await controller.start();
  await controller.setEnabled(true);
  assert.deepEqual(
    calls.filter((c) => c.startsWith('start')),
    ['start:1/1'],
  );
  assert.deepEqual(JSON.parse(stored!), { enabled: true, titles: false });
  events.onToken({ token: 'abcd' });
  await controller.refresh();
  assert.ok(calls.includes('register:abcd'));
  user = null;
  await controller.forget();
  assert.ok(calls.includes('unregister'));
  assert.equal(controller.ui().status, 'off');
  controller.stop();
  delete (globalThis as any).expo;
});
