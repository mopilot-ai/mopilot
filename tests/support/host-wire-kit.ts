// Fakes for the Host wire tests: an `ssh` process that never runs, a network of sockets that answer as a scripted Host (or refuse, or stay silent), and the clock port's fake.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './ports/clock.ts';
import { useFakeProc as installFakeProc } from './ports/proc.ts';

const require = createRequire(import.meta.url);
const frames = require('../../shared/host/frames.mjs');
const { createTunnel } = require('../../electron/host/sshTunnel.cjs');
const { createRemoteHost } = require('../../electron/host/remote.cjs');

export const tick = () => new Promise((r) => setImmediate(r));

export class FakeSocket extends EventEmitter {
  destroyed = false;
  written: any[] = [];
  decoder = frames.createDecoder();
  net: FakeNet;
  constructor(net: FakeNet) {
    super();
    this.net = net;
  }
  write(chunk: Buffer) {
    for (const f of this.decoder.push(chunk)) {
      this.written.push(f.message);
      this.net.onRequest(this, f.message);
    }
    return true;
  }
  /** Bytes from the Host. */
  feed(data: Buffer | string | object) {
    this.emit('data', typeof data === 'object' && !Buffer.isBuffer(data) ? frames.encodeControl(data) : data);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

/** Sockets to a forwarded Host: `mode` is how it behaves, `handlers` answer a method (default: ping, chats), `hold` leaves a method unanswered. */
export class FakeNet {
  mode: 'host' | 'refuse' | 'silent' = 'host';
  sockets: FakeSocket[] = [];
  hold = new Set<string>();
  handlers: Record<string, (params: any, socket: FakeSocket) => any> = {
    ping: () => 'pong',
    'host.hello': () => ({ protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] }),
    chats: () => ['a', 'b'],
    'chat.send': () => ({ replayed: false, result: 'ok' }),
    'chat.stop': () => ({ replayed: false, result: 'ok' }),
    'chat.permit': () => ({ replayed: false, result: 'ok' }),
  };
  /** Replace the reply a method gets with a raw message (for malformed replies). */
  raw: Record<string, (id: number) => any> = {};
  connect = (_path: string) => {
    const s = new FakeSocket(this);
    this.sockets.push(s);
    queueMicrotask(() => {
      if (this.mode === 'refuse') s.emit('error', Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }));
      else s.emit('connect');
    });
    return s as any;
  };
  onRequest(socket: FakeSocket, req: any) {
    if (this.mode !== 'host' || this.hold.has(req.method)) return;
    if (this.raw[req.method]) return socket.feed(this.raw[req.method](req.id));
    const h = this.handlers[req.method];
    try {
      // a test describes a subscription as the snapshot and patches it wants; the Host's stream sends them as a Hello and durable frames
      if (req.method === 'chat.subscribe' && this.handlers.subscribe) {
        const legacy = this.handlers.subscribe(req.params, socket);
        const patches = Array.isArray(legacy?.patches) ? legacy.patches : null;
        const rev = legacy?.snapshot?.rev;
        socket.feed({
          event: 'frame',
          chatId: req.params.chatId,
          frame: {
            t: 'hello',
            seq: 0,
            rev,
            epoch: 0,
            generation: legacy?.generation,
            snapshot: patches ? null : legacy?.snapshot,
            inFlightEphemeral: [],
            ...(legacy?.chatState ? { chatState: legacy.chatState } : {}),
          },
        });
        for (const p of patches ?? [])
          socket.feed({
            event: 'frame',
            chatId: req.params.chatId,
            frame: { t: 'durable', seq: p?.rev, rev: p?.rev, item: p?.patch?.item ?? p?.patch ?? {} },
          });
        return socket.feed({ id: req.id ?? null, result: { subscribed: true } });
      }
      socket.feed({ id: req.id ?? null, result: h ? h(req.params, socket) : null });
    } catch (e: any) {
      socket.feed({ id: req.id ?? null, error: { code: e.code ?? 'host_error', message: e.message } });
    }
  }
  get last() {
    return this.sockets[this.sockets.length - 1];
  }
}

export class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed: string[] = [];
  args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  kill(signal: string) {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
  }
  /** ssh ends on its own. */
  die(code = 255, stderr = '') {
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.emit('exit', code, null);
  }
}

/** A world: fake clock, fake ssh (`children`), fake network. */
export function hostWorld(t: { after: (fn: () => void) => void }, o: { spawnThrows?: Error } = {}) {
  const clock = installFakeClock(t);
  const net = new FakeNet();
  const children: FakeChild[] = [];
  const spawnOpts: any[] = [];
  let spawnThrows = o.spawnThrows;
  installFakeProc(t, {
    spawn: (_bin: string, args: string[], opts: any) => {
      spawnOpts.push(opts);
      if (spawnThrows) throw spawnThrows;
      const c = new FakeChild(args);
      children.push(c);
      return c;
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-wire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tunnel = (opts: object = {}) =>
    createTunnel({
      destination: 'build-box',
      remoteSocket: '/run/host.sock',
      localSocket: path.join(dir, 's.sock'),
      connect: net.connect,
      ...opts,
    });
  const remote = (tun: any, opts: object = {}) => createRemoteHost({ id: 'build-box', tunnel: tun, connect: net.connect, ...opts });
  return { clock, net, children, spawnOpts, dir, tunnel, remote, noSpawnError: () => (spawnThrows = undefined) };
}

/** A remote Host brought online: connected through a tunnel and a ping answered. */
export async function onlineRemote(w: ReturnType<typeof hostWorld>, tunOpts: object = {}, remoteOpts: object = {}) {
  const tun = w.tunnel(tunOpts);
  const host = w.remote(tun, remoteOpts);
  const up = host.connect();
  await tick();
  await up;
  return { tun, host };
}
