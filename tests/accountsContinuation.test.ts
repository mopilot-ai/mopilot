// An account move captures continuation authorization before awaits and respects a later Stop choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sub } from './support/electron-accounts.ts';

test('disabling automatic switching during a successful pending move does not authorize a continuation', async (t) => {
  const { a, notices } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  let finish!: () => void;
  a.switchTo = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  a.refreshUsage = async () => {};
  const confirmed: string[] = [];
  a.prepareContinue = (thread: string) => () => void confirmed.push(thread);
  const moving = a.onTurnLimit('limited');
  await new Promise((resolve) => setImmediate(resolve));
  a.state.autoSwitch = false;
  finish();
  await moving;
  assert.deepEqual(confirmed, []);
  assert.equal(
    notices().some((n: any) => n.kind === 'resume'),
    false,
  );
});
