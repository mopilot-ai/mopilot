// The composer's Markdown serialization and DOM-to-prompt caret mapping, including atomic references and list markers.
import { listItemPrefix } from './composerLists';

type CaretPoint = { node: Node; length: number; at: number; token: boolean };

/** One traversal owns both prompt text and caret positions, including generated markers. */
function editorDocument(root: Node, fragment: boolean) {
  let text = '';
  const mentions: { id: string; offset: number }[] = [];
  const points: CaretPoint[] = [];
  const listIndices = new Map<Node, number>();
  const prefixes = new Map<HTMLElement, string>();
  const visit = (node: Node) => {
    const block = /^(DIV|P|OL|UL|LI)$/.test(node.nodeName);
    let previous = node.previousSibling;
    while (
      (previous?.nodeType === Node.TEXT_NODE && !previous.textContent) ||
      (block && previous instanceof HTMLElement && previous.hasAttribute('data-skill-id'))
    )
      previous = previous.previousSibling;
    // Outdent can leave bare text/BR after a list rather than wrapping it in a DIV.
    if (
      previous &&
      ((block && previous.nodeName !== 'BR' && !(previous.nodeType === Node.TEXT_NODE && previous.textContent!.endsWith('\n'))) ||
        (/^(OL|UL)$/.test(previous.nodeName) && (node.nodeType !== Node.TEXT_NODE || node.textContent)))
    )
      text += '\n';
    if (node instanceof HTMLElement && node.hasAttribute('data-session-token')) {
      points.push({ node, length: node.dataset.sessionToken!.length, at: text.length, token: true });
      text += node.dataset.sessionToken;
      return;
    }
    if (node instanceof HTMLElement && node.hasAttribute('data-skill-id')) {
      mentions.push({ id: node.dataset.skillId!, offset: text.length });
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      points.push({ node, length: (node as Text).data.length, at: text.length, token: false });
      text += node.textContent;
      return;
    }
    if (node.nodeName === 'BR') {
      points.push({ node, length: 0, at: text.length, token: false });
      // A sole BR in a browser-created empty line hosts the caret; the block boundary is its newline.
      if (
        (!fragment && node === root.lastChild) ||
        (!node.nextSibling &&
          (/^(OL|UL)$/.test(previous?.nodeName ?? '') ||
            (node.parentNode !== root && /^(DIV|P|LI)$/.test(node.parentNode!.nodeName) && !node.previousSibling?.textContent)))
      )
        return;
      text += '\n';
      return;
    }
    if (node instanceof HTMLElement && node.nodeName === 'LI') {
      const index = listIndices.get(node.parentNode!) ?? 0;
      const prefix = listItemPrefix(node, index, prefixes);
      text += prefix;
      prefixes.set(node, prefix);
      listIndices.set(node.parentNode!, index + 1);
    }
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return { text, mentions, points };
}

/** Serialize editable text without letting a skill's display label become prompt text. */
export function readEditor(root: Node, fragment = false) {
  const { text, mentions } = editorDocument(root, fragment);
  return { text, mentions };
}

/** Map ordered command spans to editable text, omitting chips and generated list markers. */
export function editorTextRanges(el: HTMLElement, spans: readonly { start: number; end: number }[]): Range[] {
  const { points } = editorDocument(el, false);
  const ranges: Range[] = [];
  let firstSpan = 0;
  for (const { node, at, length } of points) {
    if (node.nodeType !== Node.TEXT_NODE || !length) continue;
    while (firstSpan < spans.length && spans[firstSpan].end <= at) firstSpan++;
    for (let i = firstSpan; i < spans.length && spans[i].start < at + length; i++) {
      const { start, end } = spans[i];
      const range = el.ownerDocument.createRange();
      range.setStart(node, Math.max(start - at, 0));
      range.setEnd(node, Math.min(end - at, length));
      ranges.push(range);
    }
  }
  return ranges;
}

function offsetAt(el: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, offset);
  const next = node.nodeType === Node.TEXT_NODE && offset === 0 ? node : node.childNodes[offset];
  // Native outdent can leave a bare BR/text after a list; the cloned prefix omits its line boundary.
  const outsideList =
    next &&
    (next.nodeName === 'BR' || (next.nodeType === Node.TEXT_NODE && next.textContent)) &&
    /^(OL|UL)$/.test(next.previousSibling?.nodeName ?? '');
  return readEditor(range.cloneContents(), true).text.length + (outsideList ? 1 : 0);
}

export function caretOffset(el: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !el.contains(selection.anchorNode)) return 0;
  return offsetAt(el, selection.anchorNode!, selection.anchorOffset);
}

export function placeCaret(el: HTMLElement, start: number, end = start) {
  const { points } = editorDocument(el, false);
  const point = (offset: number) => {
    if (offset === 0 && start !== end) return { node: el as Node, offset: 0 };
    const p = points.find((p) => offset <= p.at + p.length) ?? points.at(-1);
    if (!p) return { node: el as Node, offset: el.childNodes.length };
    if (p.token) {
      const index = Array.from(p.node.parentNode!.childNodes).indexOf(p.node as ChildNode);
      return { node: p.node.parentNode!, offset: index + (offset > p.at ? 1 : 0) };
    }
    if (p.node.nodeName === 'BR')
      return { node: p.node.parentNode!, offset: Array.from(p.node.parentNode!.childNodes).indexOf(p.node as ChildNode) };
    return { node: p.node, offset: Math.max(0, Math.min(p.length, offset - p.at)) };
  };
  const a = point(start),
    b = point(end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Read selection offsets in the full editor so a selected later item keeps its generated number. */
export function selectedText(el: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  let start = offsetAt(el, range.startContainer, range.startOffset);
  const end = offsetAt(el, range.endContainer, range.endOffset);
  const text = readEditor(el).text;
  const node = range.startContainer;
  const item = (node instanceof HTMLElement ? node : node.parentElement)?.closest('li');
  if (item && !item.contains(range.endContainer)) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (start === lineStart + listItemPrefix(item).length) start = lineStart;
  }
  return text.slice(start, end);
}
