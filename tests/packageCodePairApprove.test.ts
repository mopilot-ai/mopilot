// scripts/package.mjs and the pairing-by-code approval helper (#5576): left out of the package unless the build asks for it, so a release carries it only once host.codePair is turned on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import edition from '../shared/edition.json' with { type: 'json' };
import { pkg, tools } from './support/package-tools.ts';

const pkgScript = await import('../scripts/package.mjs');
const macApp = `${edition.desktop.name}.app`;

test('package: MOPILOT_PACKAGE_CODE_PAIR_APPROVE=1 builds the approval helper and puts it in Contents/Helpers', async () => {
  const t = tools();
  assert.equal(await pkgScript.main(['--arch', 'arm64'], { ...t, env: { MOPILOT_PACKAGE_CODE_PAIR_APPROVE: '1' }, pkg } as any), 0);
  assert.deepEqual(t.buildCodePairApprove.calls[0], [{ out: '/native', arch: 'arm64', sign: false }]);
  const o = t.packager.calls[0][0];
  const appPath = `/stage/${macApp}`;
  for (const hook of o.afterCopy) await hook({ buildPath: `${appPath}/Contents/Resources/app` });
  assert.ok(
    t.cpSync.calls.some((c: any[]) => c[0] === '/native/code-pair-approve' && c[1] === `${appPath}/Contents/Helpers/code-pair-approve`),
    'copied beside the other helpers',
  );
});
