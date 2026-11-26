// Structured composer lists: Markdown restoration, generated markers and native undoable list commands.
import { imeComposing } from './focus';
import { hasComposerContent, replaceComposerBlocks, selectsComposerContents } from './composerBlockEdit';
import { nestComposerList } from './composerListNesting';

const marker = /^([ \t]*)(?:((?:0|[1-9]\d{0,8}))\. |([-+*]) )(.*)$/;

function nextFence(fence: string, text: string) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(text);
  if (!match) return fence;
  if (!fence) return match[1];
  return match[1][0] === fence[0] && match[1].length >= fence.length && /^[ \t]*$/.test(text.slice(match[0].length)) ? '' : fence;
}

function listLine(text: string) {
  const match = marker.exec(text);
  return match && { indent: match[1], number: match[2], bullet: match[3], content: match[4], prefix: text.length - match[4].length };
}

/** The characters represented by a browser-generated list marker, including nesting. */
export function listItemPrefix(
  item: HTMLElement,
  index = Array.from(item.parentElement!.children)
    .filter((child) => child.nodeName === 'LI')
    .indexOf(item),
  prefixes?: Map<HTMLElement, string>,
): string {
  const list = item.parentElement!;
  let owner = list.parentElement?.nodeName === 'LI' ? list.parentElement : list.previousElementSibling;
  while (owner && /^(OL|UL)$/.test(owner.nodeName)) owner = owner.previousElementSibling;
  const parentPrefix = owner instanceof HTMLElement && owner.nodeName === 'LI' ? (prefixes?.get(owner) ?? listItemPrefix(owner)) : '';
  const width = (text: string) => [...text].reduce((column, char) => column + (char === '\t' ? 4 - (column % 4) : 1), 0);
  const stored = list.dataset.composerIndent ?? '';
  // A native split can renumber 9 to 10 (or 99 to 100); its children must still parse under that parent.
  const indent = width(stored) >= width(parentPrefix) ? stored : ' '.repeat(width(parentPrefix));
  const start = Number(list.getAttribute('start') ?? 1);
  const number = (Number.isSafeInteger(start) ? start : 1) + index;
  return indent + (list.nodeName === 'OL' ? `${number}. ` : `${list.dataset.composerBullet ?? '-'} `);
}

/** Restore lists from safe text/chip nodes. Existing chip nodes move intact, including their React icon hosts. */
export function restoreComposerLists(root: HTMLElement) {
  const original = Array.from(root.childNodes);
  const rows: Node[][] = [[]];
  for (const node of original) {
    if (node.nodeType !== Node.TEXT_NODE) {
      rows.at(-1)!.push(node);
      continue;
    }
    for (const [index, text] of (node as Text).data.split('\n').entries()) {
      if (index) rows.push([]);
      rows.at(-1)!.push(document.createTextNode(text));
    }
  }
  const output = document.createDocumentFragment();
  const stack: { indent: string; list: HTMLElement; count: number }[] = [];
  let fence = '';
  let found = false;
  for (const nodes of rows) {
    let plain = '';
    for (const node of nodes) {
      if (node instanceof HTMLElement && node.hasAttribute('data-skill-id')) continue;
      if (node.nodeType !== Node.TEXT_NODE) break;
      plain += node.textContent;
    }
    const inFence = !!fence;
    fence = nextFence(fence, plain);
    const line = !inFence && !fence ? listLine(plain) : null;
    if (!line || (!stack.length && line.indent.length >= 4)) {
      stack.length = 0;
      const block = document.createElement('div');
      block.append(...nodes);
      if (!block.textContent && !block.querySelector('[data-skill-id], [data-session-token]')) block.append(document.createElement('br'));
      output.append(block);
      continue;
    }
    found = true;
    while (stack.length && stack.at(-1)!.indent.length > line.indent.length) stack.pop();
    const tag = line.number ? 'OL' : 'UL';
    let entry = stack.at(-1);
    if (
      entry?.indent === line.indent &&
      (entry.list.nodeName !== tag || (tag === 'UL' && entry.list.dataset.composerBullet !== line.bullet))
    ) {
      stack.pop();
      entry = stack.at(-1);
    }
    if (entry?.indent === line.indent && line.number && Number(line.number) !== Number(entry.list.getAttribute('start')) + entry.count) {
      stack.pop();
      entry = stack.at(-1);
    }
    if (!entry || entry.indent !== line.indent) {
      const list = document.createElement(tag.toLowerCase());
      list.dataset.composerIndent = line.indent;
      if (line.number) list.setAttribute('start', line.number);
      else list.dataset.composerBullet = line.bullet;
      // Match Chromium's native indent/outdent DOM: nested lists are direct list children.
      (entry ? entry.list : output).append(list);
      entry = { indent: line.indent, list, count: 0 };
      stack.push(entry);
    }
    const item = document.createElement('li');
    let remove = line.prefix;
    for (const node of nodes) {
      if (remove && node.nodeType === Node.TEXT_NODE) {
        const text = (node as Text).data;
        node.textContent = text.slice(remove);
        remove = Math.max(0, remove - text.length);
      }
      item.append(node);
    }
    if (!item.textContent && !item.querySelector('[data-skill-id], [data-session-token]')) item.append(document.createElement('br'));
    entry.list.append(item);
    entry.count++;
  }
  root.replaceChildren(...(found ? [output] : original));
  return found;
}

type ListEditor = HTMLElement & { value: string; selectionStart: number; setSelectionRange(start: number, end: number): void };

/** Convert a just-typed marker; native commands keep the user's editing history. */
export function startComposerList(editor: ListEditor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return false;
  const parent = selection.anchorNode instanceof HTMLElement ? selection.anchorNode : selection.anchorNode?.parentElement;
  if (parent?.closest('li, pre, code, [data-skill-id], [data-session-token]')) return false;
  const text = editor.value;
  const caret = editor.selectionStart;
  const before = text.slice(0, caret);
  const line = listLine(before.slice(before.lastIndexOf('\n') + 1));
  if (!line || line.content || line.indent || before.split('\n').reduce(nextFence, '')) return false;
  // A skill has zero prompt characters. Select the typed marker itself, never a leading skill at the same offset.
  const anchor = selection.anchorNode;
  if (anchor?.nodeType !== Node.TEXT_NODE || selection.anchorOffset < line.prefix) return false;
  const original = selection.getRangeAt(0).cloneRange();
  const markerOffset = selection.anchorOffset - line.prefix;
  const newline = text.indexOf('\n', caret);
  editor.setSelectionRange(caret, newline < 0 ? text.length : newline);
  const range = selection.getRangeAt(0);
  // Include adjacent zero-width skill chips at the end of this line in the same native transaction.
  let tail =
    range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endOffset === (range.endContainer as Text).data.length
        ? range.endContainer.nextSibling
        : null
      : range.endContainer.childNodes[range.endOffset];
  while (
    tail &&
    ((tail.nodeType === Node.TEXT_NODE && !tail.textContent) || (tail instanceof HTMLElement && tail.hasAttribute('data-skill-id')))
  ) {
    range.setEndAfter(tail);
    tail = tail.nextSibling;
  }
  const list = document.createElement(line.number ? 'ol' : 'ul');
  if (line.number) list.setAttribute('start', line.number);
  else list.dataset.composerBullet = line.bullet;
  const item = document.createElement('li');
  item.append(range.cloneContents());
  if (!item.hasChildNodes() || !item.textContent) item.append(document.createElement('br'));
  list.append(item);
  // The new block supplies this separator; retaining a literal newline would add a blank line.
  if (range.endContainer.nodeType === Node.TEXT_NODE && (range.endContainer as Text).data[range.endOffset] === '\n')
    range.setEnd(range.endContainer, range.endOffset + 1);
  range.setStart(anchor, markerOffset);
  // Explicit markup prevents Chromium from merging a requested start into a preceding list.
  // One native transaction replaces only the marker; a refused command retains it verbatim.
  const beforeHTML = editor.innerHTML;
  let inserted = false;
  try {
    // Chromium can return false after successfully inserting a chip's SVG; observe the owned DOM too.
    inserted = document.execCommand('insertHTML', false, list.outerHTML) || editor.innerHTML !== beforeHTML;
    return inserted;
  } finally {
    if (inserted) editor.setSelectionRange(caret, caret);
    else {
      selection.removeAllRanges();
      selection.addRange(original);
    }
  }
}

/** Called after send/menu shortcuts to edit list structure through native history. */
export function editComposerList(editor: ListEditor, event: KeyboardEvent, blocked: boolean) {
  if (blocked || imeComposing(event) || event.metaKey || event.ctrlKey) return false;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return false;
  if ((event.key === 'Backspace' || event.key === 'Delete') && !event.shiftKey && !event.altKey && !selection.isCollapsed) {
    // Chromium can delete every selected character and still leave the first generated marker active.
    return (
      !!editor.querySelector('li') &&
      selectsComposerContents(editor, selection.getRangeAt(0)) &&
      replaceComposerBlocks(editor, editor.firstChild!, editor.lastChild!, '<div><br></div>')
    );
  }
  const node = selection.anchorNode;
  const item = (node instanceof HTMLElement ? node : node?.parentElement)?.closest('li');
  if (!item) return false;
  if (event.key === 'Enter') {
    const breaks = new Set(editor.querySelectorAll('br'));
    const changed = document.execCommand('insertParagraph');
    for (const br of editor.querySelectorAll<HTMLBRElement>('li > br')) {
      if (
        !breaks.has(br) &&
        !br.previousSibling &&
        br.nextSibling instanceof HTMLElement &&
        br.nextSibling.matches('[data-skill-id], [data-session-token]')
      ) {
        // Chromium inserts a spurious line before an atomic chip at a split; redo can resurrect this same node.
        br.dataset.composerPlaceholder = '';
        br.remove();
      }
    }
    return changed;
  }
  if (event.key === 'Tab' && !event.altKey) {
    return nestComposerList(editor, event.shiftKey);
  }
  if (event.key !== 'Backspace' || event.shiftKey || event.altKey || !selection.isCollapsed) return false;
  if (!item.textContent && !item.querySelector('[data-skill-id], [data-session-token]')) return nestComposerList(editor, true);
  // A populated first item has no preceding item to merge into. Backspace at its start removes its marker.
  if (item.previousElementSibling) return false;
  const before = selection.getRangeAt(0).cloneRange();
  before.setStart(item, 0);
  return !hasComposerContent(before) && nestComposerList(editor, true);
}
