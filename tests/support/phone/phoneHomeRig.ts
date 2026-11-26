// The rig of the phone-composed home's tests: the phone's own home over the world's real in-process Hosts (their handlers), with sealed memory in memory. The phone sources load by variable path so the node typecheck does not pull the phone's React types in.
import { world } from '../momoHomeRealWorld.ts';

const composePath = '../../../mobile/src/momoPhone/phoneHome/compose';
const memoryPath = '../../../mobile/src/momoPhone/phoneHome/memory';
const transportPath = '../../../mobile/src/momoPhone/transport';
export const { createPhoneHome } = await import(composePath);
export const { openPhoneHomeMemory } = await import(memoryPath);
export const { VIEW_METHOD, INTENT_METHOD, CHANGED_EVENT } = await import(transportPath);

const key = new Uint8Array(32).fill(5);
export const crypto = {
  key: async () => key,
  randomBytes: (n: number) => new Uint8Array(n).fill(1),
  seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
    Uint8Array.from([...new TextEncoder().encode(`${aad}|`), ...plain]),
  open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) =>
    new TextDecoder().decode(box).startsWith(`${aad}|`) ? box.slice(aad.length + 1) : null,
};
export const sealedStore = () => {
  const s = { value: null as string | null };
  return { s, read: async () => s.value, write: async (v: string) => void (s.value = v), clear: async () => void (s.value = null) };
};

/** The phone over the world's Hosts: each machine is one session whose requests reach that Host's real handlers. */
export async function phoneOn(
  w: Awaited<ReturnType<typeof world>>,
  store = sealedStore(),
  up: (id: string) => boolean = () => true,
  enrolled?: string[],
  sessionOver: object = {},
) {
  const memory = await openPhoneHomeMemory({ store, crypto, user: 'u1' });
  const sent: { id: string; method: string }[] = [];
  const records = w.machines
    .filter((m: any) => !enrolled || enrolled.includes(m.id))
    .map((m: any) => ({ machineId: m.id, name: m.name, hostKey: m.hostId }));
  const sessions = {
    records: () => records,
    reachable: (id: string) => (up(id) ? true : false),
    agents: () => null,
    ...sessionOver,
    session: async (id: string) => {
      if (!up(id)) throw new Error('Could not reach the machine.');
      return {
        request: async (method: string, params: object = {}) => {
          sent.push({ id, method });
          const over = w.overrides.get(id)?.(method, params);
          return over !== undefined ? over : w.asHost(id, method, params);
        },
      };
    },
  };
  const home = createPhoneHome({
    sessions,
    account: () => 'a1',
    onChange: () => () => undefined,
    memory,
    newId: () => 'phone-turn-1',
    now: () => w.clock.at,
    every: () => () => undefined,
  });
  // the hook starts it in an effect
  home.start();
  return { home, memory, sent, store };
}

/** The codes of the problems the phone's own view carries. */
export const problemsOf = async (p: any) =>
  (((await p.home.channel.request(VIEW_METHOD, {})) as any).view.problems as any[]).map((x) => x.code);
