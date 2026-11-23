// The phone's run of MoMo's Google intents (connect, reconnect, grant-send, remove): the home cannot open a browser for the phone, so the sign-in runs here with the system's authentication session and talks to the home's Host through the one `call` the app has.
import { createSealer } from '../../../shared/momoGoogle/seal.mjs';
import { googleIntents } from '../../../shared/momoGoogle/intents.mjs';
import type { Primitives } from '../../../shared/remote/crypto.mjs';
import { createAuthSessionCatcher, type AuthSessionResult } from './googleCatcher';

export type PhoneGoogleResult = { ok: true; notice?: string } | { ok: false; cause: string; fix?: object; fixLabel?: string };

const NOT_SET_UP = 'Google is not set up for the phone yet. Set it up on the Mac first.';

/**
 * @param o.intent connect, reconnect, grant-send or remove
 * @param o.call a call to the home's Host (`host.momoGoogle` carries the steps)
 * @param o.primitives the app's shared remote crypto primitives (libsodium and noble, injected)
 * @param o.openAuthSession expo-web-browser's `openAuthSessionAsync`
 */
export async function runGoogleOnPhone(o: {
  intent: string;
  call: (method: string, params: object) => Promise<unknown>;
  primitives: Primitives;
  openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
}): Promise<PhoneGoogleResult> {
  try {
    // the redirect of the home's iOS client is read from the home, so no screen holds a client id
    const { uri: redirectUri } = (await o.call('host.momoGoogle', { op: 'iosRedirect' })) as { uri: string | null };
    if (o.intent !== 'remove' && !redirectUri) return { ok: false, cause: NOT_SET_UP };
    const handlers = googleIntents({
      call: o.call,
      sealer: createSealer(o.primitives),
      startCatcher: createAuthSessionCatcher({ redirectUri: redirectUri ?? '', openAuthSession: o.openAuthSession }),
      client: 'ios',
    });
    const done = await handlers.google({ intent: o.intent, client: 'ios' });
    return { ok: true, ...(done.notice ? { notice: done.notice } : {}) };
  } catch (error) {
    const e = error as { message?: string; fix?: object; fixLabel?: string };
    return { ok: false, cause: e.message ?? 'It did not finish.', ...(e.fix && e.fixLabel ? { fix: e.fix, fixLabel: e.fixLabel } : {}) };
  }
}
