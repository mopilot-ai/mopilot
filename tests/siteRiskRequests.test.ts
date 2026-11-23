// Remote site risk checks: concurrent host lookup, retry and service-disable races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { SiteRisk } = createRequire(import.meta.url)('../electron/capabilities/browser/siteRisk.cjs');

test('concurrent host checks share a lookup without sharing per-URL credential flags', async () => {
  let calls = 0;
  let release!: (category: string) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const risk = new SiteRisk({
    remoteEnabled: () => true,
    remote: () => {
      calls++;
      return pending;
    },
  });
  const results = Promise.all([risk.assess('https://duplicate-unit.test/a'), risk.assess('https://user:secret@duplicate-unit.test/b')]);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    release('banking');
  }
  const [plain, credential] = await results;
  assert.equal(plain.level, 'high');
  assert.equal(credential.level, 'high');
  assert.equal(plain.credentials, false);
  assert.equal(credential.credentials, true);
});

test('failed shared lookups permit a retry and different hosts remain independent', async () => {
  let calls = 0;
  let failed = true;
  const risk = new SiteRisk({
    remoteEnabled: () => true,
    remote: async () => {
      calls++;
      if (failed) throw Error('offline');
      return 'banking';
    },
  });
  const failedResults = await Promise.all([risk.assess('https://retry-unit.test/a'), risk.assess('https://retry-unit.test/b')]);
  assert.ok(failedResults.every((result) => result.level === 'normal'));
  assert.equal(calls, 1);
  failed = false;
  assert.equal((await risk.assess('https://retry-unit.test/again')).level, 'high');
  assert.equal(calls, 2);
  await Promise.all([risk.assess('https://first-unit.test/'), risk.assess('https://second-unit.test/')]);
  assert.equal(calls, 4);
});

test('queued reputation lookups honor a disabled or removed remote service', async () => {
  for (const change of ['disabled', 'removed']) {
    let enabled = true;
    let calls = 0;
    const lookup = async () => {
      calls++;
      return 'banking';
    };
    const risk = new SiteRisk({ remoteEnabled: () => enabled, remote: lookup });
    const pending = risk.assess('https://queued-unit.test/');
    if (change === 'disabled') enabled = false;
    else risk.remote = null;
    assert.equal((await pending).level, 'normal');
    assert.equal(calls, 0);
    enabled = true;
    risk.remote = lookup;
    assert.equal((await risk.assess('https://queued-unit.test/')).level, 'high');
    assert.equal(calls, 1);
  }
});

test('disabling or removing the remote service during a lookup discards its result and permits retry', async () => {
  for (const change of ['disabled', 'removed']) {
    let enabled = true;
    let calls = 0;
    let release!: (category: string) => void;
    const lookup = () => {
      calls++;
      return new Promise<string>((done) => {
        release = done;
      });
    };
    const risk = new SiteRisk({ remoteEnabled: () => enabled, remote: lookup });
    const pending = risk.assess('https://disabled-pending-unit.test/');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    if (change === 'disabled') enabled = false;
    else risk.remote = null;
    release('banking');
    assert.equal((await pending).level, 'normal');
    assert.equal(risk.cache.has('disabled-pending-unit.test'), false);
    enabled = true;
    risk.remote = async () => {
      calls++;
      return 'banking';
    };
    assert.equal((await risk.assess('https://disabled-pending-unit.test/')).level, 'high');
    assert.equal(calls, 2);
  }
});
