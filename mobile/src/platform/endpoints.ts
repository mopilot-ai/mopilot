// The endpoints this build was made with, read from the Expo config the build carries.
import Constants from 'expo-constants';
import { resolveEndpoints } from '../endpoints';

type Config = { expoConfig?: { extra?: { devHost?: unknown; devClient?: unknown } } | null };

/**
 * The override needs a development build (`devGlobal`, React Native's `__DEV__`) or the explicit dev-client flag that app.config.js
 * sets from MOPILOT_DEV_CLIENT=1; a release build ignores the dev host.
 */
export function endpointsOf(constants: Config, devGlobal: unknown) {
  const extra = constants.expoConfig?.extra ?? {};
  return resolveEndpoints(extra.devHost, devGlobal === true || extra.devClient === true);
}

/** Says which servers a build talks to when they are not MoPilot's, so a build that fell back to production is obvious in the Metro log too. */
export function announce(chosen: ReturnType<typeof endpointsOf>, log: (line: string) => void, hadDevHost: boolean) {
  if (chosen.dev) log(`[mobile] dev endpoints: relay ${chosen.relayUrl}, account ${chosen.accountOrigin}`);
  else if (hadDevHost)
    log(
      '[mobile] a dev host is configured but ignored (release build without MOPILOT_DEV_CLIENT=1, or not a local http origin): using MoPilot',
    );
}

export const endpoints = endpointsOf(Constants, (globalThis as { __DEV__?: boolean }).__DEV__);
announce(endpoints, console.info, Constants.expoConfig?.extra?.devHost !== undefined);
