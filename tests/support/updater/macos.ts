// Updater unit cases for macos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  calls,
  autoUpdater,
  app,
  Updater,
  ENDPOINTS,
  HOST,
  setPlatform,
  feedBody,
  LOOPBACK,
  make,
  checked,
  responses,
  deferred,
} from './fixture.ts';

export function registerMacos() {
  test('unpackaged and unsupported platforms never check', async () => {
    app.isPackaged = false;
    const { u } = make();
    assert.equal(u.state.status, 'unsupported');
    assert.equal(await u.ready, false);
    assert.equal(u.configure({ auto: true }), u.state);
    assert.equal((await u.check({ manual: true })).status, 'unsupported');
    app.isPackaged = true;
    setPlatform('freebsd');
    assert.equal(make().u.state.status, 'unsupported');
    // the build's own MoPilot endpoints unless a test names others
    assert.equal(
      new Updater({ installId: 'x', broadcast: () => {} }).endpoints,
      createRequire(import.meta.url)('../../../electron/platform/mopilotEndpoints.cjs').endpoints,
    );
    // a packaged build without the MoPilot service (the open-source edition) checks for no update on any platform
    for (const platform of ['darwin', 'win32', 'linux']) {
      setPlatform(platform);
      const none = make({ endpoints: null }).u;
      assert.equal(none.state.status, 'unsupported', platform);
      assert.equal((await none.check({ manual: true })).status, 'unsupported', platform);
    }
    assert.deepEqual(calls, []);
  });

  test('a build without a Developer ID signature becomes unsupported; the signature is read with codesign by default', async () => {
    const { u, seen } = make({ team: async () => null });
    assert.equal(await u.ready, false);
    assert.equal(u.supported, false);
    assert.equal(seen.at(-1).status, 'unsupported');
    assert.equal((await u.check()).status, 'unsupported');

    // codesign reads the .app bundle that holds the running executable, not the folder the app is installed in
    const execPath = process.execPath;
    process.execPath = '/Applications/MoPilot.app/Contents/MacOS/MoPilot';
    try {
      const d = new Updater({ installId: 'x', broadcast: () => {}, endpoints: ENDPOINTS });
      assert.equal(await d.ready, true);
      assert.deepEqual(
        calls.filter((c) => c[0] === 'exec'),
        [['exec', 'codesign', '-dvv', '/Applications/MoPilot.app']],
      );
      responses.codesignStderr = 'TeamIdentifier=not set\n';
      assert.equal(await new Updater({ installId: 'x', broadcast: () => {}, endpoints: ENDPOINTS }).ready, false);
      // a dev build signed with Apple Development has a team, but its designated requirement pins that certificate,
      // so Squirrel would reject every Developer ID release ("code failed to satisfy specified code requirement(s)")
      responses.codesignStderr =
        'Authority=Apple Development: Dev (29RC33CGL6)\nAuthority=Apple Worldwide Developer Relations Certification Authority\nTeamIdentifier=TEAM123456\n';
      const dev = new Updater({ installId: 'x', broadcast: () => {}, endpoints: ENDPOINTS });
      assert.equal(await dev.ready, false);
      assert.equal(dev.state.status, 'unsupported');
    } finally {
      process.execPath = execPath;
    }
  });

  test('a signature codesign could not read is an error, not unsupported, and the next check reads it again', async () => {
    let reads = 0;
    const { u, seen } = make({
      team: async () => {
        if (++reads === 1) throw new Error("codesign couldn't read /Applications: bundle format unrecognized");
        return 'TEAM';
      },
    });
    assert.equal(await u.ready, false);
    assert.equal(u.supported, true, 'updates stay on: nothing is known about the signature yet');
    assert.equal(seen.at(-1).status, 'error');
    assert.match(seen.at(-1).error, /Check for updates to try again/);
    await checked(u, { manual: true });
    assert.equal(reads, 2);
    assert.equal(u.state.status, 'downloading', 'the check read the signature again and went on to the update');
    await checked(u);
    assert.equal(reads, 2, 'a signature that was read is not read again');
  });

  test('a signature read after one codesign could not read clears that error, even when the check then stops early', async () => {
    let reads = 0;
    const { u } = make({
      team: async () => {
        if (++reads === 1) throw new Error('timed out');
        return 'TEAM';
      },
    });
    await u.ready;
    assert.equal(u.state.status, 'error');
    // a scheduled check outside /Applications stops before the feed
    app.inApps = false;
    await u.check();
    assert.equal(reads, 2);
    assert.equal(u.state.status, 'idle');
    assert.equal(u.state.error, null);
    // any other error is the check's own and stays
    u.set({ status: 'error', error: 'Update check failed.' });
    await u.check();
    assert.equal(u.state.error, 'Update check failed.');
  });

  test('a retired updater leaves no state for a signature codesign could not read', async () => {
    const team = deferred<string | null>();
    const retired = make({ team: () => team.promise });
    retired.u.dispose();
    team.reject(new Error('timed out'));
    assert.equal(await retired.u.ready, false);
    assert.equal(retired.seen.length, 0);
  });

  test('Squirrel unpacking the downloaded update maps onto the broadcast state', async () => {
    const { u, seen } = make();
    await u.ready;
    await checked(u);
    assert.deepEqual(calls.slice(-2), [['feed', { url: LOOPBACK, serverType: 'json' }], ['checkForUpdates']]);
    assert.equal(u.state.status, 'downloading');
    assert.equal(u.state.preparing, true);
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available');
    assert.equal(u.state.status, 'downloading');
    assert.equal(u.state.preparing, true);
    autoUpdater.emit('update-not-available');
    assert.equal(u.state.status, 'idle');
    assert.equal(typeof u.state.checkedAt, 'number');
    assert.equal('progress' in u.state || 'preparing' in u.state, false, 'progress belongs to downloading only');
    assert.equal(calls.at(-1)[0], 'close', 'the loopback server is closed when Squirrel is done');
    await checked(u);
    autoUpdater.emit('update-downloaded', {}, 'notes!', '2.0.0');
    assert.deepEqual(u.state.available, { version: '2.0.0', notes: 'notes!' });
    u.state.status = 'idle';
    await checked(u);
    autoUpdater.emit('update-downloaded', {}, undefined, '2.0.1');
    assert.deepEqual(u.state.available, { version: '2.0.1', notes: '' });
    assert.ok(seen.length > 8);
    u.dispose();
  });

  test('native errors retain Error, plain, and null failure reasons', async () => {
    const { u } = make();
    for (const [error, expected] of [
      [new Error('boom'), 'Boom.'],
      ['plain', 'Plain.'],
      [null, 'Something went wrong.'],
      // Squirrel's error domain and number read as a sentence (#1863)
      [new Error('The operation couldn’t be completed. (SQRLUpdaterErrorDomain error 8.)'), 'The operation couldn’t be completed.'],
    ]) {
      await checked(u);
      autoUpdater.emit('error', error);
      assert.equal(u.state.error, expected);
    }
    u.dispose();
  });

  test('a macOS feed failure names the server and the status or network error, and downloads nothing', async () => {
    const { u } = make();
    u.configure({ auto: false, channel: 'beta' });
    for (const [reply, expected] of [
      [
        { status: 403, ok: false },
        `Update check failed: ${HOST} answered HTTP 403. A proxy or firewall on this network may be blocking it.`,
      ],
      [
        { status: 407, ok: false },
        `Update check failed: ${HOST} answered HTTP 407. A proxy or firewall on this network may be blocking it.`,
      ],
      [{ status: 502, ok: false }, `Update check failed: ${HOST} answered HTTP 502. Try again later.`],
      [{ status: 404, ok: false }, `Update check failed: ${HOST} answered HTTP 404.`],
      [new Error('net::ERR_PROXY_CONNECTION_FAILED'), `Update check failed: could not reach ${HOST}. Network error.`],
      [
        { status: 200, ok: true, json: async () => Promise.reject(new SyntaxError('bad json')) },
        `Update check failed: ${HOST} sent an update feed that could not be read (bad json).`,
      ],
      [feedBody({ url: 'http://insecure/x.zip' }), 'The update feed returned no update file'],
      [feedBody(null), 'The update feed returned no update file'],
    ] as const) {
      responses.fetchImpl = async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      };
      calls.length = 0;
      const s = await u.check();
      assert.equal(s.status, 'error');
      assert.equal(s.error, expected);
      assert.deepEqual(
        calls.map((c) => c[0]),
        ['fetch'],
      );
    }
    // up to date: the feed's 204
    responses.fetchImpl = async () => ({ status: 204 });
    assert.equal((await u.check()).status, 'idle');
    u.dispose();
  });
}
