// The real legacy-pane IPC bridge delegates restoration and validates requests without constructing a browser.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
for (const file of ['browserData', 'browserImport', 'browserLogins', 'browserErrands']) {
  mock.module(`../electron/app/ipc/${file}.cjs`, { namedExports: { register() {} } });
}
const { register } = createRequire(import.meta.url)('../electron/app/ipc/browser.cjs');

test('legacy preview IPC preserves ordinary addresses, restores owned URLs and refuses malformed calls', async () => {
  const handlers = new Map<string, Function>();
  const live: any = {};
  register(
    { handle: (name: string, fn: Function) => handlers.set(name, fn), on() {} },
    {
      live,
      registerAnnotateCapture() {},
    },
  );
  const prepare = handlers.get('browser:preparePreview')!;
  const url = 'http://127.0.0.1:4317/';
  assert.equal(await prepare({}, null, url), url);
  const asked: any[] = [];
  live.devPreviews = {
    prepare: (chat: string, address: string) => {
      asked.push([chat, address]);
      return null;
    },
  };
  assert.equal(await prepare({}, 'chat', url), url);
  live.devPreviews.prepare = async () => 'http://127.0.0.1:4318/';
  assert.equal(await prepare({}, 'chat', url), 'http://127.0.0.1:4318/');
  assert.deepEqual(asked, [['chat', url]]);
  assert.throws(() => prepare({}, 4, url), /Invalid preview address/);
  assert.throws(() => prepare({}, 'chat', []), /Invalid preview address/);
});
