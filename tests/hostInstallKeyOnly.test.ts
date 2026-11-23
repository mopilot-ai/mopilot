// A machine that takes keys only refuses the add with this Mac's public key to authorize (electron/host/install.cjs, shown by shared/host/installFailure.mjs); a machine that takes a password, or no key, is not offered one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundle, machine } from './support/host-install-kit.ts';

const require = createRequire(import.meta.url);
const { createInstaller } = require('../electron/host/install.cjs');

const KEY = 'ssh-ed25519 AAAA mopilot';
const probe = async () => ({ code: 1, stdout: '', stderr: '' });

test('a machine that takes keys only is refused with this Mac’s public key to authorize; a machine that takes a password, or no key, is not', async () => {
  const keyOnly = { 'uname -sm': { code: 255, stderr: 'me@box: Permission denied (publickey).' } };
  const withKey = (ensure: () => Promise<{ file: string; pub: string }>) =>
    createInstaller({ channel: machine(keyOnly as any).channel, bundle, keyAccess: { probe, ensure, consent: async () => true } });
  const shown = await withKey(async () => ({ file: '/k', pub: KEY })).install('me@box');
  assert.equal(shown.publicKey, KEY);
  const broken = await withKey(() => Promise.reject(new Error('no ssh-keygen'))).install('me@box');
  assert.equal(broken.publicKey, undefined, 'no key to show');
  const bare = await createInstaller({ channel: machine(keyOnly as any).channel, bundle }).install('me@box');
  assert.equal(bare.publicKey, undefined, 'no key access');
  const password = machine({ 'uname -sm': { code: 255, stderr: 'Permission denied (publickey,password).' } });
  const out = await createInstaller({
    channel: password.channel,
    bundle,
    keyAccess: { probe, ensure: async () => ({ file: '/k', pub: KEY }), consent: async () => true },
  }).install('me@box');
  assert.equal(out.publicKey, undefined);
});
