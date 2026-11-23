// Whether a text selection lies inside one message body, so it can be quoted.

/** Only message text supports quoting; status rows and card controls remain copyable. */
const MESSAGE_BODY_SELECTOR = [
  '.user-bubble',
  '.assistant-message > [data-selection-source] > .md',
  '.commentary > [data-selection-source] > .md',
  '.plan-card > .md',
  '.review-result > .md',
].join(', ');

function messageBody(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(MESSAGE_BODY_SELECTOR) ?? null;
}

function textBetween(body: Element, startNode: Node, startOffset: number, endNode: Node, endOffset: number): boolean {
  const range = body.ownerDocument.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range.toString().trim() !== '';
}

const squash = (text: string) => text.replace(/\s+/g, '');

/** Whether `part` reads in order within `whole`: the body's own text may hold more than its selection (a hidden label). */
function readsWithin(part: string, whole: string): boolean {
  let at = 0;
  for (const ch of part) {
    at = whole.indexOf(ch, at) + 1;
    if (!at) return false;
  }
  return true;
}

/**
 * `range` limited to `body`, or null when a boundary outside it would add other text: a boundary in another body
 * or in system UI is moved to the body's edge when nothing but whitespace lies between it and that edge, or when
 * everything the selection holds (`selected`, its rendered text) is this body's text. The DOM text between counts
 * what the user cannot select (a status row, a hidden label), which the selection itself leaves out.
 */
function clampToBody(range: Range, body: Element, startsInside: boolean, endsInside: boolean, selected?: string): Range | null {
  const adds =
    (!startsInside && textBetween(body, range.startContainer, range.startOffset, body, 0)) ||
    (!endsInside && textBetween(body, body, body.childNodes.length, range.endContainer, range.endOffset));
  const own = squash(selected ?? '');
  if (adds && !own) return null;
  const clamped = range.cloneRange();
  if (!startsInside) clamped.setStart(body, 0);
  if (!endsInside) clamped.setEnd(body, body.childNodes.length);
  return !adds || readsWithin(own, squash(clamped.toString())) ? clamped : null;
}

/**
 * The part of a selection that is one message body's text, or null when it reaches into another body or into
 * system UI. A paragraph selection (a triple click, a drag to the end of a line) ends at the start of the next
 * block: the message's action row, or the first line of the next message, whose body is then the range's end.
 * Whole-body selections can put both ends on surrounding elements: find the body they cover, then clamp only
 * boundaries that add no other text. When the ends sit in two different bodies, the range belongs to the one
 * that keeps its text: the earlier when the end only touches the later one's start, else the later one.
 * `selected` is the selection's own text, so a boundary past text nobody can select (the transcript's status row
 * under the last reply, #3449) still clamps; without it, any text between decides.
 */
export function messageBodyRange(range: Range, selected?: string): Range | null {
  const start = messageBody(range.startContainer);
  const end = messageBody(range.endContainer);
  if (start && end)
    return start === end ? range : (clampToBody(range, start, true, false, selected) ?? clampToBody(range, end, false, true, selected));
  let body = start ?? end;
  if (!body && range.commonAncestorContainer instanceof Element) {
    const bodies = Array.from(range.commonAncestorContainer.querySelectorAll('.user-bubble, .md')).filter(
      (candidate) => messageBody(candidate) === candidate && range.intersectsNode(candidate),
    );
    if (bodies.length === 1) body = bodies[0];
  }
  return body ? clampToBody(range, body, !!start, !!end, selected) : null;
}
