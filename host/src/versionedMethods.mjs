// Which requests need `host.hello` first on their connection: the one rule the Host's server (server.mjs, protocol.mjs HelloRequiredError) and every fake Host that stands in for it follow.

/** The methods of the versioned protocol: a connection may use them only after `host.hello`. */
export const VERSIONED_METHOD = /^(host|chat|browser|desktop)\./;
/** The versioned-looking methods a connection may call before `host.hello`: the handshake itself and the pairing proof, which the server answers before any session. */
export const BEFORE_HELLO = new Set(['host.hello', 'host.challenge', 'host.pair', 'host.auth']);
