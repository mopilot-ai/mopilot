// Mobile Remote identifies its owner by the signed-in account and its current desktop device.
function accountScope(account) {
  const c = account?.creds;
  const user = c?.user?.id;
  const device = c?.deviceId;
  return typeof user === 'string' && user.length > 0 && typeof device === 'string' && device.length > 0
    ? JSON.stringify([user, device])
    : null;
}
/** The signed-in user behind a MoPilot account object (id and email), or undefined: what the pairing QR's account hint is made from. */
const accountUser = (account) => account?.creds?.user;
module.exports = { accountScope, accountUser };
