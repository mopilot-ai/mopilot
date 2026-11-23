// High-risk sites whose ordinary actions the user allowed for good (#5464): the saved list's shape, and saving one with the write grant it needs.
const { originOf, covers } = require('./originPolicy.cjs');

/** Whether a saved file's `actions` is absent or a list of plain origins (anything else leaves the file untrusted and unwritten). */
const validActions = (/** @type {Record<string, unknown>} */ raw) =>
  !Object.hasOwn(raw, 'actions') ||
  (Array.isArray(raw.actions) && raw.actions.every((origin) => typeof origin === 'string' && originOf(origin) === origin));

/** The saved list, read back from a checked file. @param {any} data @returns {Set<string>} */
const actionsOf = (data) => new Set(Array.isArray(data?.actions) ? data.actions.filter((o) => originOf(o) === o) : []);

/** What the file keeps: the other saved keys, the site grants and the list when it has any site. */
function savedShape(
  /** @type {Record<string, unknown>} */ saved,
  /** @type {Map<string, string>} */ grants,
  /** @type {Set<string>} */ actions,
) {
  const { actions: _, ...rest } = saved;
  const list = [...actions].sort();
  return { ...rest, origins: Object.fromEntries(grants), ...(list.length ? { actions: list } : {}) };
}

/**
 * Saves a site's ordinary actions as allowed for good, and the site for reading and writing, which those actions need, when
 * the whole site is high-risk: a site only some pages of which are (risk is per path) gets no wider grant than it had.
 * Returns false for anything that isn't a plain origin; throws 'save_failed' (and keeps nothing) when the file can't be written.
 * @param {any} grants the OriginGrants table @param {string} origin
 */
function allowActions(grants, origin) {
  if (originOf(origin) !== origin) return false;
  if (grants.writeError) grants.load();
  const whole = grants.risk.classify(origin).level === 'high';
  if (grants.actions.has(origin) && (!whole || covers(grants.get(origin), 'write'))) return true;
  const previous = grants.get(origin);
  grants.actions.add(origin);
  if (whole) grants.grants.set(origin, 'write');
  try {
    grants.save();
  } catch (e) {
    grants.actions.delete(origin);
    if (previous === null) grants.grants.delete(origin);
    else grants.grants.set(origin, previous);
    throw e;
  }
  return true;
}

module.exports = { validActions, actionsOf, savedShape, allowActions };
