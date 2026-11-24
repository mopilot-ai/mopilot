// What a MoMo home keeps of the server-signed entitlement (#5474): the gate's state sealed beside the grant, read once and re-read after a change, and the home's two questions to it: is the grant still standing, and may this grant in.
import fs from 'node:fs';
import path from 'node:path';
import { HostRefusal } from './hostFs.mjs';
import { ENTITLEMENT_FAILURES } from '../../shared/host/momoEntitlement.mjs';
import { emptyEntitlementState, entitlementStateShape } from './momoEntitlementGate.mjs';

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./momoEntitlementGate.mjs').createEntitlementGate>} o.gate
 * @param {(name: string, shape: (v: any) => ReturnType<typeof entitlementStateShape>) => { read: () => ReturnType<typeof entitlementStateShape>, change: (edit: (s: any) => void) => Promise<unknown> }} o.sealed makes the sealed file of the state (reading may throw)
 * @param {string} o.dir MoMo's folder: a file that is not there is the empty state, read without making the folder
 * @param {(message: string) => void} o.report
 */
export function createEntitlementKeep({ gate, sealed, dir, report }) {
  const file = sealed('entitlement.json', entitlementStateShape);
  const present = () => fs.existsSync(path.join(dir, 'entitlement.json'));
  /** This process is the only writer, so what was read stays until `admit` changes it. @type {ReturnType<typeof entitlementStateShape> | null} */
  let kept = null;
  const state = () => {
    if (kept) return kept;
    try {
      return (kept = present() ? file.read() : emptyEntitlementState());
    } catch (error) {
      report(`MoMo's entitlement could not be read: ${/** @type {Error} */ (error).message}`);
      // unreadable means nothing is known about what was taken: as a signed state that has run out, never as a fresh one
      return { ...emptyEntitlementState(), signedSince: 0 };
    }
  };
  /** `admit` runs one at a time: two grants at once (a withdrawal and an older token) each read the state the other is about to change. @type {Promise<unknown>} */
  let turn = Promise.resolve();
  return {
    /** Whether the entitlement taken still stands (see the gate: where entitlements are required, one never taken does not). */
    standing: () => gate.standing(state()).live,
    /** Why it does not stand, in the gate's words (revoked, run out, none taken, not invited): null while it does. @returns {{ code: string, message: string } | null} */
    lapse() {
      const s = gate.standing(state());
      return s.live ? null : { code: s.code, message: s.message };
    },
    /** Whether this Host holds an account's entitlement to account for: from the first signed token on, an unsigned grant is refused (a move carries this to the next Host). */
    required: () => state().signedSince !== null,
    /** Marks this Host as one that needs a signed entitlement (a home moved here from one that did). */
    async require() {
      await file.change((e) => {
        if (e.signedSince === null) e.signedSince = gate.clockOf(e);
      });
      kept = null;
    },
    /**
     * The features the grant holds once the gate has judged the entitlement it came with (its state kept sealed), or a HostRefusal that says why; `eraseGrant` runs first when the entitlement was withdrawn or ran out, or is required and none came.
     * @param {{ account: string, features: string[], entitlement?: unknown }} grant
     * @param {() => Promise<void>} eraseGrant
     * @returns {Promise<string[]>}
     */
    async admit(grant, eraseGrant) {
      const run = turn.then(async () => {
        const before = state();
        const d = gate.accept(grant, before);
        if (d.state !== before) {
          try {
            // never behind what is stored: the newest floor and the latest time seen win
            await file.change((e) => {
              if (e.floorIat <= d.state.floorIat) Object.assign(e, d.state);
              else e.clockMark = Math.max(e.clockMark, d.state.clockMark);
            });
          } catch (error) {
            // what could not be kept cannot be relied on later (a replay would pass): the grant is refused
            report(`MoMo's entitlement could not be kept: ${/** @type {Error} */ (error).message}`);
            return /** @type {const} */ ({
              ok: false,
              code: 'entitlement_unwritable',
              message: ENTITLEMENT_FAILURES.entitlement_unwritable,
              erase: false,
            });
          }
          kept = null;
        }
        if (!d.ok) {
          const erase =
            d.code === 'entitlement_revoked' ||
            d.code === 'not_invited' ||
            d.code === 'entitlement_expired' ||
            (d.code === 'entitlement_missing' && gate.mode === 'required');
          return /** @type {const} */ ({ ok: false, code: d.code, message: d.message, erase });
        }
        if (d.warning) report(`MoMo grant without an entitlement: ${d.warning}`);
        return /** @type {const} */ ({ ok: true, features: d.features });
      });
      turn = run.catch(() => undefined);
      const d = await run;
      if (d.ok) return d.features;
      if (d.erase) await eraseGrant();
      throw new HostRefusal(d.code, d.message);
    },
  };
}
