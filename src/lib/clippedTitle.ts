// A tooltip only for text its row cut short (by an ellipsis or a fade): on hover or focus, the element's title becomes the full text of its
// ellipsized part when that part overflows, and is removed when it fits (a label that reads whole needs none).

/** Sets or clears `host`'s title from the overflow of its descendant matching `selector` (without one, of `host`
 * itself), measured now. `full`: the text to show when the element holds more than it (a name mid-crossfade). */
export function titleIfClipped(host: HTMLElement, selector?: string, full?: string) {
  const text = selector ? host.querySelector<HTMLElement>(selector) : host;
  if (text && text.scrollWidth > text.clientWidth) host.title = full ?? (text.textContent as string);
  else host.removeAttribute('title');
}
