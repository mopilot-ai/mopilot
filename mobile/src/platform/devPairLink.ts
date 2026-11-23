// The dev pairing link bound to React Native's Linking.
import { Linking } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { watchDevPairLink } from '../devPairLink';

// the link that opened the app is handled once per JavaScript process: a reload (Fast Refresh) mounts the app again and would replay it
let initialHandled = false;

export const startDevPairLink = (runtime: Pick<MobileRuntime, 'pair' | 'snapshot' | 'subscribe'>, name: string, dev: boolean) => {
  const skipInitial = initialHandled;
  if (dev) initialHandled = true;
  return watchDevPairLink(runtime, name, dev, Linking, { skipInitial });
};
