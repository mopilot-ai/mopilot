// Native benchmark AX focus recovery uses a node budget instead of assuming a shallow app tree.
/** @param {any[]} roots @param {number} [budget] */
export function focusTextAreaTree(roots, budget = 2048) {
  const pending = [...roots].reverse();
  let visited = 0;
  while (pending.length && visited < budget) {
    const node = pending.pop();
    visited++;
    try {
      if (node.role() === 'AXTextArea' && node.enabled() !== false) {
        node.focused = true;
        if (node.focused() === true) return 'ok';
      }
    } catch {
      // A stale or unfocusable element is not a successful focus.
    }
    try {
      const children = node.uiElements();
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    } catch {
      // Inaccessible descendants cannot identify a composer.
    }
  }
  return 'none';
}

/** The actual operation runs inside System Events, not against a fabricated tree shape. @param {string} app */
export const focusTextAreaScript = (app) =>
  `function run(){return (${focusTextAreaTree.toString()})(Application('System Events').processes.byName(${JSON.stringify(app)}).windows());}`;
