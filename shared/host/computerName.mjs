// A computer's own name as a Host reports it (`host.status` `computerName`) and an app reads it: the phone's cleaning (shared/remote/computerName.mjs: no control, zero-width or bidi characters, one line, at most 64, no ".local") plus one label of a network name, and nothing for a name that names no computer ("localhost"), so the Host and every client agree on what a valid name is.
import { cleanComputerName } from '../remote/computerName.mjs';

/** A name every machine has and none is called by. */
const GENERIC = /^localhost(\.localdomain)?\.?$/i;

/**
 * The name a machine goes by, from what its Host (or the system) said; '' for anything that is not a usable name.
 * "Dus-Mac-mini.local" and "box.example.com" give their first label; an address ("192.168.64.1") and a name with spaces stay whole.
 * @param {unknown} raw
 * @returns {string}
 */
export function computerNameOf(raw) {
  const clean = cleanComputerName(raw);
  if (!clean || GENERIC.test(clean)) return '';
  return /^\d+(\.\d+){3}$/.test(clean) || clean.includes(' ') ? clean : clean.split('.')[0];
}

/**
 * The name a machine had before its Host said one: the text after the `@` of the address that was typed.
 * @param {string} address
 */
export const addressName = (address) => /** @type {string} */ (String(address).split('@').pop());
