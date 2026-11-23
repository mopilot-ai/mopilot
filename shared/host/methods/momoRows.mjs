// The wire method that reads the rows MoMo's chat holds beyond the harness's words (shared/momoView.ts `MomoChatRow`): the approval and question cards, a task's result, a watch that changed. It needs the `momo` feature, so an older Host or an ungranted client sees an unknown request.
import { MOMO_FEATURE } from './momo.mjs';

/** @param {{ bad: (message: string) => Error }} kit */
export default ({ bad }) => ({
  features: [MOMO_FEATURE],
  methods: {
    // the rows written or changed after a time (all when none), oldest first, and the time to ask from next
    'host.momoRows': {
      access: 'open',
      requires: [MOMO_FEATURE],
      parse: (/** @type {any} */ p) => {
        /** @type {{ after?: number, limit?: number }} */
        const out = {};
        if (p?.after !== undefined && p?.after !== null) {
          if (!Number.isSafeInteger(p.after) || p.after < 0) throw bad('That is not a time to read rows from.');
          out.after = p.after;
        }
        if (p?.limit !== undefined && p?.limit !== null) {
          if (!Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 100) throw bad('That is not a number of rows to read.');
          out.limit = p.limit;
        }
        return out;
      },
    },
  },
});
