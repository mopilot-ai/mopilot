// Basic harnesses' ACP sign-ins (authenticate), renderer side: start one, follow main's list of those under way (in
// every window), and Cancel. Main (electron/harness/acp/signin.cjs SignIns) runs at most one per harness.
import { native, type BasicHarnessStatus } from '../../lib/native';
import { adoptBasicHarnesses } from './acpDiscovery';
import { set as setState, toast } from '../../store/core';
import { errorText, ignoring } from '../../lib/ignored';

/** design copy: an ACP sign-in waiting on the harness's own login (a browser page it opened) */
export const SIGNIN_WAITING = 'Waiting for sign-in in the browser…';

/** Harnesses this window asked to sign in and has no answer for yet: a second click before main's list arrives. */
const asked = new Set<string>();

/**
 * Sign in with an auth method that has no terminal command (ACP authenticate), then check again. The pending state is
 * main's (basicSignIns); a cancelled sign-in says nothing.
 */
export async function authenticateBasic(h: BasicHarnessStatus, methodId: string) {
  if (asked.has(h.id)) return;
  asked.add(h.id);
  try {
    const { harnesses, cancelled } = await native.acp.authenticate(h.id, methodId);
    adoptBasicHarnesses(harnesses);
    if (cancelled) return;
    // a harness may answer its authenticate without signing anything in (Goose 1.54 does): say so, not nothing
    const still = harnesses.find((x) => x.id === h.id && x.state === 'signin');
    if (still) toast(`${h.label} is still signed out${still.reason ? `: ${still.reason}` : ''}`, 'error');
  } catch (e) {
    toast(`${h.label}: ${errorText(e)}`, 'error');
  } finally {
    asked.delete(h.id);
  }
}

/** Stop waiting for the harness's sign-in (in whichever window it started). */
export async function cancelBasicSignIn(id: string) {
  try {
    await native.acp.cancelSignIn(id);
  } catch (e) {
    toast(`Couldn't cancel the sign-in: ${errorText(e)}`, 'error');
  }
}

/** Follows main's sign-ins under way; its answer and pushes come over one ordered channel, so the last one is newest. */
export function followBasicSignIns() {
  native.acp.onSignIns((basicSignIns) => setState({ basicSignIns }));
  native.acp
    .signIns()
    .then((basicSignIns) => setState({ basicSignIns }))
    .catch(ignoring('list the basic sign-ins under way'));
}
