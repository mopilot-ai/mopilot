// The update channel an install follows. Dogfood builds are for internal (staff) MoPilot accounts;
// anyone else who picked it, or who signed out, follows beta instead.
// src/lib/updateChannel.ts applies the same rule to what Settings shows.
function updateChannel(pref, internal) {
  if (pref === 'dogfood') return internal ? 'dogfood' : 'beta';
  return pref === 'beta' ? 'beta' : 'stable';
}

module.exports = { updateChannel };
