// Browser import lifecycle cases using shared fake sessions, storage, and readers.
import { test, assert, ImportError, world } from './fixture.ts';

export function registerRetiredReads() {
  for (const stage of ['key', 'cookies', 'passwords']) {
    for (const retirement of ['cancel', 'replace', 'expire']) {
      test(`start: a rejected ${stage} read after ${retirement} cannot publish or continue a retired import`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let reject: (error: Error) => void = () => {};
        const gate = new Promise<never>((_resolve, fail) => {
          reject = fail;
        });
        const w = world({
          jobMs: 10,
          ...(stage === 'key' ? { keyHook: () => gate } : { [stage]: () => gate }),
        });
        const started = w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true, passwords: true } });
        await new Promise((resolve) => setImmediate(resolve));
        const old = w.importer.job;
        let replacement: any = null;
        if (retirement === 'cancel') w.importer.cancel(old.id);
        else if (retirement === 'replace') {
          await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true } });
          replacement = w.importer.job;
        } else t.mock.timers.tick(10);
        const cancelled = assert.rejects(started, { code: 'cancelled' });
        reject(new ImportError('read_failed', 'read rejected after retirement'));
        await cancelled;
        assert.equal(w.importer.job, replacement);
        assert.equal(old.cookies, null);
        assert.equal(old.passwords, null);
        assert.equal(w.calls.filter((call: any) => call[1] === 'passwords').length, stage === 'passwords' ? 1 : 0);
        if (stage !== 'key') assert.deepEqual(w.keyBuf, Buffer.alloc(16));
        if (replacement) assert.equal((await w.importer.run({ jobId: replacement.id })).history.status, 'ok');
        assert.equal(w.importer.job, null);
      });
    }
  }

  for (const kind of ['bookmarks', 'history']) {
    test(`run: a rejected ${kind} read after cancellation reports cancelled and preserves a replacement`, async () => {
      let reject: (error: Error) => void = () => {};
      const gate = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      const w = world({ [kind]: () => gate });
      const started = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { [kind]: true } });
      const running = w.importer.run({ jobId: started.jobId });
      w.importer.cancel(started.jobId);
      const next = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
      const replacement = w.importer.job;
      reject(new ImportError('read_failed', 'late failure'));
      assert.deepEqual((await running)[kind], { status: 'cancelled' });
      assert.equal(w.importer.job, replacement);
      assert.deepEqual(w.events, [], 'a retired job cannot publish progress for its replacement');
      assert.deepEqual(w.data[kind]().importedSources(), []);
      assert.equal((await w.importer.run({ jobId: next.jobId })).cookies.status, 'ok');
    });
  }
}

export function registerCancellation() {
  test('cancel: during the keychain prompt the job ends and nothing is read; after start nothing more is written', async () => {
    let release: () => void = () => {};
    const w = world({ keyHook: () => new Promise<void>((r) => (release = r)) });
    const started = w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    await new Promise((r) => setImmediate(r));
    const job = w.importer.job;
    assert.equal(w.importer.cancel(job.id), true);
    release();
    await assert.rejects(started, { code: 'cancelled' });
    assert.equal(w.calls.filter((c: any) => c[1] === 'cookies').length, 0, 'the cookies were never read');
    assert.equal(w.importer.job, null);
    // cancelled between start and run: run reports it
    const w2 = world();
    const s2 = await w2.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const job2 = w2.importer.job;
    job2.cancelled = true;
    const res = await w2.importer.run({ jobId: s2.jobId, sites: ['example.com'] });
    assert.deepEqual(res.cookies, { status: 'cancelled' });
  });

  test('a job nobody finishes expires and drops its cookies', async () => {
    const w = world({ jobMs: 5 });
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(w.importer.job, null);
    await assert.rejects(() => w.importer.run({ jobId: s.jobId }), { code: 'cancelled' });
    // an import cancelled while its cookies were being written stops and reports the category as cancelled
    const w2 = world();
    const s2 = await w2.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const orig = w2.ses.cookies.set;
    w2.ses.cookies.set = async (d: any) => {
      await orig(d);
      w2.importer.cancel(s2.jobId);
    };
    const res = await w2.importer.run({ jobId: s2.jobId, sites: ['example.com', 'chase.com', 'news.test'] });
    assert.deepEqual(res.cookies, { status: 'cancelled' });
  });
}

export function registerOverlappingJobs() {
  test('run twice at once (a double click): the second is refused and nothing is written twice', async () => {
    const w = world();
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const first = w.importer.run({ jobId: s.jobId, sites: ['example.com'] });
    await assert.rejects(() => w.importer.run({ jobId: s.jobId, sites: ['example.com'] }), { code: 'busy' });
    assert.equal((await first).cookies.status, 'ok');
    assert.equal(w.ses.log.filter((l: any) => l[0] === 'set').length, 1);
  });

  test('a job that is writing is not replaced: a second start is refused until it finishes', async () => {
    const w = world();
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const set = w.ses.cookies.set;
    w.ses.cookies.set = async (d: any) => {
      await gate;
      return set(d);
    };
    const running = w.importer.run({ jobId: s.jobId, sites: ['example.com'] });
    await assert.rejects(() => w.importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true } }), { code: 'busy' });
    release();
    assert.equal((await running).cookies.status, 'ok');
    assert.ok(await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true } }));
  });
}

export function registerQueuedCancellation() {
  test('BrowserImporter cancels a cookie import queued behind removal before any physical write', async () => {
    const w = world();
    const ledger = w.importer.o.ledger;
    let release!: () => void;
    const held = ledger.runCookieMutation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const start = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const running = w.importer.run({ jobId: start.jobId, sites: ['example.com'] });
    await new Promise((resolve) => setImmediate(resolve));
    w.importer.cancel(start.jobId);
    release();
    await held;
    assert.equal((await running).cookies.status, 'cancelled');
    assert.equal(w.ses.stored.size, 0);
    assert.deepEqual(ledger.sites(), []);
  });
}
