// The rig of the pairing-by-code tests (R2b of #5576): the relay's own server in this process, the controlled Mac's responder driven over its HTTP, and a controlling client whose lane, enrollments and machine list are recorded.
import { after } from 'node:test';
import crypto from 'node:crypto';
import { loadConfig } from '../../relay/src/config.mjs';
import { createVerifier } from '../../relay/src/auth.mjs';
import { createRelay } from '../../relay/src/server.mjs';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { fromBase64, toBase64 } from '../../shared/remote/envelope.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { createResponder, createRunBudget, formatCode, newSecret } from '../../shared/host/codePair.mjs';
import { makeDb, makeKeys } from './relayKit.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCodePairClient } = require('../../electron/host/codePairClient.cjs');

export const prim = createNodePrimitives();
export const c = createCrypto(prim);
export const keys = await makeKeys();
const { db } = await makeDb();
const closing: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closing) await close();
});

export async function serve(env: Record<string, string> = { RENDEZVOUS: '1' }) {
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', ...env });
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  closing.push(() => relay.close());
  const post = async (path: string, json: object, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/rendezvous/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { port, wsUrl: `ws://127.0.0.1:${port}/v1/ws`, post };
}

export const deviceOf = (name: string) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { pub, name, sign: (m: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(m), privateKey)) };
};

type Mode = 'accept' | 'deny' | 'silent' | 'nohalf';
/** The controlled Mac: makes the offer, then answers whatever the controller sends (m1 -> m2, m3 -> m4) the way `mode` says. */
export async function controlled(r: Awaited<ReturnType<typeof serve>>, mode: Mode = 'accept') {
  const token = await keys.sign('u1', 'dev1');
  const offer = (await r.post('offer', {}, token)).json;
  const secret = newSecret((n) => prim.randomBytes(n));
  const seen: any = { relay: null, safety: '', root: null as Uint8Array | null, stopped: false };
  let responder: any = null;
  let after = 0;
  let tick: any;
  const step = async () => {
    const read = (await r.post(`${offer.id}/read`, { ticket: offer.ticket, after })).json;
    if (!read?.messages) return;
    if (read.claims >= 1 && !responder)
      responder = createResponder({
        crypto: c,
        secret,
        hint: offer.hint,
        rendezvousId: offer.id,
        claims: read.claims,
        device: deviceOf('Studio'),
        budget: createRunBudget(),
      });
    for (const m of read.messages) {
      after = m.n;
      const send = (box: string) => r.post(`${offer.id}/send`, { ticket: offer.ticket, claims: read.claims, box });
      if (m.n === 1) await send(responder.receive(m.box));
      else {
        const got = responder.receive3(m.box);
        seen.relay = got.carry;
        seen.safety = got.safety;
        seen.peerName = got.peerName;
        if (mode === 'silent') continue;
        // the Host's half of the relay pair, as host/src/relayEnroll.mjs makes it, and the root both ends derive from it
        const sk = prim.randomBytes(32);
        const ephSk = prim.randomBytes(32);
        const half = { hostPub: toBase64(prim.x25519Base(sk)), hostEphPub: toBase64(prim.x25519Base(ephSk)) };
        const have = got.carry as any;
        if (mode === 'accept')
          seen.root = c.deriveRoot(sk, fromBase64(have.appPub), ephSk, fromBase64(have.appEphPub), 'app', have.hostId, have.pairId);
        const done = responder.answer(mode !== 'deny', mode === 'accept' ? half : undefined);
        await send(done.message);
      }
    }
  };
  // the relay limits how often an offer is read: this side asks no faster than a person's Mac would
  tick = setInterval(() => void step().catch(() => undefined), 25);
  closing.push(async () => clearInterval(tick));
  return { code: formatCode(offer.hint, secret), hint: offer.hint, secret, seen, stop: () => clearInterval(tick) };
}

/** The budgets' file in memory: nothing at first, as before any run. */
export const fakeStore = (value?: unknown) => {
  const store = {
    value,
    aside: 0,
    read: () => store.value,
    write: (v: unknown) => void (store.value = v),
    setAside: () => void (store.aside++, (store.value = undefined)),
  };
  return store;
};

export function rig(r: { wsUrl: string }, over: Record<string, any> = {}) {
  const log: string[] = [];
  const store = fakeStore();
  const machines: any[] = [];
  const adopted: any[] = [];
  const lane = {
    whenOpen: async () => void log.push('open'),
    intend: (h: string) => void log.push(`intend:${h}`),
    register: async (x: any) => void log.push(`register:${x.host}`),
    settle: (h: string) => void log.push(`settle:${h}`),
    revoke: async (h: string) => void log.push(`revoke:${h}`),
  };
  const paths = {
    adopt: (d: string, e: any, o: any) => void adopted.push({ d, e, o }),
    forget: async (d: string) => void log.push(`forget:${d}`),
  };
  const client = createCodePairClient({
    crypto: c,
    enabled: () => true,
    relayUrl: () => r.wsUrl,
    device: () => deviceOf('Laptop'),
    lane,
    paths,
    addMachine: (m: any) => void machines.push(m),
    store,
    timing: { answerMs: 250, replyMs: 400, pollMs: 5 },
    ...over,
  });
  return { client, log, store, machines, adopted, lane, paths };
}
export const hostIdOf = (log: string[]) => log.find((l) => l.startsWith('intend:'))?.slice(7) ?? '';
