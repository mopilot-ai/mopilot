// Builds native/code-pair-approve with the release builder and runs its Swift tests, which hold the approval text's
// fixed vector shared with the Host (tests/codePairApproval.test.ts VECTOR): the helper must build the same bytes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildCodePairApprove } from '../scripts/build-code-pair-approve.mjs';
import { tempDir } from './support/scripts-shared-cli.ts';

if (process.argv[2] === '--build-fixture') {
  const out = process.argv[3];
  assert.equal(buildCodePairApprove({ out, sign: false }), path.join(out, 'code-pair-approve'));
} else {
  test("the approval helper builds for real, its Swift tests pass, and it builds the Host's vector byte for byte", {
    skip: process.platform !== 'darwin',
  }, (t) => {
    const out = tempDir('code-pair-approve-test-');
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const env = { ...process.env, SWIFTPM_BUILD_DIR: path.join(out, 'swift-build') };
    const buildOptions = { env, stdio: 'inherit', timeout: 90_000 } as const;
    execFileSync(process.execPath, [import.meta.filename, '--build-fixture', out], buildOptions);
    const bin = path.join(out, 'code-pair-approve');
    assert.match(execFileSync('/usr/bin/file', ['-b', bin], { encoding: 'utf8' }), /Mach-O 64-bit executable/);
    execFileSync('swift', ['test', '--package-path', 'native/code-pair-approve'], buildOptions);
    // the `text` mode needs no keychain and no prompt
    const fields = {
      hostId: 'h_0123456789abcdef',
      offerId: 'r_AAAAAAAAAAAAAAAAAAAAAA',
      safety: '123 456',
      peer: '07'.repeat(32),
      name: 'Du’s MacBook',
      carryHash: '051cd44b0519420df4af7031483d9015ff939cc73e44e59522d07996ec5daddf',
      link: 'h_abcdefghijklmnop',
      notAfter: 1800000120000,
    };
    const text = execFileSync(bin, ['text'], { input: JSON.stringify(fields), encoding: 'utf8' }).trim();
    assert.equal(
      text,
      'mopilot-code-pair-approval-v1|h_0123456789abcdef|r_AAAAAAAAAAAAAAAAAAAAAA|123 456|0707070707070707070707070707070707070707070707070707070707070707|b507895844054f540097cf4ebbad177ee4717915a243700d7a121ab6b64923ff|051cd44b0519420df4af7031483d9015ff939cc73e44e59522d07996ec5daddf|h_abcdefghijklmnop|1800000120000|1',
    );
  });
}
