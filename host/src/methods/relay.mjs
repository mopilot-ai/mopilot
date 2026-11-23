// The Host's handlers for the relay path's methods (host.relay*): they enroll, forget and report the links to the relay.
import { UnsupportedError } from '../errors.mjs';

/** @param {{ relay?: ReturnType<typeof import('../relayLink.mjs').createRelayLinks> }} deps */
export default ({ relay }) => {
  const linked = () => {
    if (!relay) throw new UnsupportedError('This host cannot be reached through a relay.');
    return relay;
  };
  return {
    handlers: {
      'host.relayEnroll': (/** @type {any} */ p) => linked().enroll(p),
      'host.relayForget': (/** @type {any} */ p) => linked().forget(p),
      'host.relayStatus': () => linked().status(),
    },
  };
};
