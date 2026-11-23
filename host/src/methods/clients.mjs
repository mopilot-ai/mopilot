// The Host's handlers for the client table's methods (host.client*): they need the caller's standing, which only a connection has, so protocol.mjs serves them there and a request that reaches this table is refused.
import { CLIENT_METHODS } from '../../../shared/host/clients.mjs';
import { UnsupportedError } from '../errors.mjs';

export default () => ({
  handlers: Object.fromEntries(
    CLIENT_METHODS.map((m) => [
      m,
      () => {
        throw new UnsupportedError('This connection has no standing to use the client table.');
      },
    ]),
  ),
});
