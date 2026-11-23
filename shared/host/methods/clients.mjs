// The Host's client table methods (host/src/hostClients.mjs): who is paired, adding, removing and renaming a client; an older Host has none, so an app without the feature is refused, never served half.
import { CLIENTS_FEATURE, CLIENT_METHODS, clientParsers } from '../clients.mjs';

const parsers = clientParsers();

export default {
  features: [CLIENTS_FEATURE],
  methods: Object.fromEntries(CLIENT_METHODS.map((m) => [m, { access: 'paired', requires: [CLIENTS_FEATURE], parse: parsers[m] }])),
};
