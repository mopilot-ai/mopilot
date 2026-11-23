// Actual Electron pairing and sealed storage refuse stale pair claims without fencing the replacement.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('an old removal preserves the active replacement and its reopened state', async ({ harness }) => {
  const entry = path.resolve(__dirname, '../../electron/remote/pairing.cjs');
  const result = await harness.app.evaluate(async (_electron, entry) => {
    const require = process.getBuiltinModule('module').createRequire(entry);
    const fs = process.getBuiltinModule('fs').promises;
    const path = process.getBuiltinModule('path');
    const os = process.getBuiltinModule('os');
    const { PairingService } = require(entry);
    const { DeviceList } = require('./deviceList.cjs');
    const { createSodiumPrimitives } = require('./sodiumPrimitives.cjs');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-pair-removal-'));
    try {
      const safe = {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString(),
      };
      const options = { file: path.join(dir, 'devices.key'), safe, fs };
      const devices = new DeviceList(options);
      await devices.add({
        id: 'phone',
        name: 'Phone',
        pairId: 'p_old_pair',
        pub: 'AA==',
        edPub: 'AA==',
        tx: { ctr: 0, chain: '00'.repeat(32) },
        rx: { ctr: 0, chain: '11'.repeat(32) },
      });
      const previous = devices.get('phone');
      const removed: string[] = [];
      const pairing = new PairingService({
        devices,
        prim: createSodiumPrimitives(),
        removePair: async (pair: string) => {
          removed.push(pair);
        },
      });
      await devices.add({ ...previous, pairId: 'p_current_pair' });
      const lease = devices.lease('phone', 'p_current_pair');
      const stale = await pairing.unpair('phone', 'p_old_pair');
      const staleStore = await devices.removePair('phone', 'p_old_pair');
      const leaseSurvives = devices.currentLease(lease);
      const reopened = new DeviceList(options);
      await reopened.load();
      const retained = reopened.get('phone').pairId;
      const current = await pairing.unpair('phone', 'p_current_pair');
      return { stale, staleStore, leaseSurvives, retained, current, empty: devices.get('phone') === null, removed };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, entry);
  expect(result).toEqual({
    stale: false,
    staleStore: false,
    leaseSurvives: true,
    retained: 'p_current_pair',
    current: true,
    empty: true,
    removed: ['p_current_pair'],
  });
});
