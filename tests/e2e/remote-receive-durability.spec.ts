// Exercises the actual main-process remote channel and device storage across a blocked checkpoint and restart.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('remote receive persists before dispatch and drops a replay after restart without ending the session', async ({ harness }) => {
  const modulePath = path.resolve(__dirname, '../../electron/remote/channel.cjs');
  const result = await harness.app.evaluate(async ({ app }, entry) => {
    const require = process.getBuiltinModule('module').createRequire(entry);
    const fs = process.getBuiltinModule('fs').promises;
    const path = process.getBuiltinModule('path');
    const os = process.getBuiltinModule('os');
    const { RemoteChannel } = require(entry);
    const { DeviceList } = require('./deviceList.cjs');
    const { createSodiumPrimitives } = require('../platform/sodiumPrimitives.cjs');
    const { createCrypto, toHex, toWire, encodeMessage } = require('./esm.cjs');
    const prim = createSodiumPrimitives();
    const crypto = createCrypto(prim);
    const chain = prim.randomBytes(32);
    const pairId = 'p_durablefixture';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-durable-'));
    try {
      const safe = {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString(),
      };
      const file = path.join(dir, 'devices.key');
      const devices = new DeviceList({ file, safe, fs });
      await devices.add({
        id: 'phone',
        name: 'phone',
        pairId,
        pub: 'AA==',
        edPub: 'AA==',
        tx: { ctr: 0, chain: toHex(prim.randomBytes(32)) },
        rx: { ctr: 0, chain: toHex(chain) },
      });
      const relay = () => {
        const handlers: Record<string, (v: any) => void> = {};
        return {
          state: 'open',
          presence: 'online',
          sendFrame: () => 'sent',
          on: (name: string, fn: (v: any) => void) => {
            handlers[name] = fn;
            return () => {};
          },
          emit: (v: any) => handlers.frame(v),
        };
      };
      const firstRelay = relay();
      const channel = new RemoteChannel({ devices, relay: firstRelay, prim });
      await channel.start();
      let delivered = 0;
      channel.onMessage(() => delivered++);
      const update = devices.update.bind(devices);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      devices.update = async (...args: any[]) => {
        if (args[1].rx) {
          entered();
          await gate;
        }
        return update(...args);
      };
      const sender = crypto.createSender({ pair: pairId, dir: 'p2m', chain });
      const frame = toWire(sender.seal(encodeMessage({ id: 'request', t: 1, kind: 'request', method: 'chat.send', params: {} })));
      firstRelay.emit(frame);
      await started;
      const before = delivered;
      release();
      await channel.sessions.get(pairId).receiving;
      const after = delivered;
      channel.stop();
      const devices2 = new DeviceList({ file, safe, fs });
      const secondRelay = relay();
      const restarted = new RemoteChannel({ devices: devices2, relay: secondRelay, prim });
      await restarted.start();
      let replayed = 0;
      let closed = '';
      restarted.onMessage(() => replayed++);
      restarted.onPairClosed((e: any) => {
        closed = e.code;
      });
      secondRelay.emit(frame);
      const session = restarted.sessions.get(pairId);
      await session.receiving;
      await session.sending;
      const counts = restarted.statsOf(pairId);
      restarted.stop();
      return { before, after, replayed, closed, counts, electron: app.getVersion() };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, modulePath);
  // a replay is dropped and counted: it never reaches the service and it no longer ends the session
  expect(result).toMatchObject({ before: 0, after: 1, replayed: 0, closed: '', counts: { paused: false } });
  expect((result.counts?.duplicates ?? 0) + (result.counts?.dropped ?? 0)).toBeGreaterThanOrEqual(1);
});
