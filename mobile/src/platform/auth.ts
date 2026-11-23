// The phone's MoPilot account in a build without the MoPilot service (the open-source edition): it signs in nowhere and
// calls nothing. A private build has mobile/src/private/platform/auth.ts, which Metro bundles in this file's place
// (mobile/config/privateModules.js); tests/phoneAccountShape.private.test.ts holds the two to the same calls.
import Constants from 'expo-constants';
import { phoneName } from '../phoneName';
import { deviceModel } from './deviceModel';

/** Why signing in fails: there is no account service to sign in with. */
export const UNAVAILABLE = 'MoPilot accounts are not part of this build.';
const unavailable = async (): Promise<never> => {
  throw new Error(UNAVAILABLE);
};

/** A signed-in phone's account, as the account service answers a sign-in or a refresh. */
export type PhoneAccount = {
  user: { id: string; email?: string; name?: string; features?: string[] };
  deviceId: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
};

/** This phone's name, as the account's device list and a Host's device list know it. */
export const thisPhoneName = () => phoneName(Constants, deviceModel());

export const authorize: (installId: string) => Promise<PhoneAccount> = unavailable;
export const refresh: (token: string, operation: string) => Promise<unknown> = unavailable;
export const relayToken: (accessToken: string) => Promise<{ token: string; expires_in: number }> = unavailable;
/** There is no session at a service to end: none was reached. */
export const revoke = async (_token: string) => false;
/** No service to say which features the account has (no answer is not a no). */
export const accountFeatures = async (_accessToken: string): Promise<string[] | null> => null;
export const deleteAccount: (accessToken: string, confirm: string) => Promise<void> = unavailable;
