// Native block replacement escapes Chromium's retained list context and removes temporary history boundaries.

/** History can restore temporary boundaries or native chip placeholders; neither belongs to the draft. */
export function clearComposerBoundaries(editor: HTMLElement) {
  for (const node of editor.querySelectorAll('[data-composer-boundary], br[data-composer-placeholder]')) node.remove();
}

/** One native transaction replaces whole sibling blocks without inheriting the old list's start or type. */
export function replaceComposerBlocks(editor: HTMLElement, first: ChildNode, last: ChildNode, html: string) {
  const selection = window.getSelection()!;
  const original = selection.getRangeAt(0).cloneRange();
  const boundary = document.createElement('span');
  boundary.contentEditable = 'false';
  boundary.dataset.composerBoundary = '';
  const endBoundary = boundary.cloneNode() as HTMLElement;
  first.before(boundary);
  last.after(endBoundary);
  const range = document.createRange();
  range.setStartBefore(boundary);
  range.setEndAfter(endBoundary);
  selection.removeAllRanges();
  selection.addRange(range);
  const before = editor.innerHTML;
  let changed = false;
  try {
    // Chromium sometimes returns false after successfully inserting a skill's SVG.
    changed = document.execCommand('insertHTML', false, html) || editor.innerHTML !== before;
    return changed;
  } finally {
    boundary.remove();
    endBoundary.remove();
    if (!changed) {
      selection.removeAllRanges();
      selection.addRange(original);
    }
  }
}

/** Full-draft structured paste owns the old blocks; partial paste retains the current item's context. */
export function pasteComposerBlocks(editor: HTMLElement, html: string) {
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
    const selected = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(editor);
    before.setEnd(selected.startContainer, selected.startOffset);
    const after = document.createRange();
    after.selectNodeContents(editor);
    after.setStart(selected.endContainer, selected.endOffset);
    const hasContent = (fragment: DocumentFragment) =>
      !!fragment.textContent || !!fragment.querySelector('br, [data-skill-id], [data-session-token]');
    if (!hasContent(before.cloneContents()) && !hasContent(after.cloneContents()))
      return replaceComposerBlocks(editor, editor.firstChild!, editor.lastChild!, html);
  }
  return document.execCommand('insertHTML', false, html);
}
