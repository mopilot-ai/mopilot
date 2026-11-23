// Updater unit cases for downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mock,
  calls,
  autoUpdater,
  API_BASE,
  ZIP,
  feedBody,
  offer,
  LOOPBACK,
  fakeDownload,
  make,
  checked,
  deferred,
  responses,
} from './fixture.ts';
import { waitFor } from '../waitFor.ts';

export function registerDownloads() {
  test('a native feed configuration failure closes its feed before retrying', async (t) => {
    const feeds: { closed: number }[] = [];
    const { u } = make({
      serve: async () => {
        const feed = { closed: 0 };
        feeds.push(feed);
        return {
          feedUrl: LOOPBACK,
          close: () => {
            feed.closed++;
          },
        };
      },
    });
    const failed = t.mock.method(autoUpdater, 'setFeedURL', () => {
      throw new Error('native feed refused');
    });
    try {
      await checked(u);
      assert.equal(u.state.status, 'error');
      assert.equal(u.state.error, 'native feed refused');
      assert.equal(feeds[0].closed, 1);
      assert.equal(u.served, null);
      assert.equal(u.nativeOperation, null);
      failed.mock.restore();
      await checked(u);
      assert.equal(u.state.preparing, true);
      assert.equal(feeds.length, 2);
      assert.equal(feeds[1].closed, 0);
      autoUpdater.emit('update-not-available');
      assert.equal(feeds[1].closed, 1);
    } finally {
      u.dispose();
    }
  });

  test('a feed close failure does not mask configuration failure or retain the feed', async (t) => {
    const { u } = make({
      serve: async () => ({
        feedUrl: LOOPBACK,
        close: () => {
          throw new Error('close failed');
        },
      }),
    });
    t.mock.method(autoUpdater, 'setFeedURL', () => {
      throw new Error('native feed refused');
    });
    try {
      await checked(u);
      assert.equal(u.state.error, 'native feed refused');
      assert.equal(u.served, null);
    } finally {
      u.dispose();
    }
  });

  test('feed close errors cannot interrupt native completion or shutdown timer cleanup', async (t) => {
    const clear = t.mock.method(globalThis, 'clearTimeout');
    for (const terminal of [true, false]) {
      const { u } = make({
        serve: async () => ({
          feedUrl: LOOPBACK,
          close: () => {
            throw new Error('close failed');
          },
        }),
      });
      try {
        await checked(u);
        const nativeTimeout = u.nativeTimeout;
        if (terminal) {
          assert.doesNotThrow(() => autoUpdater.emit('update-not-available'));
          assert.equal(u.state.status, 'idle');
          assert.equal(u.nativeOperation, null);
        } else {
          assert.doesNotThrow(() => u.dispose());
        }
        assert.equal(u.served, null);
        assert.ok(clear.mock.calls.some((call) => call.arguments[0] === nativeTimeout));
      } finally {
        u.dispose();
      }
    }
  });

  test('the download shows its progress, at most twice a second, and a failed one is reported with why', async () => {
    let progress: (received: number, total: number | null) => void = () => {};
    const done = deferred<string>();
    const { u, seen } = make({
      download: (o: any) => ((progress = o.onProgress), done.promise),
    });
    const s = await u.check();
    assert.equal(s.status, 'downloading');
    assert.deepEqual(s.progress, { version: '2.0.0', received: 0, total: null });
    assert.equal(s.preparing, false);
    const now = mock.method(Date, 'now', () => 1_000_000);
    try {
      progress(5, 100);
      const shown = seen.length;
      assert.deepEqual(u.state.progress, { version: '2.0.0', received: 5, total: 100 });
      progress(6, 100);
      assert.equal(seen.length, shown, 'throttled');
      progress(100, 100);
      assert.deepEqual(u.state.progress, { version: '2.0.0', received: 100, total: 100 }, 'the last byte is always shown');
      // a scheduled or manual check while downloading leaves it alone
      assert.equal(await u.check({ manual: true }), u.state);
    } finally {
      now.mock.restore();
    }
    done.reject(new Error('Update download stalled: example.test sent no data for 60 seconds. Check again to resume it.'));
    await u.downloadWork;
    assert.equal(u.state.status, 'error');
    assert.match(u.state.error, /stalled/);
    assert.equal('progress' in u.state, false);
    assert.equal(u.download, null);
    u.dispose();
  });

  test('a channel switch or dispose aborts the download, and its late result changes nothing', async () => {
    for (const change of ['channel', 'dispose', 'late-progress']) {
      const signals: AbortSignal[] = [];
      let progress: (received: number, total: number | null) => void = () => {};
      const done = deferred<string>();
      const { u } = make({ download: (o: any) => (signals.push(o.signal), (progress = o.onProgress), done.promise) });
      await u.check();
      if (change === 'dispose') u.dispose();
      else u.configure({ auto: false, channel: 'beta' });
      assert.equal(signals[0].aborted, true, change);
      const before = u.state;
      progress(50, 100);
      if (change === 'late-progress') done.resolve('/tmp/update.zip');
      else done.reject(new Error('aborted'));
      await u.downloadWork;
      assert.equal(u.state, before, change);
      assert.equal(
        calls.some((c) => c[0] === 'serve'),
        false,
      );
      u.dispose();
    }
  });

  test('a newer check waits for an aborted download to finish closing its file', async () => {
    const order: string[] = [];
    const first = deferred<string>();
    let n = 0;
    const { u } = make({
      download: (o: any) => {
        n++;
        order.push(`start ${n}`);
        return n === 1 ? first.promise : fakeDownload(o);
      },
    });
    await u.check();
    u.configure({ auto: false, channel: 'beta' });
    u.configure({ auto: false, channel: 'stable' });
    await u.check();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ['start 1']);
    first.reject(new Error('aborted'));
    await u.downloadWork;
    assert.deepEqual(order, ['start 1', 'start 2']);
    assert.equal(u.state.preparing, true);
    u.dispose();
  });

  test('the hand-off to Squirrel: a serve failure, a stale finish and a still-running old check', async () => {
    // the loopback server could not start
    let { u } = make({
      serve: async () => {
        throw new Error('EADDRNOTAVAIL');
      },
    });
    await checked(u);
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.error, 'EADDRNOTAVAIL');
    u.dispose();

    // the channel changed while the server was starting: it is closed again, and Squirrel is not asked
    const served = deferred<any>();
    ({ u } = make({ serve: () => served.promise }));
    await u.check();
    await new Promise((r) => setImmediate(r));
    u.configure({ auto: false, channel: 'beta' });
    calls.length = 0;
    served.resolve({ feedUrl: LOOPBACK, close: () => calls.push(['close']) });
    await u.downloadWork;
    assert.deepEqual(calls, [['close']]);
    u.dispose();

    // an old Squirrel run still owns the engine: say so instead of staying "Downloading"
    const later = deferred<any>();
    ({ u } = make({ serve: () => later.promise }));
    await u.check();
    await new Promise((r) => setImmediate(r));
    u.nativeOperation = { generation: -1, channel: 'stable', timedOut: true };
    calls.length = 0;
    later.resolve({ feedUrl: LOOPBACK, close: () => calls.push(['close']) });
    await u.downloadWork;
    assert.deepEqual(calls, [['close']]);
    assert.equal(u.state.status, 'error');
    assert.match(u.state.error, /previous update check is still finishing/);
    u.dispose();
  });

  test('the sign-in goes to the update file only when MoPilot hosts it', async () => {
    const { u } = make({ token: async () => 'tok' });
    u.configure({ auto: false, channel: 'beta' });
    const own = `${API_BASE}/dl/releases/2.0.0/MoPilot-2.0.0-arm64.zip`;
    for (const [url, headers] of [
      [ZIP, {}],
      [own, { authorization: 'Bearer tok' }],
    ] as const) {
      responses.fetchImpl = async () => feedBody({ url, name: '2.0.0', notes: '' });
      calls.length = 0;
      await checked(u);
      assert.deepEqual(
        calls.find((c) => c[0] === 'download'),
        ['download', url, headers],
      );
      autoUpdater.emit('update-not-available');
    }
    u.dispose();
  });

  test('a channel switch while the feed is being read drops its answer', async () => {
    const feed = deferred<any>();
    responses.fetchImpl = () => feed.promise;
    const { u } = make();
    const pending = u.check();
    await new Promise((r) => setImmediate(r));
    u.configure({ auto: false, channel: 'beta' });
    feed.resolve(await offer());
    await pending;
    assert.equal(u.state.status, 'idle');
    assert.equal(
      calls.some((c) => c[0] === 'download'),
      false,
    );
    u.dispose();
  });

  test('by default the update is downloaded with net.fetch and served to Squirrel on loopback', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    const bytes = new Uint8Array([1, 2, 3]);
    responses.fetchImpl = async (url: string) => {
      if (url !== ZIP) return offer();
      let sent = false;
      return {
        status: 200,
        headers: new Headers({ 'content-length': '3', etag: '"e"' }),
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })) }) },
      };
    };
    const { u } = make({ downloadDir: dir, download: undefined, serve: undefined });
    await checked(u);
    assert.equal(u.state.preparing, true);
    const feedUrl = calls.find((c) => c[0] === 'feed')[1].url;
    const feed = await (await fetch(feedUrl)).json();
    assert.equal(feed.name, '2.0.0');
    assert.deepEqual(new Uint8Array(await (await fetch(feed.url)).arrayBuffer()), bytes);
    autoUpdater.emit('update-not-available');
    u.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a finished update removes the downloaded copy Squirrel has unpacked', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    fs.writeFileSync(path.join(dir, 'x.zip'), 'zip');
    const { u } = make({ downloadDir: dir });
    await checked(u);
    autoUpdater.emit('update-downloaded', {}, '', '2.0.0');
    await waitFor(() => !fs.existsSync(dir), 'the download dir to be removed');
    assert.equal(fs.existsSync(dir), false);
    u.dispose();
    // the default directory is under the app's user data
    assert.equal(make().u.downloadDir(), '/nonexistent-mopilot-test/userData/update-download');
  });
}
