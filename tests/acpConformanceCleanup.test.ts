// The conformance permission probe owns transcript cleanup; all process, tool and model boundaries are faked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gate } from './support/transcript-writer.ts';

for (const reject of [false, true]) {
  test(`permission probe awaits its transcript before removal, rejected cleanup ${reject}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-cleanup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const held = gate();
    const failure = new Error('fixture drain rejected');
    let stopped = false;
    let drains = 0;
    let closed = 0;
    class ItemsLog {
      async drain() {
        assert.equal(stopped, true);
        drains++;
        await held.p;
        if (reject) throw failure;
      }
    }
    class Host extends EventEmitter {
      items: ItemsLog;
      agents = new Map([['fake', Promise.resolve({ init: { agentInfo: { version: 'fixture' } }, exited: true })]]);
      constructor({ items }: { items: ItemsLog }) {
        super();
        this.items = items;
      }
      requestPermission() {}
      async ensure() {
        return { state: {} };
      }
      async send() {
        this.emit('event', { kind: 'turnEnd', turnId: 'turn' });
        return { turnId: 'turn' };
      }
      closeAll() {
        stopped = true;
        this.agents.clear();
      }
    }
    const app = {
      acp: { AcpHost: Host },
      ItemsLog,
      quirks: { quirks: () => ({}), ids: () => ['fake'], findBin: () => '/fake' },
      pty: {},
      shellEnv: { init: async () => {}, childEnv: () => ({}) },
      isSageToolCall: () => true,
      echo: { handler: () => 'echo' },
    };
    t.mock.module(new URL('./conformance/lib/acp.mjs', import.meta.url).href, {
      namedExports: {
        app: () => app,
        tempDir: () => dir,
        toolChannel: () => ({ channel: {}, close: () => void closed++ }),
        until: async (fn: () => unknown) => fn(),
      },
    });
    const { probeSagePermission } = await import(`./conformance/lib/acpSagePermission.mjs?cleanup=${reject}`);
    const run = probeSagePermission('fake');
    const outcome = reject ? assert.rejects(run, (error: any) => error instanceof AggregateError && error.errors.includes(failure)) : run;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drains, 1, 'the actual probe must drain its owned log');
      assert.equal(stopped, true);
      assert.equal(fs.existsSync(dir), true, 'a held drain keeps the probe directory');
    } finally {
      held.open();
      await outcome;
    }
    assert.equal(closed, 1);
    assert.equal(fs.existsSync(dir), reject);
  });
}
