// A fake Host on the phone's real session, and the phone's Host sessions over it (shared/remote/phoneHosts.mjs): shared by the tests of the cards and of the agents.
import { createNodePrimitives } from '../../../shared/remote/nodePrimitives.mjs';
import { createRelaySession } from '../../../shared/host/relaySession.mjs';
import { FEATURES, PROTOCOL } from '../../../shared/host/schema.mjs';
import { createPhoneHosts } from '../../../shared/remote/phoneHosts.mjs';
import { CARD_FEATURES } from '../../../shared/remote/phoneHost.mjs';
import { toBase64, fromBase64 } from '../../../shared/remote/envelope.mjs';
import { createCrypto } from '../../../shared/remote/crypto.mjs';
import { createCardStore } from '../../../mobile/src/remote/hostCards';
import { waitFor } from '../waitFor.ts';

export const prim = createNodePrimitives();
const enc = new TextEncoder();
const dec = new TextDecoder();
export const HOST_KEY = 'a'.repeat(32);
export const CARD = {
  chatId: 'c1',
  epoch: 2,
  requestId: 'r1',
  cardKind: 'permission',
  summary: { tool: 'execute', line: 'git push' },
  options: [
    { optionId: 'a', name: 'Allow', kind: 'allow' },
    { optionId: 'd', name: 'Deny', kind: 'deny' },
  ],
  at: 1,
};

export function rig(
  o: {
    features?: string[];
    answer?: (m: any, n: number) => any;
    pending?: () => any;
    status?: () => any;
    gate?: Promise<void>;
    laneFails?: boolean;
    revokeFails?: boolean;
    macForgetFails?: boolean;
    macEnrollFails?: boolean;
    timers?: any;
  } = {},
) {
  const root = prim.randomBytes(32);
  const identity = { ed: prim.edKeypair() };
  const toHost: any[] = [];
  const toApp: any[] = [];
  const seen: any[] = [];
  let answers = 0;
  const events: any[] = [];
  let hostStream: any = null;
  const host = createRelaySession({
    prim,
    root,
    pair: 'p_pair00001',
    role: 'host',
    send: (f) => (toApp.push(f), true),
    onStream: (s) => {
      hostStream = s;
      let buf = '';
      s.onData = (b: Uint8Array) => {
        buf += dec.decode(b);
        s.consumed(b.length);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          seen.push(m);
          let reply: any = { result: {} };
          if (m.method === 'host.challenge') reply = { result: { nonce: 'n', hostId: HOST_KEY } };
          if (m.method === 'host.hello')
            reply = { result: { protocol: { ...PROTOCOL }, features: o.features ?? [...FEATURES, ...CARD_FEATURES] } };
          if (m.method === 'host.pending') reply = o.pending ? o.pending() : { result: { cards: [CARD], attention: [] } };
          if (m.method === 'host.status') reply = o.status ? o.status() : { result: {} };
          if (m.method === 'chat.answer') reply = o.answer ? o.answer(m, ++answers) : { result: { ok: true } };
          if (reply !== 'silent') s.write(enc.encode(`${JSON.stringify({ id: m.id, ...reply })}\n`));
        }
      };
    },
  });
  const record = {
    machineId: 'ssh:box',
    hostKey: HOST_KEY,
    name: 'build-box',
    features: [],
    hostId: 'h_x',
    pairId: 'p_pair00001',
    relayUrl: 'wss://r/v1/ws',
    root: toBase64(root),
  };
  let stored: Record<string, any> = { 'ssh:box': record };
  const lanes: any[] = [];
  const requests: any[] = [];
  let connected = false;
  /** A Host that lost its relay enrollment: it is not on the relay, so the phone's own session to it cannot open. */
  const gone = { value: false };
  const cards = createCardStore();
  let phones: ReturnType<typeof createPhoneHosts>;
  /** The machines whose session ended, as the chats followed through them are told. */
  const ended: string[] = [];
  const changes: number[] = [];
  const lane = () => {
    const l = {
      connect: async () => {
        if (o.laneFails) throw new Error('no relay');
        connected = true;
      },
      request: async (m: any) => {
        if (o.revokeFails && m.t === 'host.revoke') throw new Error('relay down');
        requests.push(m);
      },
      send: async (f: any) => void toHost.push(f),
      close: () => void (connected = false),
      // a Host that is not on the relay cannot be opened a session to: the phone's frames find no peer, as an unconnected lane does
      connected: () => connected && !gone.value,
    };
    lanes.push(l);
    return l;
  };
  const macCalls: any[] = [];
  phones = createPhoneHosts({
    prim,
    vault: {
      getHosts: async () => stored,
      putHost: async (id: string, r: object) => void (stored = { ...stored, [id]: r }),
      removeHost: async (id: string) => {
        const had = id in stored;
        const { [id]: _x, ...rest } = stored;
        stored = rest;
        return had;
      },
      getIdentity: async () => identity,
    } as any,
    lane,
    macEnroll: async (id: string, p: any) => {
      macCalls.push(['enroll', id]);
      if (o.macEnrollFails) throw new Error('mac away');
      await o.gate;
      const c = createCrypto(prim);
      const sk = prim.randomBytes(32);
      const ephSk = prim.randomBytes(32);
      c.deriveRoot(sk, fromBase64(p.appPub), ephSk, fromBase64(p.appEphPub), 'app', p.relay.hostId, p.relay.pairId);
      return {
        hostPub: toBase64(prim.x25519Base(sk)),
        hostEphPub: toBase64(prim.x25519Base(ephSk)),
        hostKey: HOST_KEY,
        name: 'build-box',
        features: [],
      };
    },
    macForget: async (id: string) => {
      if (o.macForgetFails) throw new Error('mac away');
      macCalls.push(['forget', id]);
    },
    cards,
    relayUrl: 'wss://r/v1/ws',
    deviceName: () => 'Pocket iPhone',
    changed: () => void changes.push(1),
    onEvent: (machineId: string, line: any) => void events.push([machineId, line]),
    onSessionEnd: (machineId: string) => void ended.push(machineId),
    ...(o.timers ? { timers: o.timers } : {}),
  });
  const pump = () => {
    while (toHost.length || toApp.length) {
      while (toHost.length) host.handleFrame(toHost.shift());
      while (toApp.length) phones.handleFrame(toApp.shift());
    }
  };
  const settle = async <T>(p: Promise<T>) => {
    let done = false;
    const g = p.finally(() => (done = true));
    g.catch(() => undefined);
    await waitFor(() => (pump(), done), 'the exchange', { timeoutMs: 5000 });
    return g;
  };
  return {
    ended,
    reachableOf: (id: string) => phones.reachable(id),
    gone,
    events,
    hostWrite: (line: object) => hostStream.write(enc.encode(`${JSON.stringify(line)}\n`)),
    phones,
    cards,
    seen,
    settle,
    requests,
    macCalls,
    changes,
    stored: () => stored,
    host,
    connected: () => connected,
    pump,
  };
}
