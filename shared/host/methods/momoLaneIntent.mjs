// The wire method that runs one intent of a lane that lives on the Host (shared/momoIntents.mjs `HOST_LANES`: gate, tasks, notice, google): the Mac's home API forwards every such intent here, to the Host that is the home. Needs the `momo` feature.
import { MOMO_FEATURE } from './momo.mjs';
import { INTENT_TABLE, HOST_LANES } from '../../momoIntents.mjs';

/** @param {{ bad: (message: string) => Error }} kit */
export default ({ bad }) => ({
  features: [MOMO_FEATURE],
  methods: {
    'host.momoLaneIntent': {
      access: 'open',
      requires: [MOMO_FEATURE],
      parse: (/** @type {any} */ p) => {
        const intent = p?.intent;
        const entry =
          intent &&
          typeof intent === 'object' &&
          !Array.isArray(intent) &&
          typeof intent.kind === 'string' &&
          Object.hasOwn(INTENT_TABLE, intent.kind)
            ? INTENT_TABLE[intent.kind]
            : null;
        if (!entry || !(/** @type {readonly string[]} */ (HOST_LANES).includes(entry.lane)))
          throw bad('That is not something MoMo can do.');
        if (JSON.stringify(intent).length > 16_000) throw bad('That is too long for MoMo to take.');
        return { intent };
      },
    },
  },
});
