// A sign-in a phone starts (electron/host/signin.cjs `openHere: false`): the vendor's page is recorded in the view so the phone opens it in its own browser, and this Mac's browser is left alone; one started on this Mac still opens there, and a phone joining it adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSignin } = require('../electron/host/signin.cjs');

const PAGE = 'https://claude.ai/login/device?code=ABCD';
function world() {
  const opened: string[] = [];
  const signin = createSignin({
    call: async (_id: string, method: string) =>
      method === 'login' ? { state: 'waiting', links: [PAGE], codes: ['ABCD'] } : { state: 'waiting', links: [PAGE], codes: ['ABCD'] },
    openExternal: (url: string) => void opened.push(url),
    verify: async () => ({ signedIn: false }),
    pollMs: 1,
  });
  return { signin, opened };
}
const until = async (fn: () => any) => {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('timed out');
};

test('a phone’s sign-in carries the page and its code in the view and opens nothing on this Mac', async () => {
  const { signin, opened } = world();
  void signin.start({ hostId: 'h', harness: 'claude', openHere: false });
  await until(() => signin.status('h', 'claude')?.url);
  assert.equal(signin.status('h', 'claude').url, PAGE);
  assert.deepEqual(signin.status('h', 'claude').codes, ['ABCD']);
  assert.equal(signin.status('h', 'claude').link, true);
  assert.deepEqual(opened, []);
  signin.dispose();
});

test('a sign-in started on this Mac opens its page here, and a phone joining it opens nothing more', async () => {
  const { signin, opened } = world();
  void signin.start({ hostId: 'h', harness: 'claude' });
  await until(() => opened.length === 1);
  void signin.start({ hostId: 'h', harness: 'claude', openHere: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(opened, [PAGE]);
  signin.dispose();
});
