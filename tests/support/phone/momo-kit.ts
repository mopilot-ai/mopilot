// A scripted runtime and cache for MoMo tab tests: requests answered by method, events and snapshot changes pushed by the test.
import { fakeDraft } from './drafts';
type MomoCache = any;

export type Handler = (params: any) => unknown | Promise<unknown>;
export function momoRuntime(handlers: Record<string, Handler>, first: Record<string, unknown> = {}) {
  let snap: any = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p', macId: 'm' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    pairCleanup: false,
    error: null,
    ...first,
  };
  const listeners = new Set<() => void>();
  const events = new Set<(e: any) => void>();
  const calls: [string, any][] = [];
  const runtime: any = {
    snapshot: () => snap,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    signIn: async () => {},
    signOut: async () => {},
    onEvent: (f: any) => (events.add(f), () => events.delete(f)),
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      const handler = handlers[method];
      if (!handler) throw new Error(`no handler ${method}`);
      return handler(params);
    },
  };
  // the outbox, as the real runtime keeps it: a sent message is listed at once and leaves when the Mac took it; a refusal keeps it, failed
  let sentIds = 0;
  const queue = (items: any[]) => {
    snap = { ...snap, outbox: items };
    for (const f of listeners) f();
  };
  const go = (id: string, text: string) =>
    runtime.request('momo.chat.send', { id, text, followUp: 'queue' }).then(
      () => queue(snap.outbox.filter((i: any) => i.id !== id)),
      (e: Error) => queue(snap.outbox.map((i: any) => (i.id === id ? { ...i, status: 'failed', error: e.message } : i))),
    );
  runtime.send = (chatId: string, text: string, _files: string[], _skills: string[], momo?: true) => {
    const id = `send-${sentIds++}`;
    queue([
      ...snap.outbox,
      {
        id,
        pairId: snap.selectedPair,
        chatId,
        text,
        attachments: [],
        at: Date.now(),
        status: 'sending',
        error: null,
        ...(momo ? { momo } : {}),
      },
    ]);
    go(id, text);
    return id;
  };
  runtime.cancelSend = (id: string) => (queue(snap.outbox.filter((i: any) => i.id !== id)), true);
  runtime.retrySend = (id: string) => {
    const item = snap.outbox.find((i: any) => i.id === id);
    if (!item) return false;
    queue(snap.outbox.map((i: any) => (i.id === id ? { ...i, status: 'sending', error: null } : i)));
    void go(id, item.text);
    return true;
  };
  runtime.editSend = () => true;
  return {
    runtime,
    calls,
    set(patch: any) {
      snap = { ...snap, ...patch };
      for (const f of listeners) f();
    },
    emit: (event: any) => {
      for (const f of events) f(event);
    },
    count: (method: string) => calls.filter(([m]) => m === method).length,
  };
}

export const hello = (momo: boolean, momoBrainSet?: boolean) => ({
  v: 1,
  capabilities: { momo, methods: [], ...(momoBrainSet === undefined ? {} : { momoBrainSet }) },
});
export const snapshotOf = (cards: any[] = [], items: any[] = [], chatId: any = 'main') => ({
  chatId,
  rev: 1,
  feedSeq: 0,
  session: { turn: 'idle', cards },
  itemsShape: 'items',
  history: [],
  items,
});

/** An in-memory cache whose "encryption" is observable: what it stores is not the plaintext. */
export function fakeCache(): MomoCache & { raw: () => string | null } {
  let raw: string | null = null;
  const xor = (bytes: Uint8Array) => bytes.map((b) => b ^ 0x5a);
  const crypto = {
    key: async () => new Uint8Array(32),
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
    seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
      xor(new Uint8Array([...new TextEncoder().encode(aad + '|'), ...plain])),
    open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
      const text = new TextDecoder().decode(xor(box));
      return text.startsWith(aad + '|') ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
    },
  };
  const { createMomoCache } = cacheModule;
  const cache = createMomoCache({
    store: {
      read: async () => raw,
      write: async (v) => {
        raw = v;
      },
      clear: async () => {
        raw = null;
      },
    },
    crypto,
  });
  return Object.assign(cache, { raw: () => raw });
}
const cacheModulePath = '../../../mobile/src/momo/cache';
const cacheModule = await import(cacheModulePath);

const reactPath = 'react';
const { createElement, useEffect, useState } = await import(reactPath);
const kitPath = './component-kit';
const { act, createRoot, flush } = await import(kitPath);
const momoPath = '../../../mobile/src/screens/Momo';
const { Momo } = await import(momoPath);

/** Mounts the MoMo tab on a scripted runtime; `back` calls are counted. */
export async function mountMomo(m: ReturnType<typeof momoRuntime>, cache?: Promise<MomoCache | null>, first: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const seen = { back: 0, drafts: [] as string[] };
  // more props (a push's focus), changed later by setProps as the app would
  let setExtra: (extra: Record<string, unknown>) => void = () => {};
  function Harness() {
    const [extra, setExtraState] = useState(first);
    setExtra = setExtraState;
    const [state, setState] = useState(m.runtime.snapshot());
    const [drafts] = useState(() => fakeDraft('', { set: (text: string) => seen.drafts.push(text) }));
    useEffect(() => m.runtime.subscribe(() => setState(m.runtime.snapshot())), []);
    return createElement(Momo, {
      runtime: m.runtime,
      state,
      cache,
      back: () => void seen.back++,
      drafts,
      ...extra,
    });
  }
  await act(async () => root.render(createElement(Harness)));
  await flush();
  return {
    host,
    seen,
    text: () => host.textContent!,
    setProps: async (extra: Record<string, unknown>) => {
      await act(async () => setExtra(extra));
      await flush();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Presses a button's handler as a queued press would, even though a render has since disabled the button. */
export async function pressQueued(text: string) {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))!;
  await act(async () => (el as any)[key].onClick());
}

/** Opens one of MoMo's parts: Memories and Brain are pages of MoMo's page (behind MoMo's name), Routines is that page's Scheduled list; the chat and its waiting cards are the screen itself. */
export async function openPart(name: 'Memory' | 'Routines' | 'Brain' | 'Chat' | 'Needs you') {
  if (name === 'Chat' || name === 'Needs you') return;
  const { click } = await import(kitPath);
  // a page already open is closed first, as a person taps ✕ before choosing another part
  if (document.querySelector('button[aria-label="Dismiss"]')) await click('Dismiss');
  const title = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').endsWith('MoMo’s page'))!;
  await click(title.getAttribute('aria-label')!);
  if (name === 'Memory') await click('Memories');
  if (name === 'Brain') await click('Brain');
}
