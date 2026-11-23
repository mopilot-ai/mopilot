// The Mac's record of sent messages: one run per key, the first reply for a repeat (also across a restart), a message begun but never finished reported as unsure once, entries that expire, and a record that never holds the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fs, tempDir } from './support/remoteKit.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { SendLedger, UNSURE, sharedLedger, dropSharedLedgers, beforeSend } = require('../electron/remote/sendLedger.cjs');

const ledgerAt = (file: string | null, o: Record<string, any> = {}) => new SendLedger({ file, fs, ...o });
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
// Waits for what a file read or the ledger's first await leads to. A bounded count of setImmediate ticks spins through the
// loop faster than a read completes on a loaded runner (main-unit-tests, #3278); a real timer lets the read finish.
const until = async (done: () => boolean | Promise<boolean>) => {
  await waitFor(async () => await done(), 'the condition');
};

test('unknown throws stay uncertain; a proven preparation rejection releases only after durable cleanup', async () => {
  const ledger = ledgerAt(path.join(tempDir(), 'sends.json'));
  let effects = 0;
  await assert.rejects(
    ledger.run('effect', 'x', async () => {
      effects++;
      throw new Error('lost acknowledgment');
    }),
    { code: 'send_uncertain' },
  );
  for (let n = 0; n < 4; n++)
    await assert.rejects(
      ledger.run('effect', 'x', async () => {
        effects++;
      }),
      { code: 'send_uncertain' },
    );
  assert.equal(effects, 1);
  let reject = true;
  const attempt = () =>
    ledger.run('prepared', 'x', () =>
      beforeSend(async (admit: () => void) => {
        if (reject) throw new Error('attachment unavailable');
        admit();
        return { sent: true };
      }),
    );
  await assert.rejects(attempt(), /attachment unavailable/);
  reject = false;
  assert.deepEqual(await attempt(), { sent: true });
  await assert.rejects(
    ledger.run('after-admission', 'x', () =>
      beforeSend(async (admit: () => void) => {
        admit();
        throw new Error('controller threw');
      }),
    ),
    { code: 'send_uncertain' },
  );
});

test('reservation failure refuses effects; completion failure remains uncertain across repeated restarts and health probes', async () => {
  const file = path.join(tempDir(), 'sends.json');
  let renames = 0;
  let failAt = 1;
  const failing = {
    ...fs,
    rename: async (...a: any[]) => {
      if (++renames === failAt) throw new Error('disk full');
      return (fs.rename as any)(...a);
    },
  };
  const ledger = new SendLedger({ file, fs: failing });
  let effects = 0;
  const effect = async () => {
    effects++;
    return { sent: true };
  };
  await assert.rejects(ledger.run('reservation', 'x', effect), { code: 'send_unavailable' });
  assert.equal(effects, 0);
  assert.equal(ledger.healthy, false);
  failAt = -1;
  assert.equal(await ledger.ready(), true, 'successful durable probe restores health');
  failAt = renames + 2;
  await assert.rejects(ledger.run('completion', 'x', effect), { code: 'send_uncertain' });
  assert.equal(effects, 1);
  for (let n = 0; n < 4; n++) {
    const next = ledgerAt(file);
    await assert.rejects(next.run('completion', 'x', effect), { code: 'send_uncertain' });
  }
  assert.equal(await ledger.ready(), true);
  await assert.rejects(ledger.run('completion', 'x', effect), { code: 'send_uncertain' });
  assert.equal(effects, 1);
});

test('failed durable release preserves the reservation; pending lookup wins over capacity and storage failure', async () => {
  const file = path.join(tempDir(), 'sends.json');
  let writes = 0;
  const failing = {
    ...fs,
    rename: async (...a: any[]) => {
      if (++writes >= 2) throw new Error('disk failed');
      return (fs.rename as any)(...a);
    },
  };
  const ledger = new SendLedger({ file, fs: failing, max: 1 });
  const make = () =>
    beforeSend(async () => {
      throw new Error('preparation refused');
    });
  await assert.rejects(ledger.run('a', 'x', make), { code: 'send_unavailable' });
  assert.equal(await ledger.ready(), false);
  await assert.rejects(ledger.run('a', 'x', make), { code: 'send_uncertain' });
  await assert.rejects(ledger.run('a', 'other', make), { code: 'send_conflict' });
  await assert.rejects(ledger.run('b', 'x', make), { code: 'send_capacity' });
  await assert.rejects(ledgerAt(file).run('a', 'x', make), { code: 'send_uncertain' });
});

test('overlapping whole-ledger saves and probes never turn a failed completion into another effect', async () => {
  const file = path.join(tempDir(), 'sends.json');
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  let writes = 0;
  const storage = {
    ...fs,
    rename: async (...args: any[]) => {
      if (++writes === 2) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error('A completion failed');
      }
      return (fs.rename as any)(...args);
    },
  };
  const ledger = new SendLedger({ file, fs: storage });
  let effects = 0;
  const a = ledger.run('a', 'x', async () => {
    effects++;
    return { sent: true, warning: 'A' };
  });
  const failed = assert.rejects(a, { code: 'send_uncertain' });
  await blocked;
  const b = ledger.run('b', 'y', async () => ({ sent: true, warning: 'B' }));
  const probes = Promise.all([ledger.ready(), ledger.ready()]);
  release();
  await failed;
  await b;
  await probes;
  for (let n = 0; n < 5; n++) {
    const restarted = ledgerAt(file);
    await restarted.load();
    const state = restarted.entries.get('a');
    const retry = restarted.run('a', 'x', async () => {
      effects++;
      assert.fail('redispatched A');
    });
    if (state.state === 'done') assert.deepEqual(await retry, { sent: true, warning: 'A' });
    else await assert.rejects(retry, { code: 'send_uncertain' });
  }
  assert.equal(effects, 1);
  const before = writes;
  assert.equal(await ledger.ready(), true);
  assert.equal(writes, before, 'healthy hello does not rewrite the full ledger');
});

test('concurrent readiness probes coalesce; pre-admission release and a probe cannot reopen an executing reservation', async () => {
  const file = path.join(tempDir(), 'sends.json');
  let renames = 0;
  const storage = {
    ...fs,
    rename: async (...args: any[]) => {
      renames++;
      return (fs.rename as any)(...args);
    },
  };
  const ledger = new SendLedger({ file, fs: storage });
  assert.deepEqual(await Promise.all([ledger.ready(), ledger.ready(), ledger.ready()]), [true, true, true]);
  assert.equal(renames, 1);
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reject!: (error: Error) => void;
  const pending = ledger.run('rejected', 'x', () =>
    beforeSend(async () => {
      started();
      await new Promise<void>((_resolve, r) => {
        reject = r;
      });
    }),
  );
  const failed = assert.rejects(pending, /preparation refused/);
  await began;
  const duplicate = ledger.run('rejected', 'x', async () => assert.fail('overlap'));
  const duplicateFailed = assert.rejects(duplicate, /preparation refused/);
  reject(new Error('preparation refused'));
  await Promise.all([failed, duplicateFailed, ledger.ready()]);
  assert.deepEqual(await ledger.run('rejected', 'x', async () => ({ sent: true })), { sent: true });
});

test('a message runs once; a repeat gets the first reply, and another text under its key is refused', async () => {
  const ledger = ledgerAt(null);
  let runs = 0;
  const make = async () => ({ sent: true, warning: `n${++runs}` });
  assert.deepEqual(await ledger.run('p:c:1', 'a', make), { sent: true, warning: 'n1' });
  assert.deepEqual(await ledger.run('p:c:1', 'a', make), { sent: true, warning: 'n1' }, 'the original receipt, not a second turn');
  assert.equal(runs, 1);
  await assert.rejects(ledger.run('p:c:1', 'other', make), (e: any) => e.code === 'send_conflict' && /different message/.test(e.message));
  assert.deepEqual(await ledger.run('p:c:2', 'a', make), { sent: true, warning: 'n2' }, 'keys are separate');
});

test('a repeat while the first still runs shares its outcome, and a failed send may be tried again', async () => {
  const ledger = ledgerAt(null);
  let release: () => void = () => undefined;
  let runs = 0;
  const slow = ledger.run('k', 'a', async () => {
    runs++;
    await new Promise<void>((r) => (release = r));
    return { sent: true };
  });
  await until(() => runs > 0);
  const again = ledger.run('k', 'a', async () => ({ sent: false }));
  await tick();
  release();
  assert.deepEqual(await Promise.all([slow, again]), [{ sent: true }, { sent: true }]);
  assert.equal(runs, 1);
  let tries = 0;
  const refuse = () =>
    ledger.run('bad', 'a', () =>
      beforeSend(async () => {
        tries++;
        throw new Error('refused');
      }),
    );
  await assert.rejects(refuse(), /refused/);
  await assert.rejects(refuse(), /refused/);
  assert.equal(tries, 2, 'a refusal is not remembered');
});

test('a finished send answers a repeat after the Mac restarted, from the file, without the text in it', async () => {
  const file = path.join(tempDir(), 'sends.json');
  const first = ledgerAt(file);
  await first.run('p:c:1', 'secret message text', async () => ({ sent: true, warning: 'queued behind another' }));
  const raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /secret message text/);
  const restarted = ledgerAt(file);
  let runs = 0;
  assert.deepEqual(await restarted.run('p:c:1', 'secret message text', async () => (runs++, { sent: true })), {
    sent: true,
    warning: 'queued behind another',
  });
  assert.equal(runs, 0);
  await assert.rejects(
    restarted.run('p:c:1', 'changed', async () => ({})),
    /different message/,
  );
});

test('a send begun before the Mac stopped and never finished remains uncertain on every replay', async () => {
  const file = path.join(tempDir(), 'sends.json');
  const crashed = ledgerAt(file);
  void crashed.run('p:c:1', 'hello', () => new Promise(() => undefined)).catch(() => undefined);
  // the Mac stops once the record of the attempt is on disk
  await until(async () => (await fs.readFile(file, 'utf8').catch(() => '')).includes('pending'));
  const restarted = ledgerAt(file);
  let runs = 0;
  const make = async () => (runs++, { sent: true });
  await assert.rejects(restarted.run('p:c:1', 'hello', make), (e: any) => e.code === 'send_uncertain' && e.message === UNSURE);
  assert.equal(runs, 0, 'the harness is not asked on the phone’s say-so');
  for (let n = 0; n < 5; n++) await assert.rejects(restarted.run('p:c:1', 'hello', make), { code: 'send_uncertain' });
  assert.equal(runs, 0);
  const reread = ledgerAt(file);
  await assert.rejects(reread.run('p:c:1', 'hello', make), { code: 'send_uncertain' });
  assert.equal(reread.entries.get('p:c:1').state, 'pending');
});

test('capacity refuses new ids without evicting completed or pending identities, regardless of elapsed time', async () => {
  let now = 1000;
  const ledger = ledgerAt(null, { now: () => now, max: 1 });
  await ledger.run('a', 'x', async () => ({ n: 1 }));
  now += 100 * 86_400_000;
  assert.deepEqual(await ledger.run('a', 'x', async () => assert.fail('duplicate')), { n: 1 });
  await assert.rejects(
    ledger.run('b', 'x', async () => assert.fail('full')),
    { code: 'send_capacity' },
  );
});

test('missing is empty; unreadable, corrupt, foreign and partially invalid records are preserved and block dispatch', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'sends.json');
  const missing = ledgerAt(file);
  assert.equal(await missing.ready(), true);
  const corrupt = [
    '{not json',
    JSON.stringify({ v: 99, entries: [] }),
    JSON.stringify({ v: 1, entries: [['a', { print: 'h', state: 'weird', at: 1 }]] }),
    JSON.stringify({ v: 1, entries: [null] }),
    JSON.stringify({ v: 1, entries: [[7, {}]] }),
  ];
  for (const text of corrupt) {
    await fs.writeFile(file, text);
    const ledger = ledgerAt(file);
    assert.equal(await ledger.ready(), false);
    await assert.rejects(
      ledger.run('k', 'x', async () => assert.fail('unreadable')),
      { code: 'send_unavailable' },
    );
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
  const unreadable = ledgerAt(dir);
  assert.equal(await unreadable.ready(), false);
  await assert.rejects(
    unreadable.run('k', 'x', async () => assert.fail('unreadable')),
    { code: 'send_unavailable' },
  );
});

test('the default clock, lifetime and note are used when none are given', async () => {
  const ledger = new SendLedger();
  assert.deepEqual(await ledger.run('k', 'x', async () => ({ ok: 1 })), { ok: 1 });
  assert.equal(ledger.max, 1000);
  ledger.note('anything', new Error('x'));
});

test('one ledger per file in a process, so Mobile Remote starting again cannot split a send still running; the end of the process resets it', async () => {
  const file = path.join(tempDir(), 'sends.json');
  const a = sharedLedger(file, { fs });
  assert.equal(sharedLedger(file, { fs }), a);
  assert.notEqual(sharedLedger(path.join(tempDir(), 'sends.json'), { fs }), a);
  let release: (() => void) | null = null;
  // wait for the send to actually start (the ledger reads its record first, which takes as long as the disk takes), not for a count of ticks
  let started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  const running = a.run(
    'p:c:1',
    'x',
    () =>
      new Promise<any>((r) => {
        release = () => r({ sent: true });
        started();
      }),
  );
  await began;
  // a second start gets the same ledger, so the repeat shares the running send instead of being called unsure
  assert.equal(sharedLedger(file, { fs }), a);
  const repeat = sharedLedger(file, { fs }).run('p:c:1', 'x', async () => ({ sent: false }));
  release!();
  assert.deepEqual(await Promise.all([running, repeat]), [{ sent: true }, { sent: true }]);
  dropSharedLedgers();
  assert.notEqual(sharedLedger(file, { fs }), a);
});

test('the record is read when the first message needs it, once', async () => {
  let reads = 0;
  const counting = { ...fs, readFile: async (...a: any[]) => (reads++, (fs.readFile as any)(...a)) };
  const ledger = new SendLedger({ file: path.join(tempDir(), 'sends.json'), fs: counting });
  assert.equal(reads, 0);
  await ledger.run('a', 'x', async () => ({}));
  await ledger.run('b', 'x', async () => ({}));
  assert.equal(reads, 1);
});

test('with encryption the record on disk is sealed: no text, no hash, and a restart reads it back', async () => {
  const { fakeSafe } = await import('./support/remoteKit.ts');
  const file = path.join(tempDir(), 'sends.json');
  const safe = fakeSafe();
  const first = new SendLedger({ file, fs, safe });
  await first.run('p:c:1', 'a secret sentence', async () => ({ sent: true, warning: null }));
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(onDisk.trimStart().startsWith('{'), false, 'plain JSON on disk');
  assert.equal(onDisk.includes('p:c:1'), false);
  assert.equal(onDisk.includes(require('node:crypto').createHash('sha256').update('a secret sentence').digest('hex')), false);
  let runs = 0;
  const second = new SendLedger({ file, fs, safe });
  assert.deepEqual(await second.run('p:c:1', 'a secret sentence', async () => (runs++, { sent: false })), { sent: true, warning: null });
  assert.equal(runs, 0, 'the sealed record answered the repeat');
});

test('a record from before sealing is still read, and the next save seals it', async () => {
  const { fakeSafe } = await import('./support/remoteKit.ts');
  const file = path.join(tempDir(), 'sends.json');
  const plain = new SendLedger({ file, fs });
  await plain.run('p:c:1', 'x', async () => ({ sent: true }));
  assert.equal((await fs.readFile(file, 'utf8')).trimStart().startsWith('{'), true);
  const safe = fakeSafe();
  const sealed = new SendLedger({ file, fs, safe });
  assert.deepEqual(await sealed.run('p:c:1', 'x', async () => ({ sent: false })), { sent: true });
  await sealed.run('p:c:2', 'y', async () => ({ sent: true }));
  assert.equal((await fs.readFile(file, 'utf8')).trimStart().startsWith('{'), false);
});

test('without encryption no send is admitted and readiness stays false', async () => {
  const { fakeSafe } = await import('./support/remoteKit.ts');
  const file = path.join(tempDir(), 'sends.json');
  const ledger = new SendLedger({ file, fs, safe: fakeSafe({ available: false }) });
  assert.equal(await ledger.ready(), false);
  await assert.rejects(
    ledger.run('k', 'x', async () => assert.fail('no encryption')),
    { code: 'send_unavailable' },
  );
  await assert.rejects(fs.readFile(file, 'utf8'), { code: 'ENOENT' });
});

test('a record that cannot be decrypted is kept intact and never overwritten by a new send', async () => {
  const { fakeSafe } = await import('./support/remoteKit.ts');
  const file = path.join(tempDir(), 'sends.json');
  const safe = fakeSafe();
  await new SendLedger({ file, fs, safe }).run('k', 'x', async () => ({ sent: true }));
  const sealed = await fs.readFile(file, 'utf8');
  const other = {
    ...safe,
    decryptString: () => {
      throw new Error('cannot decrypt');
    },
  };
  const ledger = new SendLedger({ file, fs, safe: other as any });
  await assert.rejects(
    ledger.run('k2', 'y', async () => assert.fail('unknown history')),
    { code: 'send_unavailable' },
  );
  assert.equal(await fs.readFile(file, 'utf8'), sealed);
});
