// DOM behavior happy-dom lacks that the Composer's tests need: a drag event that keeps its dataTransfer, and document.execCommand('insertHTML').
const W = window as any;

/** A drag event carrying `dt` (happy-dom's DragEvent drops the dataTransfer option). */
export function dragEvent(type: string, dt: any) {
  const ev = new W.DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  return ev;
}

/** document.execCommand('insertHTML') as the browser runs it (happy-dom has none): the selection's contents are replaced and the caret sits after the inserted nodes, the way the editor's replaceRange relies on. */
export function insertHTML(command: string, _ui: boolean, html: string) {
  if (command !== 'insertHTML') return false;
  const sel = window.getSelection()!;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const fragment = range.createContextualFragment(html);
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) range.setStartAfter(last);
  range.collapse(!last);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
