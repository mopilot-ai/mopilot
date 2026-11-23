// A remote Host's owner policy request (plan U2): the owner's document sent with host.policy, one control request through the shared parser, joined into createRemoteHost (remote.cjs).

/**
 * @param {(method: string, params: object) => Promise<any>} control one control request to the Host
 */
function policyCalls(control) {
  return {
    /** Replaces the machine's owner layer: `{ generation }`. A Host without the feature refuses as `feature_missing`; a phone-kind client is refused as `policy_refused`. @param {{ doc: object }} p */
    policy: (p) => control('host.policy', p),
  };
}

module.exports = { policyCalls };
