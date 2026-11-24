// The Host's handler for `host.momoLaneIntent` (shared/host/methods/momoLaneIntent.mjs): one intent of a lane that lives here, run through the home's registry (the kind and its arguments checked against the table, and that this Host is the running home), for a paired desktop or phone with a live grant, never the local command line. A refusal is an answer, `{ ok: false, cause }`, with the words the person reads; only the lanes' own refusals are worded, anything else is "MoMo couldn't do that".
import { deviceOf } from '../momoDevice.mjs';
import { isOwner } from '../momoOwner.mjs';
import { onlyAtHome } from '../momoHomeGuard.mjs';
import { IntentError } from '../../../shared/momoHomeApi.mjs';
import { HostRefusal } from '../hostFs.mjs';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => ({
  guard: onlyAtHome(momo),
  veils: { 'host.momoLaneIntent': (/** @type {unknown} */ principal) => !!momo && isOwner(principal) && !!momo.granted() },
  handlers: {
    'host.momoLaneIntent': async (
      /** @type {{ intent: { kind: string, [key: string]: unknown } }} */ { intent },
      /** @type {string} */ _kind = '',
      /** @type {unknown} */ who = undefined,
    ) => {
      const table = /** @type {NonNullable<NonNullable<typeof momo>['intentRegistry']>} */ (
        /** @type {NonNullable<typeof momo>} */ (momo).intentRegistry
      )().intents();
      // an own entry only: a kind named like an Object.prototype member ('constructor', 'toString') is no handler
      const run = Object.hasOwn(table, intent.kind) ? table[intent.kind] : undefined;
      if (!run) return { ok: false, cause: 'MoMo can’t do that yet.' };
      try {
        // who is acting is the connection's own standing and nothing the client sent: any `by`, `device` or `principal` field of the intent is dropped, and `by` is set from the connection
        const { by: _by, device: _device, principal: _principal, ...theirs } = /** @type {Record<string, unknown>} */ (intent);
        return { ok: true, value: (await run({ ...theirs, by: deviceOf(who) })) ?? null };
      } catch (error) {
        if (error instanceof IntentError)
          return { ok: false, cause: error.message, ...(error.fix && error.fixLabel ? { fix: error.fix, fixLabel: error.fixLabel } : {}) };
        if (error instanceof HostRefusal) return { ok: false, cause: error.message };
        return { ok: false, cause: 'MoMo couldn’t do that.' };
      }
    },
  },
});
