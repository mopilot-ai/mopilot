// The machine page on the real app with the phone's own path and a Mac that answers (or not): the rig of the machine-page tests.
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './component-kit';
import { scripted } from './m3';
import { createNodePrimitives } from '../../../shared/remote/nodePrimitives.mjs';
import { createPhoneHosts } from '../../../shared/remote/phoneHosts.mjs';
import { toBase64 } from '../../../shared/remote/envelope.mjs';
import { createCardStore } from '../../../mobile/src/remote/hostCards';

const appPath = '../../../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);
export const prim = createNodePrimitives();
export const HOST_KEY = 'a'.repeat(32);

export const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', email: 'dana@example.com' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};
export const away = { ...online, phase: 'offline', selectedPair: null };
export const local = { id: 'local', name: 'MacBook Pro', status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] };
export const studio = { id: 'h1', name: 'Studio', status: 'online', line: 'Online · direct', tone: 'ok', keepRunning: null, agents: [] };
export const CARD = {
  chatId: 'c1',
  epoch: 1,
  requestId: 'r1',
  cardKind: 'permission',
  summary: { tool: 'execute', line: 'git push --force-with-lease' },
  options: [
    { optionId: 'a', name: 'Allow', kind: 'allow' },
    { optionId: 'd', name: 'Deny', kind: 'deny' },
  ],
  at: 1,
};

/** A direct path with an in-memory vault, a lane that cannot reach any Host, and a Mac that introduces (or refuses). */
export function path(o: { enrolled?: boolean; macFails?: any } = {}) {
  let stored: Record<string, any> = o.enrolled
    ? {
        h1: {
          machineId: 'h1',
          hostKey: HOST_KEY,
          name: 'Studio',
          features: [],
          hostId: 'h_1',
          pairId: 'p_pair00001',
          relayUrl: 'wss://r/v1/ws',
          root: toBase64(prim.randomBytes(32)),
        },
      }
    : {};
  const cards = createCardStore();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((f) => f());
  cards.subscribe(changed);
  const enrolls: any[] = [];
  const phones = createPhoneHosts({
    prim,
    vault: {
      getHosts: async () => stored,
      putHost: async (id: string, r: object) => void (stored = { ...stored, [id]: r }),
      removeHost: async (id: string) => {
        const { [id]: _x, ...rest } = stored;
        stored = rest;
        return true;
      },
      getIdentity: async () => ({ ed: prim.edKeypair() }),
    } as any,
    // the relay takes a credential but no Host is on it: a session opened here ends at once
    lane: () => ({
      connect: async () => undefined,
      request: async () => undefined,
      send: async () => undefined,
      close: () => undefined,
      connected: () => false,
    }),
    macEnroll: async (id: string, p: any) => {
      enrolls.push([id, p]);
      if (o.macFails) throw o.macFails;
      return {
        hostPub: toBase64(prim.randomBytes(32)),
        hostEphPub: toBase64(prim.randomBytes(32)),
        hostKey: HOST_KEY,
        name: 'Studio',
        features: [],
      };
    },
    macForget: async () => undefined,
    cards,
    relayUrl: 'wss://r/v1/ws',
    deviceName: () => 'Pocket iPhone',
    changed,
  });
  return {
    direct: { phones, cards, subscribe: (f: () => void) => (listeners.add(f), () => void listeners.delete(f)) },
    enrolls,
    stored: () => stored,
  };
}

export const mounted: any[] = [];
export async function open(o: { direct: any; snap?: any; machines?: unknown | null; home?: boolean; chats?: unknown[] }) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const away = o.machines === null;
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: o.chats ?? [] }
        : m === 'machine.hello'
          ? { capabilities: { machines: !away } }
          : m === 'machines.list'
            ? { machines: o.machines }
            : undefined,
    o.snap ?? online,
  );
  s.runtime.start = async () => {};
  s.runtime.direct = o.direct;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  if (o.home) return host;
  await click('Settings');
  await flush();
  return host;
}
export async function tapRow(label: string | RegExp) {
  const sheet = document.querySelector('[data-screen="settings"]')!;
  const row = [...sheet.querySelectorAll('button')].find((b) => {
    const l = b.getAttribute('aria-label') ?? '';
    return typeof label === 'string' ? l === label : label.test(l);
  }) as HTMLElement;
  assert.ok(row, String(label));
  await act(async () => row.click());
  await flush();
}
