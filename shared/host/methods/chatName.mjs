// The wire declaration of `chat.rename` (feature `chatName`): the owner's epoch and the key make a resend safe, as for every chat write.
import { NAME_FEATURE, nameOf } from '../chatName.mjs';

/** @param {{ effect: (p: any) => object, bad: (message: string) => Error }} kit */
export default ({ effect, bad }) => ({
  features: [NAME_FEATURE],
  methods: {
    'chat.rename': {
      access: 'paired',
      requires: ['epoch', 'dedupe', NAME_FEATURE],
      parse: (/** @type {any} */ p) => ({ ...effect(p), name: nameOf(p.name, bad) }),
    },
  },
});
