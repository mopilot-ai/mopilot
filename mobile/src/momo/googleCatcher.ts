// The phone's half of MoMo's Google sign-in: the system's authentication session (ASWebAuthenticationSession through expo-web-browser) opens the consent page and returns the redirect on the app's own scheme, which the sign-in flow (shared/momoGoogle/signIn.mjs) seals to the home's key. It needs the iOS OAuth client the home reports as `iosRedirectUri`.
import { parseCallback } from '../../../shared/momoGoogle/handoff.mjs';
import type { Catcher } from '../../../shared/momoGoogle/signIn.mjs';

/** What expo-web-browser's `openAuthSessionAsync` answers. */
export type AuthSessionResult = { type: 'success'; url: string } | { type: 'cancel' | 'dismiss' | 'locked' };

export function createAuthSessionCatcher(o: {
  redirectUri: string;
  openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
}): () => Promise<Catcher> {
  return async () => {
    let session: Promise<AuthSessionResult> | null = null;
    let expected: string | null = null;
    return {
      redirectUri: o.redirectUri,
      open: async (url) => {
        expected = new URL(url).searchParams.get('state');
        session = o.openAuthSession(url, o.redirectUri);
      },
      wait: async () => {
        const result = await session;
        const hand = result?.type === 'success' ? parseCallback(result.url, o.redirectUri) : null;
        // only the redirect of the page that was opened counts
        return hand && hand.state === expected ? hand : null;
      },
      close: () => undefined,
    };
  };
}
