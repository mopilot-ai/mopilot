// Remote switches, as the main process resolved them (electron/platform/flags.cjs): a kill flag is on when this build
// ships it on and the server hasn't switched it off; a toggle flag may also be turned on by the server.
import { useSyncExternalStore } from 'react';
import { native } from './native';

export type FlagKey =
  | 'harness.codex.enabled'
  | 'harness.claude.enabled'
  | 'tier.basic.enabled'
  | 'host.unattended'
  | 'host.machinePage'
  | 'host.codePair'
  | `harness.acp.${string}.enabled`
  | 'shared.computerUse.enabled'
  | 'shared.computerUse.unattended'
  | 'shared.computerUse.parityTools'
  | 'shared.computerUse.hideBeforeAction'
  | 'app.update.stealth'
  | 'shared.computerAccess.enabled'
  | 'shared.browser.extension'
  | 'shared.browser.panelCdp'
  | 'shared.browser.parityTools'
  | 'shared.browser.turnTrace'
  | 'momo.outputs'
  | 'shared.browser.devPreview'
  | 'shared.browser.agentCursor'
  | 'shared.browser.viewTabs'
  | 'shared.browser.import'
  | 'shared.browser.loginAssist'
  | 'shared.browser.siteRiskRemote'
  | 'shared.browser.chromeRelay'
  | 'shared.browser.chromeExtension'
  | 'shared.visionFallback'
  | 'shared.dictation.enabled'
  | 'shared.dictation.local'
  | 'shared.dictation.chatgptStream'
  | 'channel.claude.sdkMcp'
  | 'channel.codex.threadConfigMcp'
  | 'channel.acp.sessionMcp'
  | 'plugins.claude'
  | 'plugins.codex'
  | 'plugins.acp'
  | 'codex.disableUserNodeRepl'
  | 'native.codex.enabled'
  | 'native.codex.inAppBrowser'
  | 'native.claude.chrome'
  | 'codex.browser.chromeExtension'
  | 'shared.browser.chromeExtensionByDefault'
  | 'shared.browser.chromeExtensionAutoAdd'
  | 'shared.browser.chromePageTree'
  | 'shared.browser.chromePageText'
  | 'data.legacyMirror'
  | 'shared.perf.probe'
  | 'momo.enabled'
  | 'superagent'
  | 'remote.enabled'
  | 'host.cloud';

export function isEnabled(key: FlagKey): boolean {
  return native.flags.isEnabled(key);
}

/** A first-class harness the server hasn't switched off. */
export const harnessEnabled = (h: 'codex' | 'claude') => isEnabled(`harness.${h}.enabled`);

/** The first-class harnesses the server hasn't switched off, in picker order. */
export function useEnabledHarnesses(): ('codex' | 'claude')[] {
  const codex = useFlag('harness.codex.enabled');
  const claude = useFlag('harness.claude.enabled');
  return [...(codex ? ['codex' as const] : []), ...(claude ? ['claude' as const] : [])];
}

/** A flag in a component: re-renders when main pushes a changed snapshot. */
export function useFlag(key: FlagKey): boolean {
  return useSyncExternalStore(
    (cb) => native.flags.onChanged(cb),
    () => native.flags.isEnabled(key),
  );
}
