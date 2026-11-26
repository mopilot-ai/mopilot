// What the packaging tests share (scripts/package.mjs): the app they package, and every tool it uses as a recorder.
import edition from '../../shared/edition.json' with { type: 'json' };
import { recorder } from './scripts-shared-cli.ts';

const { ENTITLEMENTS } = await import('../../scripts/signing.mjs');

export const pkg = { productName: edition.desktop.name, version: '1.2.0' };
export const macOutput = `/out/${edition.desktop.name}-darwin-arm64`;

export function tools(over: Record<string, unknown> = {}) {
  const t = {
    hostPlatform: 'darwin',
    packager: recorder(async () => [macOutput]),
    flipFuses: recorder(async () => {}),
    checkFuses: recorder(async () => {}),
    checkEntitlements: recorder(() => {}),
    buildHelper: recorder(() => '/native/helper.app'),
    writeHelperDigest: recorder(),
    buildSageMcp: recorder(() => '/native/sage-mcp'),
    buildAuthCommand: recorder(() => '/native/auth-command'),
    buildDisclaim: recorder(() => '/native/disclaim'),
    buildUpdateInstall: recorder(() => '/native/update-install'),
    buildCodePairApprove: recorder(() => '/native/code-pair-approve'),
    buildPasskeys: recorder(() => '/native/passkeys.node'),
    buildCore: recorder(() => '/core/mopilot_core.node'),
    checkWindowsCore: recorder(),
    recordCoreHash: recorder(() => 'abc123'),
    recordHostCores: recorder(() => ({ 'linux-x64-gnu': 'def456' })),
    signHostCores: recorder(),
    fetchRipgrep: recorder(async () => '/rg'),
    stripChromiumLocales: recorder(() => ({ kept: 60, removed: 160 })),
    mainSigningInfo: recorder(() => ({ designatedRequirement: 'designated', teamId: 'AB12CD34EF' })),
    webAuthnSigning: recorder(({ release }: { release: boolean }) => ({
      appEntitlements: release ? ENTITLEMENTS.app : ENTITLEMENTS.dev,
      webAuthnAccessGroup: null,
      provisioningProfile: null,
    })),
    resolveIdentity: recorder(() => ({ identity: '-', release: false })),
    checkRuntimeDependencies: recorder(() => ['js-yaml', 'smol-toml']),
    checkHostBundle: recorder(() => 'host-sha'),
    verifyAnalyticsBundle: recorder(),
    existsSync: recorder(() => true),
    mkdtempSync: recorder(() => '/native'),
    rmSync: recorder(),
    mkdirSync: recorder(),
    cpSync: recorder(),
    chmodSync: recorder(),
    notarizeApp: recorder(),
    markReleaseBuild: recorder(),
    exec: recorder(),
    sleep: recorder(),
    log: recorder(),
    warn: recorder(),
    ...over,
  };
  return t as typeof t & Record<string, any>;
}
