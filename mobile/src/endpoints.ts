// Where this build talks to: its hosted service's account and relay (MoPilot's in a private build, none in the open-source
// edition: mobile/src/service.ts), or (a development build only) the dev host named by MOPILOT_DEV_HOST.
import { parseDevHost } from '../config/devHost.js';
import { PRODUCTION } from './service';

export { PRODUCTION };

/**
 * `devHost` is the build's extra.devHost and `devBuild` whether this is a development build (React Native's `__DEV__`, or the
 * explicit dev-client flag): a release build never leaves the production endpoints, and neither does anything that is not a local http origin.
 */
export function resolveEndpoints(devHost: unknown, devBuild: boolean): { relayUrl: string; accountOrigin: string; dev: boolean } {
  const dev = devBuild ? parseDevHost(devHost) : null;
  return dev ? { relayUrl: dev.relayUrl, accountOrigin: dev.origin, dev: true } : { ...PRODUCTION, dev: false };
}

/** What a screen shows about the dev override: the two endpoints when it is active, nothing at all for a normal or production build. */
export function devEndpointsOf(chosen: {
  relayUrl: string;
  accountOrigin: string;
  dev: boolean;
}): { relayUrl: string; accountOrigin: string } | undefined {
  return chosen.dev ? { relayUrl: chosen.relayUrl, accountOrigin: chosen.accountOrigin } : undefined;
}
