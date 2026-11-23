// The wire method of MoMo's notices on a Host (host/src/momoNotice.mjs): the "why you saw this" of decisions, the Watching rows, the brief and catch-up cards shown, the collector's state, and the two things a person does to a matter (snooze it, dismiss it). It needs the `momo` feature, so a client that cannot see MoMo cannot ask.
import { MOMO_FEATURE } from './momo.mjs';

const OPS = ['decisions', 'watching', 'cards', 'state', 'snooze', 'dismiss', 'retry', 'moreReads'];
/** A matter's key: `gmail:<thread>` or `calendar:<event>`, plain characters only. */
const MATTER_KEY = /^[A-Za-z0-9._:-]{1,1100}$/;
/** A decision's id is a change's: the same shape. */
const CHANGE_ID = MATTER_KEY;
const MAX_IDS = 100;
const MAX_LIMIT = 200;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => ({
  methods: {
    'host.momoNotice': {
      access: 'open',
      requires: [MOMO_FEATURE],
      parse: (/** @type {any} */ p) => {
        const op = OPS.find((o) => o === p.op);
        if (!op) throw bad('That is not a step of the notices.');
        if (op === 'decisions') {
          if (p.ids !== undefined && (!Array.isArray(p.ids) || p.ids.length > MAX_IDS)) throw bad('Those are not decision ids.');
          if (p.limit !== undefined && !(Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= MAX_LIMIT))
            throw bad('That is not a limit.');
          return {
            op,
            ...(p.ids ? { ids: p.ids.map((/** @type {unknown} */ id) => matchOf(id, CHANGE_ID, 'That is not a decision id.')) } : {}),
            ...(p.matterKey !== undefined ? { matterKey: matchOf(p.matterKey, MATTER_KEY, 'That is not a matter key.') } : {}),
            ...(p.limit !== undefined ? { limit: p.limit } : {}),
          };
        }
        if (op === 'snooze') {
          if (!Number.isFinite(p.until) || p.until <= 0) throw bad('That is not a time to snooze until.');
          return { op, matterKey: matchOf(p.matterKey, MATTER_KEY, 'That is not a matter key.'), until: Math.floor(p.until) };
        }
        if (op === 'dismiss') return { op, matterKey: matchOf(p.matterKey, MATTER_KEY, 'That is not a matter key.') };
        return { op };
      },
    },
  },
});
