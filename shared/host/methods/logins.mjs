// The wire method that pins a chat to one login of its agent on a machine, or lets it go (shared/host/logins.mjs): an older Host has none, so an app without the feature is refused, never served half.
import { LOGINS_FEATURE, credentialOf } from '../logins.mjs';

/** @param {{ bad: (message: string) => Error, effect: (p: any) => object }} kit */
export default ({ bad, effect }) => ({
  features: [LOGINS_FEATURE],
  methods: {
    'chat.login': {
      access: 'paired',
      requires: ['epoch', 'dedupe', LOGINS_FEATURE],
      parse: (/** @type {any} */ p) => ({
        ...effect(p),
        login: p.login == null ? null : credentialOf({ source: 'own', login: p.login }, bad).login,
      }),
    },
  },
});
