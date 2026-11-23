// The message box grows with what is typed, up to its CSS max-height and then scrolls, with no drag handle: Claude's and ChatGPT's boxes have none, and a handle on the corner reads as an unfinished control.

/** Sizes `box` to its content (its CSS min-height and max-height still bound it). */
export function autosize(/** @type {{ style: { height: string }, scrollHeight: number }} */ box) {
  // reset first, so the content's own height is read even after the text got shorter
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}
