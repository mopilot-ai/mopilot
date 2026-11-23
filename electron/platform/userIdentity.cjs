// The signed-in OS account name, for the profile shown when no MoPilot account is signed in.
const os = require('node:os');

/** Local profile fallback; unavailable OS account metadata must not prevent startup. */
function systemUsername(read = os.userInfo) {
  try {
    return read().username?.trim() || null;
  } catch {
    return null;
  }
}

module.exports = { systemUsername };
