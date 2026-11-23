// The installed-ACP permission probe drains its transcript writer before deleting scratch data, with all CLI boundaries faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gate } from './support/transcript-writer.ts';

const require = createRequire(import.meta.url);
const { ItemsLog } = require('../electron/platform/itemsLog.cjs');

test('ACP permission probe waits for its writer during teardown', async (t) => {
  const entered = gate();
  const release = gate();
  const closed: string[] = [];
  let owned = '';
  let writing: Promise<void>;
  class Host {
    items: InstanceType<typeof ItemsLog>;
    agents = new Map();
    requestPermission() {}
    event!: (event: object) => void;
    constructor({ items }: { items: InstanceType<typeof ItemsLog> }) {
      this.items = items;
      const { writer } = items;
      for (const name of ['flush', 'drain'] as const) {
        const real = writer[name].bind(writer);
        writer[name] = async (...args: unknown[]) => {
          entered.open();
          await release.p;
          return (real as any)(...args);
        };
      }
    }
    on(_name: string, listener: (event: object) => void) {
      this.event = listener;
    }
    async ensure() {
      return { state: {} };
    }
    async send() {
      this.items.append('probe', { t: 'user' });
      this.items.append('probe', { t: 'end' });
      writing = this.items.flush('probe');
      await entered.p;
      this.event({ kind: 'turnEnd', turnId: 'turn' });
      return { turnId: 'turn' };
    }
    closeAll() {
      closed.push('host');
    }
  }
  const app = {
    acp: { AcpHost: Host },
    ItemsLog,
    quirks: { quirks: () => ({}), ids: () => ['fake'], findBin: () => '/fake' },
    shellEnv: { init: async () => {}, childEnv: () => ({}) },
    echo: { handler: () => {} },
  };
  t.mock.module('./conformance/lib/acp.mjs', {
    namedExports: {
      app: () => app,
      tempDir: (prefix: string) => (owned = fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
      toolChannel: () => ({
        channel: {},
        close: () => {
          closed.push('tools');
        },
      }),
      until: async (predicate: () => unknown) => {
        assert.ok(predicate());
      },
    },
  });
  const { probeSagePermission } = await import('./conformance/lib/acpSagePermission.mjs');
  const probing = probeSagePermission('fake');
  try {
    await entered.p;
    for (let n = 0; n < 6; n++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, ['host', 'tools']);
    assert.equal(fs.existsSync(owned), true, 'a pending append still owns its scratch directory');
    release.open();
    await probing;
    assert.equal(fs.existsSync(owned), false, 'the probe removes its directory after the write settles');
  } finally {
    release.open();
    await Promise.all([probing, writing!]);
    fs.rmSync(owned, { recursive: true, force: true });
  }
});
