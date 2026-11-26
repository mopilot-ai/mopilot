// What the page cache tests share (#5379): a sealed store in memory, a Thread over a scripted Mac, and ways to read what it drew.
import { act, createElement, createRoot, flush } from './component-kit';
import { withOutbox } from './outbox-kit';
import { fakeDraft } from './drafts';
// the paths are variables, so the root typecheck does not take the whole phone app in with the tests
const threadPath = '../../../mobile/src/screens/Thread';
const cachePath = '../../../mobile/src/remote/pageCache';
export const { Thread } = await import(threadPath);
const { createPageCache, withPages } = await import(cachePath);

export const id = (n: number) => `r${String(n).padStart(5, '0')}`;
export const row = (n: number, text = `text ${id(n)}`) => ({ id: id(n), role: n % 2 ? 'assistant' : 'user', text });
export const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i));
export const KEY = JSON.stringify(['u', 'p', 'c']);

/** A sealed store in memory, with a gate to hold a read back and a way to make the keychain not answer. */
export function memory(paint: object[] = []) {
  const kept = new Map<string, string>();
  const order: string[] = [];
  const gate: { read?: Promise<void> } = {};
  const keychain = { fails: false };
  const touch = (k: string) => (order.includes(k) && order.splice(order.indexOf(k), 1), order.push(k));
  const store = {
    read: async (k: string) => (gate.read && (await gate.read), kept.get(k) ?? null),
    write: async (k: string, v: string) => (kept.set(k, v), touch(k), undefined),
    remove: async (k: string) => (kept.delete(k), order.includes(k) && order.splice(order.indexOf(k), 1), undefined),
    keys: async () => [...order],
    clear: async () => (kept.clear(), (order.length = 0), undefined),
  };
  const crypto = {
    key: async () => {
      if (keychain.fails) throw new Error('keychain did not answer');
      return new Uint8Array(32);
    },
    randomBytes: (n: number) => new Uint8Array(n).fill(3),
    seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
      new TextEncoder().encode(`${aad}\u0000${new TextDecoder().decode(plain)}`),
    open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
      const text = new TextDecoder().decode(box);
      return text.startsWith(`${aad}\u0000`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
    },
  };
  const pages = createPageCache({ store, crypto });
  const saved = () => kept.get(KEY);
  // the rows cache the first paint reads: nothing saved, so the cached rows are not what the test is about
  const base: any = {
    load: async () => paint,
    // as the real cache answers since the chip is kept with the rows (#5687): the rows, and no chip
    loadChat: async () => ({ rows: paint, changes: null }),
    save: async () => undefined,
    remove: async () => undefined,
    prune: async () => undefined,
    clear: async () => undefined,
  };
  return { pages, gate, keychain, saved, kept, rowCache: withPages(base, pages) };
}

export function rig(top: number, opts: { follow?: () => unknown } = {}) {
  const calls: [string, any][] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'chat.follow')
        return opts.follow
          ? opts.follow()
          : { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: rows(top, 30) };
      if (method === 'chat.read') return { chatId: 'c', rows: [], more: false };
      return {};
    },
  };
  withOutbox(runtime);
  return { runtime, calls, reads: () => calls.filter(([m]) => m === 'chat.read').length };
}
export const mounted: any[] = [];
export async function mount(runtime: any, rowCache: any, extra: object = {}) {
  for (const old of mounted.splice(0)) await act(async () => old.unmount());
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  await act(async () =>
    root.render(
      createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(''), historyKey: KEY, rowCache, ...extra }),
    ),
  );
  await flush();
  return { host, root };
}
export const at = (host: HTMLElement, n: number) =>
  [...host.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === `text ${id(n)}`);
export const shown = (host: HTMLElement) => (host.textContent!.match(/text r\d{5}/g) ?? []).length;
export const wait = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** The Mac says it pages from held rows, names its history `epoch`, and answers chat.read with what `read` makes of the request. */
export function macWith(epoch: string | undefined, read: (params: any) => unknown, extra: object[] = []) {
  const reads: any[] = [];
  const { runtime } = rig(300, {
    follow: () => ({
      rev: 1,
      feedSeq: 0,
      session: { turn: 'idle', cards: [] },
      itemsShape: 'rows',
      items: [...rows(300, 30), ...extra],
      ...(epoch ? { historyEpoch: epoch } : {}),
    }),
  });
  const request = runtime.request;
  runtime.request = async (method: string, params: any) => {
    if (method === 'machine.hello') return { capabilities: { methods: ['chat.read'], olderRowsHeld: true } };
    if (method === 'chat.read') {
      reads.push(params);
      return read(params);
    }
    return request(method, params);
  };
  return { runtime, reads };
}
