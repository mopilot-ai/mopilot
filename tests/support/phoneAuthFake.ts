// The phone runtime tests fake the account (shared/remote/phoneAuth.mjs): the relay's token is the fake's own token, so one fake serves both.
export { TEST_RELAY } from './phone/testRelay.ts';
export const withRelay = <T extends { token: (force?: any) => Promise<string>; expiresAt: () => number }>(auth: T) => ({
  ...auth,
  relayToken: (force?: boolean) => auth.token(force),
  relayExpiresAt: () => auth.expiresAt(),
});
