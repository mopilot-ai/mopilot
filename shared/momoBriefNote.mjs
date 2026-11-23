// The suggestion card a MoMo morning brief puts in its chat (A7): a note of kind 'brief' with a `suggestion` ({ id, title, source }), checked the same way where main writes it, the Mac's chat draws it and the phone reads its row. Any other value is no card (the note is then only its line).

/** @typedef {{ id: string, title: string, source: string }} BriefCard */

const text = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * The card a note or row names, or null: an id the suggestion store gave and the title and source line shown with it.
 * @param {unknown} raw @returns {BriefCard | null}
 */
export function briefCardOf(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : null;
  const id = typeof o?.id === 'string' ? o.id : '';
  const title = text(o?.title, 120);
  if (!o || !/^[\w.:-]{1,64}$/.test(id) || !title) return null;
  return { id, title, source: text(o.source, 100) };
}
