// scripts/signing.mjs: the keychain query and the probe-signing that reads the main app's requirement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recorder } from './support/scripts-shared-cli.ts';
import { APP_BUNDLE_ID, findCodesigningIdentities, mainSigningInfo } from '../scripts/signing.mjs';

test('identities come from security find-identity for code signing', () => {
  const exec = recorder(() => 'out');
  assert.equal(findCodesigningIdentities(exec as any), 'out');
  assert.deepEqual(exec.calls, [['security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }]]);
});

test('the designated requirement is read from a probe signed with the identity, which is then removed', () => {
  let probe = '';
  const exec = recorder((_cmd: string, args: string[]) => {
    probe = args.at(-1)!;
    assert.ok(fs.existsSync(probe), 'the probe is a real copy of a binary');
    return '';
  });
  const spawn = recorder(() => ({
    status: 0,
    stdout: 'Executable=x\n',
    stderr: 'designated => identifier "ai.mopilot.code" and anchor apple generic\n',
  }));
  assert.equal(
    mainSigningInfo('Developer ID Application: X (AB12CD34EF)', { exec, spawn } as any).designatedRequirement,
    'identifier "ai.mopilot.code" and anchor apple generic',
  );
  assert.deepEqual(exec.calls[0][1], [
    '--force',
    '--sign',
    'Developer ID Application: X (AB12CD34EF)',
    '--identifier',
    APP_BUNDLE_ID,
    '--timestamp=none',
    probe,
  ]);
  assert.deepEqual(spawn.calls[0][1], ['-d', '-r-', '--verbose=4', probe]);
  assert.equal(fs.existsSync(probe), false);
});

test('a failed probe signature still removes the scratch folder', () => {
  let probe = '';
  assert.throws(
    () =>
      mainSigningInfo('Bad', {
        exec: ((_c: string, args: string[]) => {
          probe = args.at(-1)!;
          throw new Error('no such identity');
        }) as any,
      }).designatedRequirement,
    /no such identity/,
  );
  assert.equal(fs.existsSync(probe), false);
});
