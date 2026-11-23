// ACP fixture teardown waits for a blocked transcript append before removing its owning directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, dir, setup, KEY, CWD, settle } from './support/acp-host/fixture.ts';
import { transcriptFixture } from './support/transcript-fixture.ts';

function cleanupAcpHosts(dir: string, hosts: { closeAll(): void; items: { drain(): Promise<unknown> } }[]) {
  const fixture = transcriptFixture(dir);
  for (const host of hosts) {
    fixture.own(host.items);
    fixture.stopWith(() => host.closeAll());
  }
  return fixture.cleanup();
}
import { gate } from './support/transcript-writer.ts';

test('ACP fixture cleanup closes its hosts and waits for an in-flight transcript write', async () => {
  const fixture = setup();
  await fixture.host.ensure(KEY, { cwd: CWD });
  await fixture.items.drain();
  const entered = gate();
  const release = gate();
  const { writer } = fixture.items;
  const drain = writer.drain.bind(writer);
  writer.drain = async (...args: unknown[]) => {
    entered.open();
    await release.p;
    return drain(...args);
  };
  fixture.items.append(KEY, { t: 'end', turnId: 'pending' });
  let finished = false;
  const cleaning = Promise.resolve()
    .then(cleanup)
    .then(() => {
      finished = true;
    });
  try {
    await entered.p;
    await settle();
    assert.equal(fs.existsSync(dir), true, 'the directory remains until the pending append settles');
    assert.equal(fixture.host.chats.size, 0, 'the host is closed before waiting for its writer');
    assert.equal(finished, false, 'teardown remains pending while the append is held');
  } finally {
    release.open();
    await cleaning;
  }
  assert.equal(fs.existsSync(dir), false);
});

for (const first of [0, 1]) {
  test(`ACP fixture cleanup waits for every host's drain, host ${first} finishes first`, async (t) => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cleanup-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-other-'));
    t.after(() => {
      fs.rmSync(owned, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    });
    const pending = [gate(), gate()];
    const closed: number[] = [];
    const hosts = pending.map((waiting, index) => ({
      closeAll: () => {
        closed.push(index);
      },
      items: {
        drain: () => {
          assert.deepEqual(closed, [0, 1], 'all producers stop before any writer is drained');
          return waiting.p;
        },
      },
    }));
    const cleaning = cleanupAcpHosts(owned, hosts);
    try {
      pending[first].open();
      await settle();
      assert.equal(fs.existsSync(owned), true);
      pending[1 - first].open();
      await cleaning;
      assert.equal(fs.existsSync(owned), false);
      assert.equal(fs.existsSync(other), true, 'another fixture directory remains untouched');
    } finally {
      pending.forEach((waiting) => waiting.open());
      await cleaning;
    }
  });
}

test('ACP fixture cleanup preserves its directory and reports a failed drain', async (t) => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cleanup-failed-'));
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  const failed = new Error('drain failed');
  const host = {
    closeAll: () => {},
    items: {
      drain: async () => {
        throw failed;
      },
    },
  };
  await assert.rejects(cleanupAcpHosts(owned, [host]), (error: any) => error instanceof AggregateError && error.errors.includes(failed));
  assert.equal(fs.existsSync(owned), true);
});

test('ACP fixture cleanup accepts an empty host list and repeated cleanup', async () => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cleanup-empty-'));
  await cleanupAcpHosts(owned, []);
  await cleanupAcpHosts(owned, []);
  assert.equal(fs.existsSync(owned), false);
});
