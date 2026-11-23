// MGB F6 (#1381, harness switch mid-task) shared helpers: ordinals for split work, values recorded more than once
// (a duplicate submission after the switch), and the id a fixture app names in its confirmation redirect.

/** Ordinals for checkpoint titles. */
export const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** The values that occur more than once in a list, each named once. @param {unknown[]} values */
export const repeated = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

/**
 * The id a fixture app's confirmation names in its redirect ("Refund RF-3 of …", "Created OPS-7.", "Request Q-2
 * received."), read with a pattern whose first group is the id. Throws when the redirect names none: an oracle bug.
 * @param {{ headers: Record<string, string> }} res @param {RegExp} pattern
 */
export function confirmedId(res, pattern) {
  const m = pattern.exec(decodeURIComponent(res.headers.location ?? ''));
  if (!m) throw new Error(`no id in the redirect to ${res.headers.location}`);
  return m[1];
}
