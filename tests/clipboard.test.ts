// Copying for the user (src/session/clipboard.ts): the confirmation shows only once the text is on the clipboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let write: (t: string) => Promise<void> = async () => {};
installNativeStub({ clipboard: { write: (t: string) => (calls.push(['write', t]), write(t)) } });
stubStore({
  toast: (...a: unknown[]) => calls.push(['toast', ...a]),
  toastFailure: (what: string) => (e: Error) => calls.push(['failed', what, e.message]),
});
const { copyText } = await import('../src/session/clipboard.ts');
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a copy confirms with its toast, or through the control that asked', async () => {
  copyText('chat-1', 'Copied chat ID');
  let checked = 0;
  copyText('hello', () => checked++);
  await settle();
  assert.deepEqual(calls.splice(0), [
    ['write', 'chat-1'],
    ['write', 'hello'],
    ['toast', 'Copied chat ID'],
  ]);
  assert.equal(checked, 1);
});

test("a copy that didn't reach the clipboard says so instead of confirming", async () => {
  write = async () => {
    throw new Error('clipboard busy');
  };
  let checked = 0;
  let unchecked = 0;
  copyText('chat-1', 'Copied chat ID');
  copyText('hello', () => checked++);
  copyText(
    'code',
    () => checked++,
    () => unchecked++,
  );
  await settle();
  assert.deepEqual(calls.splice(0), [
    ['write', 'chat-1'],
    ['write', 'hello'],
    ['write', 'code'],
    ['failed', "Couldn't copy", 'clipboard busy'],
    ['failed', "Couldn't copy", 'clipboard busy'],
    ['failed', "Couldn't copy", 'clipboard busy'],
  ]);
  // a control that confirms itself hears about the failure too, so it can take back an earlier check
  assert.equal(checked, 0);
  assert.equal(unchecked, 1);
});
