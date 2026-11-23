// A login the provider refuses is a login that no longer works for the verified check, as a lapsed one is (electron/harness/claude/cli.cjs loginCheck, #4908): `detect` with verify reads the one-token answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load, fakeBin } from './support/electron-claude.ts';

test('a login that authenticates but is refused for its organization reads as signed out; a call that merely failed still reads as working', async () => {
  const t = load();
  const bin = fakeBin('refused/claude', '2.0.0');
  let probeOut: any = { stdout: 'hi' };
  fakes.run = (_c: string, args: string[]) =>
    args[0] === 'auth' ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) } : probeOut;
  const verify = async () => (await t.call('claude:detect', bin, false, true, null)).state;
  assert.equal(await verify(), 'ready');
  // the CLI prints the refusal on stdout and exits non-zero
  probeOut = {
    err: new Error('exit 1'),
    stdout: 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead',
  };
  assert.equal(await verify(), 'signin');
  probeOut = { err: new Error('exit 1'), stderr: 'API Error: 403 oauth_not_allowed_for_organization' };
  assert.equal(await verify(), 'signin');
  probeOut = { err: new Error('network down') };
  assert.equal(await verify(), 'ready');
});
