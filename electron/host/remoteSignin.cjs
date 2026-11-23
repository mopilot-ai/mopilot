// A remote Host's sign-in and sign-out requests (host.login*, host.logout) and the model key or organization lease lent with a chat's messages (host.modelKey, host.orgLease): each one control request through the shared parsers, joined into createRemoteHost (remote.cjs).

/**
 * @param {(method: string, params: object) => Promise<any>} control one control request to the Host
 */
function signinCalls(control) {
  return {
    /** Start signing in to a harness on the Host, or join the sign-in under way; its links and codes come back through `loginStatus`. @param {{ harness: string, methodId?: string }} p */
    login: (p) => control('host.login', p),
    /** How the harness's latest sign-in stands (null when none was started). @param {{ harness: string }} p */
    loginStatus: (p) => control('host.loginStatus', p),
    /** Stop the sign-in on the Host; false when none was under way. @param {{ harness: string }} p */
    loginCancel: (p) => control('host.loginCancel', p),
    /** One typed line for the sign-in under way (the code a page asks for): `{ accepted }`. @param {{ harness: string, text: string }} p */
    loginInput: (p) => control('host.loginInput', p),
    /** Sign the harness out on the Host: `{ harness, signedOut, error }`. A Host without sign-out refuses it as `feature_missing`. @param {{ harness: string }} p */
    logout: (p) => control('host.logout', p),
    /** Lend the harness's process a model key, or take it back (`key: null`): `{ held }`. A Host without it refuses as `feature_missing`. @param {{ harness: string, key: string | null }} p */
    modelKey: (p) => control('host.modelKey', p),
    /** Lend the harness's process an organization lease, or take it back (`token: null`): `{ held }`. A Host without it refuses as `feature_missing`. @param {{ harness: string, token: string | null, gateways?: Record<string, string>, expiresAt?: number }} p */
    orgLease: (p) => control('host.orgLease', p),
  };
}

module.exports = { signinCalls };
