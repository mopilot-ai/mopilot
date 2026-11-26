// The Mobile Remote full stack in one Node process: the real relay (PGlite and the durable mailbox) on a local port, the real Mac side (electron/remote runtime, pairing, sealed channel, remote service) and the real phone runtime (mobile/src/runtime.ts) with only its platform seams faked (socket, vault storage, account sign-in, crypto binding, foreground).
import { after, mock } from 'node:test';
import { TEST_RELAY } from './phone/testRelay.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
// loaded whole before the Mac side requires it from CJS (the phone's own import of it, through the Host fold, must not be in flight then)
import '../../shared/acpStop.mjs';
import { createPhonePrimitives } from '../../shared/remote/phonePrimitives.mjs';
import { createPhoneVault } from '../../shared/remote/phoneVault.mjs';
import * as E from '../../shared/remote/envelope.mjs';
import { loadConfig } from '../../relay/src/config.mjs';
import { createVerifier } from '../../relay/src/auth.mjs';
import { createRelay } from '../../relay/src/server.mjs';
import { DurableStore, migrateDurable } from '../../relay/src/durableStore.mjs';
import { makeDb, makeKeys } from './relayKit.ts';
import { fakeOps } from './remote-kit.ts';
import { fakeSafe, fs, tempDir } from './remoteKit.ts';

const require = createRequire(import.meta.url);
const { openRemote } = require('../../electron/remote/runtime.cjs');
const { RemoteService } = require('../../electron/remote/service.cjs');
const { gateRemote } = require('../../electron/remote/gate.cjs');
const { dropSharedLedgers } = require('../../electron/remote/sendLedger.cjs');
const { openPhoneItems } = require('../../electron/app/chromePanelPhones.cjs');
const { rowsOf, olderRowsOf } = require('../../electron/capabilities/browser/chromePanelLive.cjs');
const native = require('../../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();

/** Waits (real sockets and disk) until the condition holds. */
export async function until(cond: () => unknown, what = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Everything a test starts is closed in the reverse order, phones first and the relay last, so no socket or timer outlives the test.
const closers: (() => unknown)[] = [];
after(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
});

// ---- the relay ----

export type Relay = Awaited<ReturnType<typeof startRelay>>;

/** The real relay on a local port with a durable mailbox, an in-process Postgres and a push provider that records. */
export async function startRelay() {
  const keys = await makeKeys();
  const { db } = await makeDb();
  await migrateDurable(db);
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const pushed: any[] = [];
  const logs: [string, object][] = [];
  const durable = new DurableStore((fn: any) => db.transaction(fn));
  const make = () =>
    createRelay({
      config,
      db,
      verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
      send: async (m: any) => (pushed.push(m), { ok: true }),
      log: (event: string, data: object) => logs.push([event, data]),
      durable,
    });
  let server = make();
  const port = await server.listen(0, '127.0.0.1');
  closers.push(() => server.close());
  const base = `127.0.0.1:${port}`;
  return {
    keys,
    db,
    get server() {
      return server;
    },
    /** The relay process restarting: every socket drops, the database (and the mailbox in it) stays. */
    async restart(downMs = 0) {
      await server.close();
      if (downMs) await sleep(downMs);
      server = make();
      await server.listen(port, '127.0.0.1');
    },
    pushed,
    /** What the relay logged: errors and revocations. */
    logs,
    port,
    wsUrl: `ws://${base}/v1/ws`,
    http: `http://${base}`,
    /** The signed token the account service gives a device to ask the relay to cut it off. */
    revokeToken: (userId: string, deviceId: string) => keys.sign(userId, deviceId, { aud: 'relay-revoke' }),
    /** The code the relay closes a device's connection with (a device it refuses is closed at once, before any hello). */
    async closeCodeFor(token: string) {
      const ws = new WebSocket(`ws://${base}/v1/ws`, { headers: { authorization: `Bearer ${token}` } });
      return new Promise<number>((resolve, reject) => (ws.once('close', resolve), ws.once('error', reject)));
    },
    /** A device's socket connection, open and past the relay's hello. */
    async raw(token: string) {
      const ws = new WebSocket(`ws://${base}/v1/ws`, { headers: { authorization: `Bearer ${token}` } });
      const inbox: any[] = [];
      ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
      await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
      await until(() => inbox.some((m) => m.t === 'hello'), 'relay hello');
      return { ws, inbox };
    },
  };
}

// ---- the Mac ----

export type Mac = Awaited<ReturnType<typeof startMac>>;

/**
 * The Mac's Mobile Remote as main builds it (openRemote → sealed channel → gate → RemoteService), over the panel's operations as fakes.
 * `service` options and `ops` stand in for the app's chats, which are out of scope; everything between the relay socket and those operations is real.
 */
export async function startMac(
  relay: Relay,
  o: {
    userId?: string;
    deviceId?: string;
    ops?: Record<string, any>;
    policy?: (remote: () => any) => any;
    momoAllowed?: () => boolean;
    momo?: () => any;
    pushSettings?: any;
    answer?: (req: any) => Promise<'allow' | 'deny' | null>;
    userData?: string;
    safe?: ReturnType<typeof fakeSafe>;
    machineName?: () => string;
    /** Each chat's saved history turns, as a harness keeps them: a snapshot carries their last rows and chat.read pages the rest (the app's own row code, chromePanelLive.cjs). */
    history?: Record<string, any[]>;
  } = {},
) {
  // a Mac started on the files of an earlier one is a new process: what the old one held in memory is gone
  if (o.userData) dropSharedLedgers();
  const userId = o.userId ?? 'u1';
  const deviceId = o.deviceId ?? 'mac-1';
  const userData = o.userData ?? tempDir();
  const safe = o.safe ?? fakeSafe();
  const confirms: any[] = [];
  const fake = fakeOps(o.ops);
  const live: any = {
    mopilot: { relayToken: () => relay.keys.sign(userId, deviceId) },
    notifier: { onBanner: null, onSettled: null, idleMs: () => null, getKinds: () => ({ turn: true, goal: true }) },
  };
  const service = new RemoteService({
    ops: fake.ops,
    goneText: "That chat isn't in MoPilot.",
    policy: o.policy?.(() => remote) ?? {},
    momoAllowed: o.momoAllowed,
    momo: o.momo,
    pushSettings: o.pushSettings ?? null,
    version: '1.2.3',
    ...(o.machineName ? { machineName: o.machineName } : {}),
  });
  fake.holder.service = service;
  // the items a followed chat streams come from the real item feed, fed raw harness events as the controller would
  const history = o.history ?? {};
  const feed = openPhoneItems({
    service: () => service,
    chatOf: (id: string) => id,
    rows: async (id: string, n: number) => (history[id] ? rowsOf(history[id]).rows.slice(-n) : []),
  });
  if (!o.ops?.items) fake.ops.items = feed.items;
  if (o.history && !o.ops?.older)
    fake.ops.older = async (id: string, before: string, limit: number) => olderRowsOf(history[id] ?? [], before, limit);
  const remote = openRemote({
    userData,
    live,
    safeStorage: safe,
    fs,
    // the relay the phone is made with, so a pairing's relay is the one it expects; the socket goes to the local relay either way
    relayUrl: TEST_RELAY,
    createSocket: (_url: string, headers: Record<string, string>) => new WebSocket(relay.wsUrl, { headers }),
    scope: () => JSON.stringify([userId, deviceId]),
    optedIn: () => true,
    flagOn: () => true,
    confirm: async (req: any) => {
      confirms.push(req);
      return o.answer ? o.answer(req) : 'allow';
    },
    onChannel: (channel: any) => {
      if (channel) gateRemote({ service, transport: channel, enabled: () => true });
      else service.detach();
    },
  });
  await remote.sync();
  closers.push(() => remote.close());
  assert.ok(remote.running, 'Mobile Remote started');
  await until(() => remote.channel && (remote as any).channel.o.relay.state === 'open', 'the Mac to reach the relay');
  return {
    userId,
    deviceId,
    userData,
    safe,
    remote,
    service,
    live,
    confirms,
    history,
    ...fake,
    /** One raw event of a harness family for a chat, as the controller emits it. */
    emit: (family: 'codex' | 'claude' | 'acp', event: unknown) => feed.live(family, event),
    relayState: () => remote.channel?.o.relay.state as string | undefined,
    /** A QR payload for a phone to scan. */
    async qr() {
      const begun = await remote.pairing.begin();
      return begun.qr as string;
    },
    stop: () => remote.close(),
  };
}

// ---- the phone ----

type PhoneEnv = {
  id: string;
  userId: string;
  relay: Relay;
  storage: ReturnType<typeof memoryStorage>;
  foreground: Set<() => void>;
  sockets: WebSocket[];
  refreshes: number;
  /** When set, the next sockets the phone opens fail (the phone is offline). */
  offline: boolean;
  /** When set, the receipts the phone sends for delivered frames are lost on the way. */
  dropAcks: boolean;
  /** The receipts the phone sent the relay, by counter. */
  acked: number[];
  /** How many times the phone tried to open the relay socket. */
  opened: number;
  /** Bytes the phone's relay sockets received and sent, text frames as they went over the wire. */
  bytes: { in: number; out: number };
};
let current: PhoneEnv | null = null;
const byDevice = new Map<string, PhoneEnv>();
let signInLock: Promise<unknown> = Promise.resolve();

type MemoryData = { value: string | null; key: string | null; tail: Promise<unknown> };

/**
 * The phone's SQLite row and device-only key, in memory; reusing it with a new runtime is an app restart.
 * `reopen()` is the OS killing the app: the old runtime keeps running in this process but can no longer change what is saved, and the
 * returned storage is what the next launch reads. `failWrites` makes saving fail (a full disk).
 */
export function memoryStorage(data: MemoryData = { value: null, key: null, tail: Promise.resolve() }) {
  let frozen = false;
  let failing = false;
  let failed = 0;
  return {
    /** How many saves failed while `failWrites` was on (a test waits for the one it provoked instead of for a fixed time). */
    failedWrites: () => failed,
    key: { get: async () => data.key, set: async (v: string) => void (data.key = v) },
    failWrites: (on: boolean) => void (failing = on),
    reopen() {
      frozen = true;
      return memoryStorage(data);
    },
    transaction<T>(fn: (row: { read: () => Promise<string | null>; write: (v: string) => Promise<void> }) => Promise<T>): Promise<T> {
      const run = data.tail.then(async () => {
        if (failing) {
          failed++;
          throw new Error('disk is full');
        }
        let next = data.value;
        const result = await fn({ read: async () => next, write: async (v) => void (next = v) });
        if (!frozen && next !== data.value) data.value = next;
        return result;
      });
      data.tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** The phone's saved state read through a vault of its own on the same storage (a test waits for a save to land before it "kills" the app, or plants what an earlier version saved). */
export const vaultOf = (storage: ReturnType<typeof memoryStorage>) =>
  createPhoneVault({ prim: createPhonePrimitives(sodium, { x25519, sha256, hmac }), ...storage });
export const savedOutbox = (storage: ReturnType<typeof memoryStorage>): Promise<{ user: string; items: any[] } | null> =>
  vaultOf(storage).getOutbox();

const sodium = {
  randombytes_buf: native.randomBytes,
  crypto_sign_keypair: () => {
    const p = native.edKeypair();
    return { publicKey: p.pk, privateKey: p.sk };
  },
  crypto_sign_detached: (msg: Uint8Array, sk: Uint8Array) => native.edSign(sk, msg),
  crypto_sign_verify_detached: (sig: Uint8Array, msg: Uint8Array, pk: Uint8Array) => native.edVerify(pk, msg, sig),
  crypto_aead_xchacha20poly1305_ietf_encrypt: (plain: Uint8Array, aad: string, _n: null, nonce: Uint8Array, key: Uint8Array) =>
    native.aeadSeal(key, nonce, plain, E.utf8(aad)),
  crypto_aead_xchacha20poly1305_ietf_decrypt: (_n: null, box: Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array) => {
    const value = native.aeadOpen(key, nonce, box, E.utf8(aad));
    if (value === null) throw new Error('[react-native-libsodium][crypto_aead_xchacha20poly1305_ietf_decrypt] failed');
    return value;
  },
};

/** The device a signed token names (the platform seams are module-level, so the token tells which phone calls). */
const deviceOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).did as string;

mock.module('../../mobile/src/platform/crypto.ts', {
  namedExports: { phonePrimitives: () => createPhonePrimitives(sodium, { x25519, sha256, hmac }) },
});
mock.module('../../mobile/src/platform/lifecycle.ts', {
  namedExports: {
    isActive: () => true,
    onForeground: (listener: () => void) => {
      const env = current!;
      env.foreground.add(listener);
      return () => env.foreground.delete(listener);
    },
  },
});
// the phone's own reconnect pacing, shortened so a scenario sees several attempts in a moment
const phoneTiming = { baseMs: 30, capMs: 120, jitter: 0, minGapMs: 20 };
mock.module('../../mobile/src/platform/reconnectTiming.ts', { namedExports: { reconnectTiming: phoneTiming } });
/** Runs `work` with the phone's reconnect pacing changed (the reconnector reads it on every wait), then puts the usual one back. */
export async function withPhoneTiming<T>(change: Partial<typeof phoneTiming>, work: () => Promise<T>): Promise<T> {
  const saved = { ...phoneTiming };
  Object.assign(phoneTiming, change);
  try {
    return await work();
  } finally {
    Object.assign(phoneTiming, saved);
  }
}
mock.module('../../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => current!.storage } });
mock.module('../../mobile/src/platform/socket.ts', {
  namedExports: {
    openPhoneSocket: (url: string, token: string) => {
      const env = byDevice.get(deviceOf(token))!;
      env.opened++;
      // a phone without network fails to open the socket the way a React Native WebSocket does
      if (env.offline) throw new Error('relay connection failed');
      // the Host lane is the same relay at the same address with `?as=hostlink`, as the phone asks for it
      const lane = url.includes('as=hostlink')
        ? `${env.relay.wsUrl}${env.relay.wsUrl.includes('?') ? '&' : '?'}as=hostlink`
        : env.relay.wsUrl;
      const ws = new WebSocket(lane, { headers: { authorization: `Bearer ${token}` } });
      const send = ws.send.bind(ws) as (...a: any[]) => void;
      ws.on('message', (data) => void (env.bytes.in += (data as Buffer).length));
      (ws as any).send = (data: string, ...rest: any[]) => {
        const m = JSON.parse(data);
        if (m.t === 'ack') {
          if (env.dropAcks) return undefined;
          env.acked.push(m.ctr);
        }
        env.bytes.out += Buffer.byteLength(data);
        return send(data, ...rest);
      };
      // a socket the test cuts (the OS killing the app, a lost network) may report a reset after its owner stopped listening
      ws.on('error', () => undefined);
      env.sockets.push(ws);
      return ws;
    },
  },
});
mock.module('../../mobile/src/platform/randomId.ts', {
  namedExports: { randomId: () => `${native.randomBytes(8).reduce((a: string, b: number) => a + b.toString(16).padStart(2, '0'), '')}-id` },
});
let signedIn = 0;
mock.module('../../mobile/src/platform/auth.ts', {
  namedExports: {
    thisPhoneName: () => 'Test iPhone',
    // the account service: a signed-in phone is a device of the user, with a refresh token only this device presents
    authorize: async () => {
      const env = current!;
      const deviceId = env.id;
      byDevice.set(deviceId, env);
      return {
        user: { id: env.userId, name: 'Du', email: 'du@example.com' },
        deviceId,
        refreshToken: `refresh:${deviceId}:${++signedIn}`,
        accessToken: await env.relay.keys.sign(env.userId, deviceId, { kind: 'phone', aud: 'desktop' }),
        expiresAt: Date.now() + 15 * 60_000,
      };
    },
    // the account service turns a phone's access token into the relay's: a token of the relay's own audience, for the same device
    relayToken: async (accessToken: string) => {
      const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
      const env = byDevice.get(claims.did)!;
      return { token: await env.relay.keys.sign(env.userId, claims.did, { kind: 'phone' }), expires_in: 600 };
    },
    refresh: async (token: string) => {
      const deviceId = token.split(':')[1];
      const env = byDevice.get(deviceId)!;
      env.refreshes++;
      return {
        access_token: await env.relay.keys.sign(env.userId, deviceId, { kind: 'phone', aud: 'desktop' }),
        refresh_token: `refresh:${deviceId}:${++signedIn}`,
        expires_in: 900,
      };
    },
  },
});
// the phone's modules load by variable path, after the seams above are mocked (a static import would be linked first, and a literal path would pull the phone's React Native types into the node typecheck)
const phoneModule = (name: string): Promise<any> => import(`../../mobile/src/${name}.ts`);
const { createMobileRuntime } = await phoneModule('runtime');
export const client = await phoneModule('remote/client');
export const phoneReview = await phoneModule('remote/review');
export const phoneMirror = await phoneModule('remote/mirror');
export const phoneEarlier = await phoneModule('remote/earlier');
export const phoneThread = await phoneModule('presentation/thread');
export const phoneMenu = await phoneModule('remote/composerMenu');

export type Phone = Awaited<ReturnType<typeof startPhone>>;

/**
 * A phone: the real runtime started on a vault, signed in. Pass `storage` of an earlier phone to start it again after the app was closed.
 * `events` collects every event the Mac pushed.
 */
export async function startPhone(
  relay: Relay,
  o: {
    id?: string;
    userId?: string;
    storage?: ReturnType<typeof memoryStorage>;
    signIn?: boolean;
    relayUrl?: string;
    /** The host-chat flag the app hands the runtime (mobile/src/remote/hostChatFlag.ts). */
    hostChat?: object;
  } = {},
) {
  const env: PhoneEnv = {
    id: o.id ?? 'phone-1',
    userId: o.userId ?? 'u1',
    relay,
    storage: o.storage ?? memoryStorage(),
    foreground: new Set(),
    sockets: [],
    refreshes: 0,
    offline: false,
    dropAcks: false,
    acked: [],
    opened: 0,
    bytes: { in: 0, out: 0 },
  };
  byDevice.set(env.id, env);
  const previous = signInLock;
  let release!: () => void;
  signInLock = new Promise<void>((r) => (release = r));
  await previous;
  try {
    current = env;
    const runtime = o.relayUrl
      ? createMobileRuntime(o.relayUrl, o.relayUrl.startsWith('ws:'), o.hostChat)
      : createMobileRuntime(TEST_RELAY);
    closers.push(
      runtime.subscribe(() => undefined),
      () => runtime.disconnect(),
    );
    const events: any[] = [];
    runtime.onEvent((e: any) => events.push(e));
    await runtime.start();
    if (o.signIn !== false && !runtime.snapshot().user) await runtime.signIn();
    const phone = {
      env,
      runtime,
      events,
      storage: env.storage,
      /** The phone's saved state through a vault of its own on the same storage. */
      vault: () => vaultOf(env.storage),
      snap: () => runtime.snapshot(),
      /** How many times the phone tried to open the relay socket, failed tries included (a reconnect storm shows here). */
      opened: () => env.opened,
      /** Bytes over the phone's relay sockets so far, both ways. */
      bytes: () => ({ ...env.bytes }),
      ask: (method: string, params: Record<string, unknown> = {}) => runtime.request(method, params) as Promise<any>,
      eventsOf: (ev: string) => events.filter((e) => e.ev === ev),
      /** Scans the QR and waits until the pair is committed. */
      async pair(qr: string, name = 'Du’s iPhone') {
        current = env;
        await runtime.pair(qr, name);
        return phone;
      },
      /** Brings the app back to the foreground (what the OS does when the user opens it). */
      foreground: () => env.foreground.forEach((fn) => fn()),
      /** The phone loses the network: open sockets drop and new ones fail until it returns. */
      goOffline() {
        env.offline = true;
        for (const ws of env.sockets.splice(0)) ws.terminate();
      },
      comeBack() {
        env.offline = false;
      },
    };
    return phone;
  } finally {
    release();
  }
}

/** The fake Mac operations a chat scenario needs on top of remote-kit's: re-exported so tests need one import. */
export { fakeOps };
