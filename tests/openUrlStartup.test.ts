// A mopilot:// link macOS hands to the app ('open-url', the Quick Actions') is claimed by the app, and opens a chat only
// while the user has the Quick Actions turned on (electron/app/lifecycle.cjs prepareApp, openLinks.cjs, platform/quickActionsWiring.cjs).
import { APP_SCHEME } from '../shared/deepLink.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

after(() => unloadMain());

test('a link is claimed, and ignored while the Quick Actions are not installed', async () => {
  const h = await loadMain();
  await h.ready();
  h.emitIpc('window:ready', h.windows[0].webContents);
  let claimed = false;
  h.app.emit(
    'open-url',
    { preventDefault: () => (claimed = true) },
    `${APP_SCHEME}://chat/new?folder=${encodeURIComponent(process.cwd())}&q=hi`,
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(claimed, true);
  const sent = h.windows.flatMap((w: any) => w.webContents.sent).filter((s: any[]) => s[0] === 'app:command' && s[1] === 'new-chat-link');
  assert.deepEqual(sent, []);
});
