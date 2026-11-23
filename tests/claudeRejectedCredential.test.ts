// electron/harness/claude/cli.cjs detect: a key, MoPilot credits or a cloud account the login check refused is that credential's
// problem, told by rejectedCredential, never a CLI sign-in; the CLI's own login still reads as signed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin } from './support/electron-claude.ts';

const refusing =
  (status = '{"loggedIn":false}') =>
  (_c: string, args: string[]) =>
    args[0] === 'auth' ? { stdout: status } : { stdout: 'Invalid API key' };
const verify = (t: ReturnType<typeof load>, bin: string) => t.call('claude:detect', bin, false, true, null);

test('a refused Anthropic key is the key’s problem, not a sign-in', async () => {
  const bin = fakeBin('rejected/key/claude', '2.0.0');
  const t = load();
  fakes.run = refusing();
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-ant-fake-test-key');
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
  const d = await verify(t, bin);
  assert.deepEqual([d.state, d.error, d.rejected], ['error', 'Anthropic rejected this API key. Check it and try again.', true]);
  assert.equal(d.billing.mode, 'apiKey');
});

test('refused MoPilot credits say so; a credential changed while the check ran is not judged', async () => {
  const bin = fakeBin('rejected/credits/claude', '2.0.0');
  const t = load();
  fakes.run = refusing();
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'mopilot');
  t.claude.setGatewayKeyProvider(() => 'mpk_1');
  let d = await verify(t, bin);
  assert.deepEqual([d.state, d.rejected], ['error', true]);
  assert.match(d.error, /^MoPilot refused this device's credits key/);
  // the device key changes during the call: the refusal was of the old one, and the change checks again
  fakes.run = (c: string, args: string[]) => {
    if (args[0] !== 'auth') t.claude.setGatewayKeyProvider(() => 'mpk_2');
    return refusing()(c, args);
  };
  d = await verify(t, bin);
  assert.deepEqual([d.state, d.error, d.rejected], ['apikey', undefined, undefined]);
});

test('a Console login the CLI made itself is fixed by signing in again', async () => {
  const bin = fakeBin('rejected/console/claude', '2.0.0');
  const t = load();
  fakes.run = refusing('{"loggedIn":true,"authMethod":"console_api_key"}');
  const d = await verify(t, bin);
  assert.deepEqual([d.state, d.error, d.rejected], ['signin', undefined, undefined]);
});
