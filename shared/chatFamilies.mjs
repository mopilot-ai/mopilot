// Ordered families of linked chats, as the Mac sidebar and the phone's chat list nest them: each root at its best member's position, its descendants depth-first at one visual level.

/**
 * `listed` already follows the list's order; `parentOf` names the chat that started one (null for none). A chat is
 * nested only under a listed parent, and malformed ancestry (a loop) never hides or duplicates a listed chat.
 * @param {readonly string[]} listed
 * @param {(id: string) => string | null | undefined} parentOf
 */
export function chatFamilies(listed, parentOf) {
  const ids = [...new Set(listed)];
  const shown = new Set(ids);
  const parent = (/** @type {string} */ id) => {
    const owner = parentOf(id);
    return owner && shown.has(owner) ? owner : null;
  };
  /** @type {Map<string, string>} */
  const rootOf = new Map();
  /** @type {Set<string>} */
  const invalid = new Set();
  for (const id of ids) {
    /** @type {string[]} */
    const path = [];
    const seen = new Set();
    let head = id;
    let cyclic = false;
    while (!rootOf.has(head)) {
      if (seen.has(head)) {
        cyclic = true;
        break;
      }
      seen.add(head);
      path.push(head);
      const owner = parent(head);
      if (owner === null) break;
      head = owner;
    }
    cyclic ||= invalid.has(head);
    const root = rootOf.get(head) ?? head;
    for (const member of path) {
      rootOf.set(member, cyclic ? member : root);
      if (cyclic) invalid.add(member);
    }
  }
  const roots = [...new Set(ids.map((id) => /** @type {string} */ (rootOf.get(id))))];
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const id of ids) {
    if (id === rootOf.get(id)) continue;
    const owner = /** @type {string} */ (parent(id));
    const siblings = children.get(owner) ?? [];
    siblings.push(id);
    children.set(owner, siblings);
  }
  /** @type {Map<string, string[]>} */
  const descendants = new Map();
  for (const head of roots) {
    /** @type {string[]} */
    const rows = [];
    const pending = [...(children.get(head) ?? [])].reverse();
    while (pending.length) {
      const next = /** @type {string} */ (pending.pop());
      rows.push(next);
      pending.push(...[...(children.get(next) ?? [])].reverse());
    }
    descendants.set(head, rows);
  }
  return { roots, descendants };
}
