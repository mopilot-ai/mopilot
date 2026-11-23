// Shared real device-list and phone fixtures for remote channel unit tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as E from '../../shared/remote/envelope.mjs';
import { fakeSafe, fs, prim, tempDir } from './remoteKit.ts';
import { crypto } from './remotePhone.ts';
import { waitFor } from './waitFor.ts';
const require = createRequire(import.meta.url);
const { DeviceList } = require('../../electron/remote/deviceList.cjs');
const { RemoteChannel } = require('../../electron/remote/channel.cjs');

/** Waits (real I/O: the device list writes sealed files) until the condition holds. */
export async function until(cond: () => boolean) {
  await waitFor(cond, 'the condition');
  assert.ok(cond(), 'timed out');
}

function fakeRelay() {
  const handlers: Record<string, Set<(v: any) => void>> = {
    frame: new Set(),
    event: new Set(),
    open: new Set(),
    state: new Set(),
    error: new Set(),
  };
  return {
    state: 'open',
    presence: 'online',
    outcome: 'sent',
    sent: [] as any[],
    reconnects: 0,
    /** What a RelayClient does: a fresh connection, whose hello the channel hears. */
    reconnect() {
      this.reconnects++;
    },
    sendFrame(w: any) {
      this.sent.push(w);
      return this.outcome;
    },
    on(kind: string, fn: (v: any) => void) {
      handlers[kind].add(fn);
      return () => handlers[kind].delete(fn);
    },
    emit(kind: string, v: any) {
      for (const fn of [...handlers[kind]]) fn(v);
    },
    listeners: () => handlers.frame.size + handlers.event.size + handlers.open.size + handlers.state.size + handlers.error.size,
  };
}

/** A phone paired the way pairing.cjs stores one: both chains from one root. */
export function pairing(id = 'phone-1', pairId = 'p_pairedphone1') {
  const macSk = prim.randomBytes(32);
  const phoneSk = prim.randomBytes(32);
  const macEph = prim.randomBytes(32);
  const phoneEph = prim.randomBytes(32);
  const root = crypto.deriveRoot(macSk, prim.x25519Base(phoneSk), macEph, prim.x25519Base(phoneEph), 'mac_x', id, pairId);
  const m2p = crypto.dirKey(root, 'm2p');
  const p2m = crypto.dirKey(root, 'p2m');
  return {
    record: { id, name: id, pairId, pub: 'AA==', edPub: 'AA==', tx: { ctr: 0, chain: E.toHex(m2p) }, rx: { ctr: 0, chain: E.toHex(p2m) } },
    phone: {
      tx: crypto.createSender({ pair: pairId, dir: 'p2m', chain: p2m }),
      rx: crypto.createReceiver({ pair: pairId, dir: 'm2p', chain: m2p }),
    },
    pairId,
  };
}
export type Pairing = ReturnType<typeof pairing>;

export const msg = (id: string, extra: object = {}) => ({ id, t: 1, kind: 'event', ev: 'x', ...extra });
export const request = (id: string) => ({ id, t: 1, kind: 'request', method: 'chat.send', params: { chatId: 'c' } });
export const wireOf = (p: Pairing, m: object, nonce?: Uint8Array) => E.toWire(p.phone.tx.seal(E.encodeMessage(m), nonce));
export const drain = (r: any, p = r.phone) => r.channel.sessions.get(p.pairId).receiving;
export const openOut = (p: Pairing, w: any) => E.decodeMessage(p.phone.rx.open(E.decodeFrame(w)));

export async function rig(
  o: {
    phones?: Pairing[];
    onHello?: any;
    now?: () => number;
    mono?: () => number;
    budget?: { steps: number; perSecond: number };
    reconnectMs?: number;
    phoneAbsent?: (pairId: string) => boolean;
    onPhoneFrame?: (pairId: string, receivedAt: number, sentAt: number) => void;
    catchUpSkip?: number;
  } = {},
) {
  const dir = tempDir();
  const file = join(dir, 'devices.key');
  const safe = fakeSafe();
  const devices = new DeviceList({ file, safe, fs });
  const phones = o.phones ?? [pairing()];
  for (const p of phones) await devices.add(p.record);
  const relay = fakeRelay();
  const channel = new RemoteChannel({
    devices,
    relay,
    prim,
    onHello: o.onHello,
    now: o.now,
    mono: o.mono,
    budget: o.budget,
    reconnectMs: o.reconnectMs,
    phoneAbsent: o.phoneAbsent,
    onPhoneFrame: o.onPhoneFrame,
    catchUpSkip: o.catchUpSkip,
  });
  await channel.start();
  const delivered: [string, any][] = [];
  channel.onMessage((pairId: string, m: any) => delivered.push([pairId, m]));
  const restart = async () => {
    channel.stop();
    const d2 = new DeviceList({ file, safe, fs });
    const r2 = fakeRelay();
    const c2 = new RemoteChannel({ devices: d2, relay: r2, prim });
    await c2.start();
    return { devices: d2, relay: r2, channel: c2 };
  };
  return { devices, relay, channel, phones, phone: phones[0], delivered, restart };
}
