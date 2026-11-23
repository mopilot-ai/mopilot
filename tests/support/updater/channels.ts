// Updater unit cases for channels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, autoUpdater, lastDialog, HOST, setPlatform, make, checked, deferred, responses } from './fixture.ts';

export function registerChannels() {
  test('a channel change during token discovery cannot restore the previous native feed or start it', async () => {
    const token = deferred<string>();
    const { u } = make({ token: () => token.promise });
    u.configure({ auto: false, channel: 'beta' });
    const pending = u.check();
    await new Promise((r) => setImmediate(r));
    u.configure({ auto: false, channel: 'stable' });
    calls.length = 0;
    token.resolve('token');
    await pending;
    assert.equal(calls.length, 0);
    assert.equal(u.state.status, 'idle');
    u.dispose();
  });

  test('Windows replies and failures are discarded after a channel switch at every await', async () => {
    setPlatform('win32');
    for (const stage of ['token', 'fetch', 'json']) {
      for (const fails of [false, true]) {
        const gate = deferred<any>();
        const { u } = make({ token: stage === 'token' ? () => gate.promise : async () => null });
        responses.fetchImpl =
          stage === 'fetch'
            ? () => gate.promise
            : async () => ({
                status: 200,
                ok: true,
                json: () => (stage === 'json' ? gate.promise : Promise.resolve({ url: 'https://old/Setup.exe' })),
              });
        u.configure({ auto: false, channel: 'beta' });
        const pending = u.check();
        await new Promise((r) => setImmediate(r));
        u.configure({ auto: false, channel: 'stable' });
        calls.length = 0;
        if (fails) gate.reject(new Error('old failure'));
        else
          gate.resolve(
            stage === 'token'
              ? 'token'
              : stage === 'fetch'
                ? { status: 200, ok: true, json: async () => ({ url: 'https://old/Setup.exe' }) }
                : { url: 'https://old/Setup.exe' },
          );
        await pending;
        assert.equal(u.state.status, 'idle', `${stage}/${fails}`);
        assert.equal(u.state.available, null);
        assert.equal(u.state.error, null);
        assert.equal(calls.length, 0, 'no old-token fetch or installer action');
        u.dispose();
      }
    }
  });

  test('old native events cannot publish a ready update for the newly selected channel', async () => {
    const { u } = make();
    u.configure({ auto: false, channel: 'beta' });
    await checked(u);
    autoUpdater.emit('checking-for-update');
    u.configure({ auto: false, channel: 'stable' });
    autoUpdater.emit('update-available');
    assert.notEqual(u.state.status, 'downloading');
    autoUpdater.emit('update-downloaded', {}, 'old notes', 'old-beta');
    assert.notEqual(u.state.status, 'ready');
    assert.equal(u.state.available, null);
    assert.match(u.state.error, /previous channel.*restart/i);
    assert.equal(await u.install(), false);
    u.dispose();
  });

  test('an approved restart cannot install after switching channel or disposing the updater', async () => {
    for (const change of ['channel', 'dispose']) {
      const gate = deferred<boolean>();
      const { u } = make({ gate: () => gate.promise });
      u.state.status = 'ready';
      const pending = u.install();
      await new Promise((r) => setImmediate(r));
      if (change === 'channel') u.configure({ auto: false, channel: 'beta' });
      else u.dispose();
      gate.resolve(true);
      assert.equal(await pending, false, change);
      assert.equal(
        calls.some((c) => c[0] === 'quitAndInstall'),
        false,
      );
      u.dispose();
    }
  });
}

export function registerWindows() {
  test('windows: the feed is polled; up to date, an installer, a bad status and a bad body', async () => {
    setPlatform('win32');
    const { u } = make();
    assert.equal(u.state.manual, true);
    assert.equal(await u.ready, true);
    u.configure({ auto: false, channel: 'dogfood' });
    assert.equal(calls.length, 0); // no Squirrel feed on Windows

    let s = await u.check();
    assert.equal(s.status, 'idle');
    assert.match(calls[0][1], /\/api\/update\/win32\/.*channel=dogfood/);
    assert.deepEqual(calls[0][2], { accept: 'application/json' });

    responses.fetchImpl = async () => ({ status: 500, ok: false });
    s = await u.check();
    assert.equal(s.error, `Update check failed: ${HOST} answered HTTP 500. Try again later.`);

    responses.fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ url: 'http://insecure' }) });
    s = await u.check();
    assert.equal(s.error, 'The update feed returned no installer');
    responses.fetchImpl = async () => ({ status: 200, ok: true, json: async () => null });
    assert.equal((await u.check()).error, 'The update feed returned no installer');
    responses.fetchImpl = async () => {
      throw 'offline';
    };
    assert.equal((await u.check()).error, `Update check failed: could not reach ${HOST}. Offline.`);

    responses.fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ url: 'https://x/Setup.exe' }) });
    s = await u.check();
    assert.deepEqual(s.available, { version: '', notes: '', url: 'https://x/Setup.exe' });
    responses.fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ url: 'https://x/S.exe', name: '3.0', notes: 'n' }) });
    u.state.status = 'idle';
    s = await u.check();
    assert.deepEqual(s.available, { version: '3.0', notes: 'n', url: 'https://x/S.exe' });

    // install opens the installer in the browser; a failure to open reports false
    assert.equal(await u.install(), true);
    assert.deepEqual(calls.at(-1), ['open', 'https://x/S.exe']);
    responses.openResult = Promise.reject(new Error('no browser'));
    assert.equal(await u.install(), false);
    // the user is told, with the address to download it from by hand
    assert.deepEqual(calls.at(-1), ['dialog', 'Could not open the update download']);
    assert.equal(lastDialog.detail, 'no browser\n\nDownload the update from:\nhttps://x/S.exe');
  });
}
