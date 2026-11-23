// Deleting an atomic skill token beside the composer caret with Backspace or Delete, through the native undo stack.

/** Find the skill immediately beside a collapsed caret, ignoring empty caret-host text nodes. */
function adjacentSkill(el: HTMLElement, range: Range, backward: boolean) {
  if (!range.collapsed || !el.contains(range.startContainer)) return null;
  let node: Node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    if (range.startOffset !== (backward ? 0 : node.textContent!.length)) return null;
  } else {
    const child = node.childNodes[range.startOffset - (backward ? 1 : 0)];
    if (child) {
      if (child.nodeType !== Node.TEXT_NODE || child.textContent) return edgeSkill(child, backward);
      node = child;
    }
  }
  while (node !== el) {
    if (/^(DIV|P|LI|OL|UL)$/.test(node.nodeName)) return null;
    const sibling = backward ? node.previousSibling : node.nextSibling;
    if (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE && !sibling.textContent) {
        node = sibling;
        continue;
      }
      return edgeSkill(sibling, backward);
    }
    node = node.parentNode!;
  }
  return null;
}

function edgeSkill(node: Node, backward: boolean): HTMLElement | null {
  if (node instanceof HTMLElement && node.hasAttribute('data-skill-id')) return node;
  if (
    node.nodeType === Node.TEXT_NODE ||
    /^(BR|DIV|P|LI|OL|UL)$/.test(node.nodeName) ||
    (node instanceof HTMLElement && node.hasAttribute('data-session-token'))
  )
    return null;
  const children = Array.from(node.childNodes);
  if (backward) children.reverse();
  const child = children.find((n) => n.nodeType !== Node.TEXT_NODE || !!n.textContent);
  return child ? edgeSkill(child, backward) : null;
}

/** Delete only an adjacent atomic skill through the native undo boundary. */
export function deleteAdjacentSkill(
  el: HTMLElement,
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>,
  blocked: boolean,
): boolean {
  if (
    blocked ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    (event.key !== 'Backspace' && event.key !== 'Delete')
  )
    return false;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const skill = adjacentSkill(el, range, event.key === 'Backspace');
  if (!skill) return false;
  range.selectNode(skill);
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand('delete');
}
