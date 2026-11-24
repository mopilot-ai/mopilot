// The id of a fix the view offers (`{ kind: 'fix', id }`), built and read in one place: a kind, then its fields, each field encoded, separated by `:`. A machine's own id has a `:` in it (`ssh:user@host`), a message's id may have anything, so no field is ever put into the string as it is, and no code splits one by hand.

/** @param {string} kind @param {...string} fields @returns {string} */
export const fixId = (kind, ...fields) => [kind, ...fields.map((f) => encodeURIComponent(f))].join(':');

/**
 * The kind and the fields of a fix id, or null for one that is not well formed (a field that does not decode).
 * @param {unknown} id @returns {{ kind: string, fields: string[] } | null}
 */
export function parseFixId(id) {
  if (typeof id !== 'string') return null;
  const [kind = '', ...rest] = id.split(':');
  try {
    return { kind, fields: rest.map((f) => decodeURIComponent(f)) };
  } catch {
    return null;
  }
}
