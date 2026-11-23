// Mobile Remote consent follows the account and device in main's startup composition.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test('MoPilot account and device changes retire Mobile Remote consent', async () => {
  const h = await loadMain();
  await h.ready();
  const mo = h.one('MoPilotAccount');
  const patch = h.mod('platform/chats.cjs').patchPrefsSync;
  mo.creds = { user: { id: 'one' }, deviceId: 'device-one' };
  mo.opts.broadcast({ signedIn: true, user: { id: 'one' } });
  assert.deepEqual(calls(patch).at(-1).slice(1), [{ mobileRemoteOwner: null }, []]);
  const n = patch.mock.callCount();
  mo.opts.broadcast({ signedIn: true, user: { id: 'one' } });
  assert.equal(patch.mock.callCount(), n);
  mo.creds = { user: { id: 'one' }, deviceId: 'device-two' };
  mo.opts.broadcast({ signedIn: true, user: { id: 'one' } });
  assert.deepEqual(calls(patch).at(-1).slice(1), [{ mobileRemoteOwner: null }, []]);
  patch.mock.mockImplementationOnce(() => {
    throw new Error('disk');
  });
  mo.creds = null;
  mo.opts.broadcast({ signedIn: false });
  assert.deepEqual(calls(patch).at(-1).slice(1), [{ mobileRemoteOwner: null }, []]);
});
