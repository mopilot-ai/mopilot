// The client's whole sign-in with Google for MoMo's home, pure of any platform: ask the home to begin, let a catcher open the browser and catch the redirect, seal it to the home's one-time key and hand it back. The Mac app and the phone differ only in the catcher they pass in (a loopback listener, an app-scheme session), so both end in the same typed result.
import { sealHandoff } from './handoff.mjs';

/**
 * @typedef {object} Catcher
 * @property {string} redirectUri where the browser will be sent back to
 * @property {(url: string) => Promise<void>} open show the consent page
 * @property {() => Promise<import('./handoff.mjs').Handoff | null>} wait the redirect, or null when it never came (cancelled, closed, timed out)
 * @property {() => void} close
 */
/** @typedef {{ call: (op: string, params?: object) => Promise<any> }} GoogleHost one `host.momoGoogle` step on the home */
/** @typedef {{ ok: true, state: import('./state.mjs').GoogleState } | { ok: false, code: string, message: string }} SignInResult */

/** A failure as the person reads it: the home's refusal code and words, never a stack. @param {unknown} e @returns {{ ok: false, code: string, message: string }} */
const failed = (e) => ({
  ok: false,
  code: String(/** @type {any} */ (e)?.code ?? 'failed'),
  message: String(/** @type {any} */ (e)?.message ?? 'It did not finish.'),
});

/**
 * @param {object} o
 * @param {GoogleHost} o.host
 * @param {() => Promise<Catcher>} o.startCatcher makes the platform's catcher; its redirect is what the home is told
 * @param {import('./seal.mjs').Sealer} o.sealer
 * @param {'read' | 'send'} o.purpose
 * @param {'desktop' | 'ios'} o.client
 * @returns {Promise<SignInResult>}
 */
export async function signInToGoogle({ host, startCatcher, sealer, purpose, client }) {
  /** @type {Catcher | undefined} */
  let catcher;
  /** @type {SignInResult} */
  let result;
  try {
    catcher = await startCatcher();
    const begun = await host.call('begin', { purpose, client, redirectUri: catcher.redirectUri });
    await catcher.open(begun.authUrl);
    const hand = await catcher.wait();
    result = hand
      ? {
          ok: true,
          state: await host.call('complete', { flowId: begun.flowId, sealed: sealHandoff(sealer, begun.flowId, begun.sealTo, hand) }),
        }
      : { ok: false, code: 'cancelled', message: 'The sign-in was not finished.' };
  } catch (e) {
    result = failed(e);
  }
  catcher?.close();
  return result;
}

/** Disconnects Google on the home (revoke at Google, erase tokens and cursors). @param {GoogleHost} host */
export async function disconnectGoogle(host) {
  try {
    return { ok: /** @type {const} */ (true), ...(await host.call('disconnect')) };
  } catch (e) {
    return failed(e);
  }
}

/**
 * Gives the home its Google clients (the Mac reads the downloaded client file; the secret is sent only over the home's own link and sealed there).
 * @param {GoogleHost} host @param {{ desktopJson: string, iosClientId?: string }} clients
 */
export async function configureGoogle(host, clients) {
  try {
    return { ok: /** @type {const} */ (true), state: await host.call('configure', clients) };
  } catch (e) {
    return failed(e);
  }
}
