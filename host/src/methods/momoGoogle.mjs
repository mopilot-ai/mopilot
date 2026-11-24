// The Host's handler for host.momoGoogle (shared/host/methods/momoGoogle.mjs): one step of MoMo's Google source, run by the service the home holds. Veiled like the rest of MoMo: to a client that is not paired, or while no live grant of an invited account is held, it is a request no Host knows.

import { HostRefusal } from '../hostFs.mjs';
import { deviceOf } from '../momoDevice.mjs';
import { isOwner } from '../momoOwner.mjs';
import { onlyAtHome } from '../momoHomeGuard.mjs';

/** The steps that change what MoMo can do with Google (a client, a sign-in, a send grant, a removal): each is in the audit log, with the device that asked, before it runs. */
const AUDITED = new Set(['configure', 'begin', 'complete', 'disconnect']);

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  /** The service the home holds, read when asked: the home may be wired after this file loads. */
  const google = () => /** @type {import('../momoGoogle.mjs').MomoGoogle} */ (momo?.service('google'));
  return {
    guard: onlyAtHome(momo),
    veils: { 'host.momoGoogle': (/** @type {unknown} */ principal) => !!momo && isOwner(principal) && momo.granted() && !!google() },
    handlers: {
      'host.momoGoogle': async (
        /** @type {{ op: 'status' | 'iosRedirect' | 'configure' | 'begin' | 'complete' | 'disconnect', purpose?: string } & Record<string, any>} */ p,
        /** @type {string} */ _kind,
        /** @type {unknown} */ who,
      ) => {
        if (AUDITED.has(p.op)) {
          // no audit line, no change: a send grant widens what MoMo can do, and the log says which device asked
          const reason = p.op === 'begin' ? `begin:${p.purpose}` : p.op;
          const written = await /** @type {any} */ (momo?.service('gate'))?.audit?.({
            event: 'google.changed',
            reason,
            by: deviceOf(who).id,
          });
          if (!written) throw new HostRefusal('google_audit_unavailable', 'MoMo’s audit log is not available, so Google is not changed.');
        }
        return google()[p.op](/** @type {any} */ (p));
      },
    },
  };
};
