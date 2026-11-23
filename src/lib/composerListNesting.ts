// Atomic list-subtree indentation preserves descendants, chip identities and selection through native undo.
import { replaceComposerBlocks } from './composerBlockEdit';

type Editor = HTMLElement & { value: string; selectionStart: number; setSelectionRange(start: number, end: number): void };
const listTag = /^(OL|UL)$/;
let sequence = 0;

/** Chromium places child lists beside LI; transform an owned clone with child lists inside their owner. */
function ownChildren(root: HTMLElement) {
  for (const list of root.querySelectorAll('ol, ul')) {
    if (!listTag.test(list.parentElement!.nodeName)) continue;
    const owner = list.previousElementSibling;
    if (owner?.nodeName === 'LI') owner.append(list);
  }
}

function nativeChildren(root: HTMLElement) {
  for (const item of Array.from(root.querySelectorAll('li')).reverse()) {
    let after: Element = item;
    for (const list of Array.from(item.children).filter((node) => listTag.test(node.nodeName))) {
      after.after(list);
      after = list;
    }
  }
}

/** Move a contiguous sibling selection together with every descendant, using one undoable replacement. */
export function nestComposerList(editor: Editor, outdent: boolean) {
  const selection = window.getSelection()!;
  const original = selection.getRangeAt(0).cloneRange();
  const itemAt = (node: Node) => (node instanceof HTMLElement ? node : node.parentElement)?.closest('li');
  const first = itemAt(original.startContainer);
  const last = itemAt(original.endContainer);
  if (!first || !last) return true;
  let top = first.parentElement!;
  for (let parent = top.parentElement?.closest('ol, ul'); parent; parent = parent.parentElement?.closest('ol, ul'))
    top = parent as HTMLElement;
  if (!top.contains(last)) return true;
  const offset = (node: Node, position: number) => {
    selection.collapse(node, position);
    return editor.selectionStart;
  };
  const start = offset(original.startContainer, original.startOffset) - offset(first, 0);
  const end = offset(original.endContainer, original.endOffset) - offset(last, 0);
  selection.removeAllRanges();
  selection.addRange(original);
  const container = document.createElement('div');
  const clone = top.cloneNode(true) as HTMLElement;
  container.append(clone);
  const originals = Array.from(top.querySelectorAll('li'));
  const copies = Array.from(clone.querySelectorAll('li'));
  const a = copies[originals.indexOf(first)];
  const b = copies[originals.indexOf(last)];
  ownChildren(clone);
  // A selection that crosses list levels has no single sibling range to move.
  if (a.parentElement !== b.parentElement) return true;
  const source = a.parentElement!;
  const siblings = Array.from(source.children);
  const picked = siblings.slice(siblings.indexOf(a), siblings.indexOf(b) + 1) as HTMLElement[];
  const previous = a.previousElementSibling;
  if (!outdent && !previous) return true;
  const key = String(++sequence);
  a.dataset.composerListSelection = `${key}-start`;
  b.dataset.composerListEnd = `${key}-end`;
  for (const item of picked) for (const list of item.querySelectorAll<HTMLElement>('ol, ul')) delete list.dataset.composerIndent;
  if (!outdent) {
    let destination = previous!.lastElementChild;
    if (destination?.nodeName !== source.nodeName) {
      destination = document.createElement(source.nodeName.toLowerCase());
      previous!.append(destination);
    }
    delete (destination as HTMLElement).dataset.composerIndent;
    destination.append(...picked);
  } else if (source.parentElement!.nodeName === 'LI') {
    const owner = source.parentElement!;
    const following = siblings.slice(siblings.indexOf(b) + 1);
    if (following.length) {
      const children = source.cloneNode(false) as HTMLElement;
      delete children.dataset.composerIndent;
      children.append(...following);
      b.append(children);
    }
    owner.after(...picked);
  } else {
    const following = source.cloneNode(false) as HTMLElement;
    const rest = siblings.slice(siblings.indexOf(b) + 1);
    if (source.nodeName === 'OL')
      following.setAttribute('start', String(Number(source.getAttribute('start') ?? 1) + siblings.indexOf(b) + 1));
    following.append(...rest);
    const outside: HTMLElement[] = [];
    for (const item of picked) {
      const paragraph = document.createElement('div');
      for (const attr of ['data-composer-list-selection', 'data-composer-list-end']) {
        const value = item.getAttribute(attr);
        if (value) paragraph.setAttribute(attr, value);
      }
      const children = Array.from(item.children).filter((node) => listTag.test(node.nodeName));
      paragraph.append(...Array.from(item.childNodes).filter((node) => !children.includes(node as Element)));
      outside.push(paragraph, ...(children as HTMLElement[]));
      item.remove();
    }
    source.after(...outside, ...(rest.length ? [following] : []));
  }
  if (!source.children.length) source.remove();
  nativeChildren(container);
  if (!replaceComposerBlocks(editor, top, top, container.innerHTML)) return true;
  const from = editor.querySelector<HTMLElement>(`[data-composer-list-selection="${key}-start"]`)!;
  const to = editor.querySelector<HTMLElement>(`[data-composer-list-end="${key}-end"]`)!;
  const left = offset(from, 0) + start;
  const right = offset(to, 0) + end;
  delete from.dataset.composerListSelection;
  delete to.dataset.composerListEnd;
  editor.setSelectionRange(left, right);
  return true;
}
