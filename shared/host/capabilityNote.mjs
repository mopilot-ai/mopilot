// The one limit a machine puts on a chat, from the Host's declared capabilities, for the composer's machine menu: nothing when it can do everything, else what it can't ("No computer use"). No harness is named.

const SURFACES = /** @type {const} */ ([
  ['iab', 'browser'],
  ['desktop', 'computer use'],
]);

/** '' when the machine has every surface, else "No browser", "No computer use" or "No browser or computer use". @param {Record<string, boolean | undefined>} caps */
export function capabilityNote(caps) {
  const missing = SURFACES.filter(([key]) => caps[key] !== true).map(([, label]) => label);
  return missing.length ? `No ${missing.join(' or ')}` : '';
}
