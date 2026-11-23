// Expo config plugin: drops the aps-environment and time-sensitive entitlements, which a free Apple account cannot sign, for a device build.
const { withEntitlementsPlist } = require('@expo/config-plugins');

/** Remove the push entitlements from the app's entitlements. */
function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    delete c.modResults['com.apple.developer.usernotifications.time-sensitive'];
    return c;
  });
}

module.exports = withoutPushEntitlement;
