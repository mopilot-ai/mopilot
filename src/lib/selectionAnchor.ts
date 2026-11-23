// Anchoring a quoted selection to its message by text offsets, and finding its range again after a rerender.

import type { Attachment } from '../../shared/model/store';

/** Text offsets survive markdown rerenders and draft restoration without retaining DOM nodes. */
export function selectionSource(range: Range, selectedText?: string): Attachment['source'] {
  const node = range.commonAncestorContainer;
  const root = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-selection-source]');
  if (!root?.dataset.selectionSource) return;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const text = range.toString();
  return {
    messageId: root.dataset.selectionSource,
    start,
    end: start + text.length,
    ...(selectedText !== undefined && selectedText.trim() !== text.trim() ? { text } : {}),
  };
}

/** The range covering text offsets [start, end) of `root`, or null when they run past its text. */
function rangeAt(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** An item id without its last `:part`: a harness that renumbers a reply's items keeps its message part (`msg_1:0` → `msg_1:t3`). */
const stem = (id: string) => id.slice(0, Math.max(0, id.lastIndexOf(':')));

/**
 * The quote's range again: at its offsets in its own message, or, when no message there holds it any more (a harness
 * re-read the chat and gave its items new ids), at the same text elsewhere: in a message of the same id stem first,
 * then at the occurrence nearest its old offset.
 */
export function selectionRange(container: HTMLElement, attachment: Attachment): Range | null {
  const source = attachment.source;
  const quote = (source?.text ?? attachment.text)?.trim();
  if (!source || !quote) return null;
  const roots = Array.from(container.querySelectorAll<HTMLElement>('[data-selection-source]'));
  const own = roots.find((el) => el.dataset.selectionSource === source.messageId);
  const exact = own && rangeAt(own, source.start, source.end);
  if (exact && exact.toString().trim() === quote) return exact;
  const family = stem(source.messageId);
  let best: { root: HTMLElement; start: number; kin: boolean; distance: number } | null = null;
  roots.forEach((root, i) => {
    // a message holding other messages (the thread column) is not one of them; roots come in document order
    if (roots[i + 1] && root.contains(roots[i + 1])) return;
    const kin = !!family && stem(root.dataset.selectionSource!) === family;
    // an element's textContent is never null
    const text = root.textContent as string;
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
      const distance = Math.abs(at - source.start);
      if (!best || (kin && !best.kin) || (kin === best.kin && distance < best.distance)) best = { root, start: at, kin, distance };
    }
  });
  const found = best as { root: HTMLElement; start: number } | null;
  return found && rangeAt(found.root, found.start, found.start + quote.length);
}
