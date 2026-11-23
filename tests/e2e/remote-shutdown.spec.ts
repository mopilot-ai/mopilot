// Actual Electron retires pending Mobile Remote readiness before terminal shutdown can reopen a relay.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('terminal shutdown prevents a late device load from reconnecting', async ({ harness }) => {
  const entry = path.resolve(__dirname, '../../electron/remote/runtime.cjs');
  const result = await harness.app.evaluate(async (_electron, entry) => {
    const require = process.getBuiltinModule('module').createRequire(entry);
    const fs = process.getBuiltinModule('fs').promises;
    const path = process.getBuiltinModule('path');
    const os = process.getBuiltinModule('os');
    const { openRemote } = require(entry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-shutdown-'));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const ready = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    let tokens = 0;
    let sockets = 0;
    let attached = 0;
    const remote = openRemote({
      userData: dir,
      live: { mopilot: { relayToken: async () => (tokens++, 'synthetic-token') } },
      flagOn: () => true,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString(),
      },
      fs: {
        ...fs,
        readFile: async () => {
          reads++;
          enter();
          await ready;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      },
      onChannel: (channel: unknown) => {
        if (channel) attached++;
      },
      createSocket: () => {
        sockets++;
        return { close: () => {}, send: () => {} };
      },
    });
    try {
      const starting = remote.sync();
      await entered;
      remote.close();
      release();
      await starting;
      await new Promise((resolve) => setImmediate(resolve));
      await remote.sync();
      await new Promise((resolve) => setImmediate(resolve));
      return { reads, tokens, sockets, attached, running: remote.running };
    } finally {
      release();
      remote.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, entry);
  expect(result).toEqual({ reads: 1, tokens: 0, sockets: 0, attached: 0, running: false });
});
