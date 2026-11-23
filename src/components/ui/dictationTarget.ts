// Where dictated text lands: at the composer's caret (the end when the caret is elsewhere), spaced from the words
// around it as typed words are; Chinese, Japanese and Korean text joins its neighbours without spaces.
import type { ComposerInputElement } from '../composer/ComposerInput';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const OPENS = /[\s([{"'“‘]$/;
const CLOSES = /^[\s)\]}.,;:!?"'”’…]/;

/** `text` as it goes between `before` and `after`, with the spaces typed words would have. */
export function spaced(before: string, text: string, after: string): string {
  const words = text.trim();
  if (!words) return '';
  const lead = before && !OPENS.test(before) && !(CJK.test(before.at(-1)!) || CJK.test(words[0])) ? ' ' : '';
  const trail = after && !CLOSES.test(after) && !(CJK.test(after[0]) || CJK.test(words.at(-1)!)) ? ' ' : '';
  return lead + words + trail;
}

/**
 * Puts dictated `text` into the composer at its caret. Without the editor, or while the user works somewhere else (another
 * pane's composer, a field), `append` adds it to the draft's end without taking the focus back.
 */
export function dictateInto(el: ComposerInputElement | null, text: string, append: (update: (draft: string) => string) => void) {
  const active = document.activeElement;
  const elsewhere = !!active && active !== document.body && !(el?.closest('.composer') ?? el)?.contains(active);
  if (!el || elsewhere) return append((draft) => draft + spaced(draft, text, ''));
  const selection = window.getSelection();
  const value = el.value;
  const at = selection?.rangeCount && el.contains(selection.anchorNode) ? el.selectionStart : value.length;
  const insert = spaced(value.slice(0, at), text, value.slice(at));
  if (!insert) return;
  el.replaceRange(at, at, insert);
  el.setCaretAfter(el.value, at + insert.length);
}
