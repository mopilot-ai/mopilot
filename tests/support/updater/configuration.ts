// Updater unit cases for configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock, calls, autoUpdater, app, setPlatform, ZIP, feedBody, LOOPBACK, make, checked, responses } from './fixture.ts';

export function registerConfiguration() {
  test('configure: channel is normalised, schedule restarts only on change, first check then interval', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const random = mock.method(Math, 'random', () => 0);
    try {
      const { u } = make();
      await u.ready;
      let checks = 0;
      u.check = async () => (checks++, u.state);
      u.configure({ channel: 'nightly' });
      assert.equal(u.channel, 'stable');
      assert.equal(u.feedUrl(), 'https://raw.githubusercontent.com/mopilot-ai/mopilot-code-release/main/updates/stable.json');
      assert.equal(u.configure(), u.state); // unchanged prefs: nothing restarts
      assert.deepEqual(calls, [], 'Squirrel is never pointed at the server');
      mock.timers.tick(10_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(checks, 1);
      mock.timers.tick(60_000);
      assert.equal(checks, 2);
      u.configure({ auto: false, channel: 'beta' });
      assert.equal(u.channel, 'beta');
      mock.timers.tick(5 * 3600_000);
      assert.equal(checks, 2);
      u.configure({ auto: true, channel: 'dogfood' });
      assert.equal(u.channel, 'dogfood');
      u.dispose();
      mock.timers.tick(5 * 3600_000);
      assert.equal(checks, 2);
    } finally {
      random.mock.restore();
      mock.timers.reset();
    }
  });

  test('mac check: busy states and silent scheduled checks outside /Applications do nothing', async () => {
    const { u } = make();
    for (const status of ['checking', 'downloading', 'ready']) {
      u.state.status = status;
      assert.equal(await u.check({ manual: true }), u.state);
    }
    u.state.status = 'idle';
    app.inApps = false;
    await u.check();
    assert.deepEqual(calls, []);
  });

  test('mac check in /Applications asks the feed with sign-in headers for beta, downloads, and hands off to Squirrel', async () => {
    const { u } = make({ token: async () => 'tok' });
    u.configure({ auto: false, channel: 'beta' });
    calls.length = 0;
    await checked(u);
    assert.deepEqual(calls, [
      ['fetch', u.feedUrl('beta'), { accept: 'application/json', authorization: 'Bearer tok' }],
      ['download', ZIP, {}],
      ['serve', { name: '2.0.0', notes: 'n', pub_date: undefined }],
      ['feed', { url: LOOPBACK, serverType: 'json' }],
      ['checkForUpdates'],
    ]);
    responses.fetchImpl = async () => feedBody({ url: ZIP, name: '2.0.0', notes: '', pub_date: '2026-10-14T07:04:39.407Z' });
    autoUpdater.emit('update-not-available');
    calls.length = 0;
    await checked(u);
    assert.deepEqual(calls[2], ['serve', { name: '2.0.0', notes: '', pub_date: '2026-10-14T07:04:39.407Z' }]);

    u.channel = 'stable';
    assert.deepEqual(await u.authHeaders(), {});
    u.channel = 'beta';
    u.o.token = async () => null; // signed out: asked without the header
    assert.deepEqual(await u.authHeaders(), {});
    u.o.token = undefined;
    assert.deepEqual(await u.authHeaders(), {});
  });

  test('a sign-in that cannot be read fails a beta check with the reason, instead of passing for up to date', async () => {
    const { u } = make({
      token: async () => {
        throw new Error('keychain locked');
      },
    });
    u.configure({ auto: false, channel: 'beta' });
    calls.length = 0;
    const s = await u.check();
    assert.equal(s.status, 'error');
    assert.equal(s.error, 'Could not check the beta channel: your MoPilot sign-in could not be read (keychain locked)');
    assert.equal(
      calls.some((c) => c[0] === 'checkForUpdates'),
      false,
    );
    // Windows reads the feed itself: the same failure ends its check the same way
    setPlatform('win32');
    const w = make({
      token: async () => {
        throw 'no token';
      },
    }).u;
    w.configure({ auto: false, channel: 'dogfood' });
    const ws = await w.check();
    assert.equal(ws.status, 'error');
    assert.match(ws.error, /dogfood channel: .*\(no token\)$/);
  });

  test('manual mac check outside /Applications asks to move: accept moves and checks, Not Now blocks later checks', async () => {
    app.inApps = false;
    const { u } = make();
    await checked(u, { manual: true });
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['dialog', 'move', 'fetch', 'download', 'serve', 'feed', 'checkForUpdates'],
    );
    autoUpdater.emit('update-not-available');

    calls.length = 0;
    responses.dialogResponse = 1;
    const s = await u.check({ manual: true });
    assert.equal(u.declinedMove, true);
    assert.equal(s.status, 'error');
    assert.match(s.error, /Applications folder/);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['dialog'],
    );

    calls.length = 0;
    u.state.status = 'idle';
    assert.equal((await u.check({ manual: true })).status, 'error');
    assert.deepEqual(calls, []);
  });
}
