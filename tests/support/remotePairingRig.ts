// Real local identity, encrypted device list and simulated relay for pairing tests.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fakeSafe, fs, prim, tempDir } from './remoteKit.ts';
const require = createRequire(import.meta.url);
const { IdentityStore } = require('../../electron/remote/identity.cjs');
const { DeviceList } = require('../../electron/remote/deviceList.cjs');
const { PairingService } = require('../../electron/remote/pairing.cjs');

export function rig(o: { confirm?: any; registerPair?: any; removePair?: any; sendReply?: any; onUnpaired?: any; account?: any } = {}) {
  const dir = tempDir();
  const safe = fakeSafe();
  const identity = new IdentityStore({ file: join(dir, 'identity.key'), safe, fs, prim });
  const devices = new DeviceList({ file: join(dir, 'devices.key'), safe, fs });
  const state = {
    t: 1_000_000,
    replies: [] as any[],
    registered: [] as any[],
    cancelled: [] as any[],
    events: [] as any[],
    confirms: [] as any[],
  };
  const svc = new PairingService({
    identity,
    devices,
    prim,
    relayUrl: () => 'wss://relay.example/ws',
    account: o.account,
    registerPair: o.registerPair ?? (async (p: any) => void state.registered.push(p)),
    removePair: o.removePair ?? (async (p: any) => void state.cancelled.push(p)),
    sendReply: o.sendReply ?? (async (f: any) => void state.replies.push(f)),
    confirm:
      o.confirm ??
      (async (req: any) => {
        state.confirms.push(req);
        return 'allow';
      }),
    onUnpaired: o.onUnpaired,
    now: () => state.t,
  });
  svc.onEvent((e: any) => state.events.push(e));
  return { svc, identity, devices, safe, state };
}
export const states = (r: ReturnType<typeof rig>) => r.state.events.map((e) => e.state);
