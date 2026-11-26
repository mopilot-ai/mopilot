// What this Mac says when its own approval step fails (the Touch ID or password helper, electron/host/codePairApprove.cjs, R2b of #5576): each line is the cause and the fix in place. Host refusals are in refusalWords.mjs.
export const APPROVAL_WORDS = Object.freeze({
  not_approved: 'Not allowed yet: the Touch ID or password prompt was cancelled.',
  no_key: 'This Mac isn’t set up to allow pairings yet. Set it up, then make a new code.',
  no_helper: 'MoPilot’s approval helper is missing. Update MoPilot on this Mac.',
  bad_fields: 'The request changed before you allowed it. Make a new code.',
  keychain: 'This Mac’s keychain didn’t answer. Unlock it, then try again.',
  secure_enclave: 'This Mac’s Secure Enclave didn’t answer. Try again, or restart this Mac.',
  unsupported_platform: 'Allowing a pairing works on Macs only.',
  host_unreachable: 'This Mac’s Host isn’t answering. Wait a moment, then make a new code.',
  unsupported: 'This Mac’s Host is too old for pairing by code. Update MoPilot, then make a new code.',
  unauthorized: 'Sign in to MoPilot on this Mac, then make a new code.',
  already_enrolled: 'This Mac is already set up to allow pairings. Make a code.',
  busy: 'Touch ID or your password is already being asked for on this Mac. Answer that first.',
  approval_out_of_sync: 'This Mac’s Host and its approval key don’t match. Reset pairing approval, then set it up again.',
  expired: 'The request waited too long. Ask the other device to enter a new code.',
});

/** The words for an approval failure, or null for a code that is not the helper's. @param {string} code */
export const approvalWords = (code) =>
  Object.hasOwn(APPROVAL_WORDS, code) ? APPROVAL_WORDS[/** @type {keyof typeof APPROVAL_WORDS} */ (code)] : null;
