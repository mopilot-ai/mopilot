// How main wires the built-in browser's claude.ai sign-in (electron/app/browserTools.cjs → claudeSite.cjs): it follows
// the shared profile's cookies from startup, pushes each answer to every open window, and keeps answering with none.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';

after(() => unloadMain());

test('main follows the shared profile from startup: pushes reach open windows, and the invoke answers with none open', async () => {
  let jar: any[] = [];
  const cookies = Object.assign(new EventEmitter(), { get: async () => jar });
  const h = await loadMain({
    before: (h) => {
      h.electron.session.fromPartition('persist:browser').cookies = cookies;
    },
  });
  await h.ready();
  await flush();
  assert.equal(cookies.listenerCount('changed'), 1, 'subscribed once, at startup');
  assert.deepEqual(await h.invoke('browser:claudeSignIn'), { signedIn: false, seq: 1 });
  const win = h.windows[0];
  assert.deepEqual(win.webContents.on_('browser:claudeSignIn'), [[{ signedIn: false, seq: 1 }]]);
  // every window closes: main keeps following the profile, and a window opened later reads the answer
  for (const w of h.windows) w.close();
  jar = [{ name: 'sessionKey', domain: '.claude.ai', value: 'sk', session: true }];
  cookies.emit('changed', {}, jar[0], 'inserted', false);
  await flush();
  assert.deepEqual(await h.invoke('browser:claudeSignIn'), { signedIn: true, seq: 2 });
  assert.equal(win.webContents.on_('browser:claudeSignIn').length, 1, 'a closed window gets nothing');
});
