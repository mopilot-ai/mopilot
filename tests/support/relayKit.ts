// Shared rig for the relay's unit tests: an in-process Postgres (PGlite) with the relay's schema, ES256 account keys that
// sign tokens the way web/lib/desktop.ts does, a fake socket and a fake clock.
import { generateKeyPair, SignJWT, exportSPKI } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../relay/src/schema.mjs';
import { Store } from '../../relay/src/store.mjs';
import { PushService } from '../../relay/src/push.mjs';
import { Hub } from '../../relay/src/hub.mjs';
import { DurableStore } from '../../relay/src/durableStore.mjs';
import { createVerifier } from '../../relay/src/auth.mjs';
import { laneOf } from '../../relay/src/hosts.mjs';

export const ISSUER = 'https://code.mopilot.ai';

export async function makeKeys() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicPem = await exportSPKI(publicKey);
  const sign = (
    userId: string,
    deviceId: string,
    o: { kind?: 'phone' | 'desktop'; aud?: string; iss?: string; ttlS?: number; claims?: object } = {},
  ) =>
    new SignJWT({ did: deviceId, ...o.claims, ...(o.kind === 'phone' && { dk: 'phone' }) })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? 'relay')
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (o.ttlS ?? 900))
      .sign(privateKey);
  return { privateKey, publicKey, publicPem, sign };
}

export async function makeDb() {
  const db: any = new PGlite();
  await migrate(db as any);
  const tables = [
    'relay_pairs',
    'relay_mailbox',
    'relay_drops',
    'relay_push_tokens',
    'relay_activity_tokens',
    'relay_revoked_devices',
    'relay_disabled_accounts',
    'relay_hosts',
  ];
  return { db, reset: () => db.exec(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`) };
}

export const AUTH = { publicKeyPem: '', jwksUrl: '', issuer: ISSUER, audience: 'relay', revokeAudience: 'relay-revoke' };
export const MAILBOX = { ttlMs: 7 * 24 * 3600_000, maxFrames: 100, maxBytes: 1024 * 1024 };

export function makeClock(start = Date.UTC(2030, 0, 1)) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

export class FakeSocket {
  sent: any[] = [];
  closedWith: { code: number; reason: string } | null = null;
  pings = 0;
  terminated = false;
  failSend = false;
  throwSend = false;
  throwPing = false;
  throwClose = false;
  onSend: ((m: any) => void) | null = null;
  send(text: string, cb: (err?: Error | null) => void) {
    if (this.throwSend) throw new Error('boom');
    if (!this.failSend) this.sent.push(JSON.parse(text));
    if (this.onSend) this.onSend(JSON.parse(text));
    cb(this.failSend ? new Error('closed') : null);
  }
  close(code: number, reason: string) {
    if (this.throwClose) throw new Error('boom');
    this.closedWith = { code, reason };
  }
  ping() {
    if (this.throwPing) throw new Error('boom');
    this.pings++;
  }
  terminate() {
    this.terminated = true;
  }
  of(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
  events(ev: string) {
    return this.sent.filter((m) => m.t === 'event' && m.ev === ev);
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

export const idle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A hub on a fake clock and a recording push sender, over the shared database. */
export function makeHub(
  db: any,
  o: {
    clock?: ReturnType<typeof makeClock>;
    send?: any;
    mailbox?: typeof MAILBOX;
    durable?: boolean;
    limits?: object;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const clock = o.clock ?? makeClock();
  const store = new Store(db);
  const pushed: any[] = [];
  const send = o.send === undefined ? async (m: any) => (pushed.push(m), { ok: true }) : o.send;
  const push = new PushService({ store, send, now: clock.now });
  const identities = new Map<string, any>();
  const verifier = { verify: async (token: string) => identities.get(token) ?? null };
  const logs: any[] = [];
  const hub = new Hub({
    store,
    push,
    verifier,
    config: { mailbox: o.mailbox ?? MAILBOX, pairJoinMs: 180_000, limits: o.limits },
    now: clock.now,
    sleep: o.sleep,
    log: (e, d) => logs.push([e, d]),
    durable: o.durable ? new DurableStore((fn: any) => db.transaction(fn)) : undefined,
  });
  const ident = (userId: string, deviceId: string, kind: 'desktop' | 'phone', expMs = clock.t + 900_000) => ({
    userId,
    deviceId,
    kind,
    expMs,
  });
  /** Connect a fake socket as a device and wait until its start-up has run. */
  const join = async (
    userId: string,
    deviceId: string,
    kind: 'desktop' | 'phone',
    expMs?: number,
    socket: FakeSocket = new FakeSocket(),
  ) => {
    const identity = ident(userId, deviceId, kind, expMs);
    identities.set(`tok-${deviceId}`, identity);
    const h = hub.connect(socket as any, identity);
    await settle(hub);
    const say = async (m: object) => {
      h.message(JSON.stringify(m));
      await settle(hub);
    };
    return { socket, h, say, identity };
  };
  /** Connect a fake socket under a ready-made identity (a host lane or a Host) and wait until its start-up has run. */
  const open = async (identity: any) => {
    const socket = new FakeSocket();
    const h = hub.connect(socket as any, identity);
    await settle(hub);
    const say = async (m: object) => {
      h.message(JSON.stringify(m));
      await settle(hub);
    };
    return { socket, h, say, identity };
  };
  /** An app device's host lane (`<device>~h`): a Mac's or, since P1, a phone's. */
  const lane = (userId: string, deviceId: string, kind: 'desktop' | 'phone' = 'phone') => open(laneOf(ident(userId, deviceId, kind)));
  /** A fake Host on its credential's identity. */
  const host = (hostId: string, userId = 'u1') => open({ userId, deviceId: hostId, kind: 'host', expMs: Number.MAX_SAFE_INTEGER });
  return { hub, store, push, pushed, clock, join, lane, host, identities, logs, verifier, send };
}

/** Drain starting, current and retiring owners, including tracked work their queues create. */
export async function settle(hub: any) {
  const owners = new Set<any>();
  for (;;) {
    for (const conn of hub.all) owners.add(conn);
    const queues = new Map<any, Promise<unknown>>([...owners].map((conn) => [conn, conn.queue]));
    await Promise.all(queues.values());
    await Promise.all([...owners].flatMap((conn) => [...conn.kicks]));
    for (const conn of hub.all) owners.add(conn);
    if ([...owners].every((conn) => queues.get(conn) === conn.queue && conn.kicks.size === 0)) return;
  }
}

export { createVerifier };

export const P = 'p_pair00001';
export const b64 = (n: number, fill = 5) => Buffer.alloc(n, fill).toString('base64');
export const frame = (dir: 'm2p' | 'p2m', ctr: number, o: object = {}) => ({
  t: 'frame',
  pair: P,
  dir,
  ctr,
  nonce: b64(24),
  box: b64(40, ctr),
  ...o,
});

/** A Mac and a phone of one account, paired, both connected. */
export async function paired(db: any, o: Parameters<typeof makeHub>[1] = {}) {
  const r = makeHub(db, o);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  mac.socket.sent.length = 0;
  phone.socket.sent.length = 0;
  return { ...r, mac, phone };
}

/** The same pair on a hub that keeps frames until they are acked. */
export const pairedDurable = (db: any, o: Parameters<typeof makeHub>[1] = {}) => paired(db, { ...o, durable: true });
