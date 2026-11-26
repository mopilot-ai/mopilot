// What a chat's scroll reports say, in points: where the reader stands against the end, and the rules for the end, the rest zone, the clamp and a move up.
/** Within this many points of the end counts as being at the end. */
export const NEAR_END = 80;
export type Scrolled = {
  nativeEvent?: { contentOffset?: { y?: number }; contentSize?: { height?: number }; layoutMeasurement?: { height?: number } };
};
export type Report = { y: number; content: number; view: number };

/** What a scroll report says, or null when it lacks a number. */
export function reportOf(event: Scrolled): Report | null {
  const m = event.nativeEvent;
  const y = m?.contentOffset?.y;
  const content = m?.contentSize?.height;
  const view = m?.layoutMeasurement?.height;
  return y === undefined || content === undefined || view === undefined ? null : { y, content, view };
}
export const atEnd = (r: Report) => r.content - r.view - r.y <= NEAR_END;
/**
 * How close to the end a reader must be, in points, for coming to rest there to follow the chat again: the end itself, with only a bounce's and a rounding's
 * worth of slack. Far tighter than NEAR_END, which only says whether the arrow shows: a reader who stopped a few lines above the end, or nudged up a little
 * and rested, is reading, and the next token must not take the view from them (#5686).
 */
export const REST_END = 4;
/** Whether the view stands at the very end: at rest here, following goes on. */
export const atRest = (r: Report) => r.content - r.view - r.y <= REST_END;
/** How far past the end of what is drawn the offset may stand, in views: a finger's bounce stays within it, a blank screen does not. */
export const BLANK_PAST = 0.5;
/**
 * Where to put the offset when it stands past the end by more than a bounce could: the last screen of what is drawn, or null
 * when it is fine. Content that shrinks under a held offset (earlier pages dropped by a read again, a card replaced by its
 * receipt, a pinned room collapsing) leaves the native view where it was, showing nothing; this is the one rule for all of them.
 */
export function clampOffset(r: Report, slack = BLANK_PAST, grace = 0): number | null {
  const max = Math.max(0, r.content - r.view);
  return r.y > max + r.view * slack + grace ? max : null;
}
/**
 * How far past the end a view that follows the chat may stand with no finger on it, in points. A bounce only happens under a finger
 * (or its momentum), so a followed, idle view past the end is blank space, not a bounce: a cold open of a long reply was left 107
 * points up by the view moving after the last pin, with nothing to put it back. A little is rounding and the screen's own settling.
 */
export const IDLE_BLANK = 8;

/**
 * The reader has left the end when the offset went back up while the content did not shrink. How the view moved
 * (a finger, a status-bar tap, an accessibility scroll, a scrollbar) does not matter, and a report taken after the
 * content grew and before the screen scrolled to it (a streaming reply) never lowers the offset, so it cannot end
 * the following. Going down, such as the jump to the latest message animating, never does either.
 */
export const wentUp = (before: Report | null, now: Report) => before !== null && now.content >= before.content && now.y < before.y - 1;

/** A keyboard frame as the keyboard events give it. */
export type KeyboardFrame = { screenY?: number; height?: number };
/**
 * How much of the screen the keyboard covers in a frame, in points. A frame that went away (the keyboard hiding) keeps its height and moves off the screen, so the top
 * edge says it, not the height; a frame with no edge falls back to its height.
 */
export const covered = (frame: KeyboardFrame | undefined, screen: number) =>
  frame?.screenY !== undefined ? Math.max(0, screen - frame.screenY) : (frame?.height ?? 0);

/**
 * How long after a send the pin may still place the sent message (and place it again when the view is resized: the keyboard going down with the send). The pin ends
 * sooner, for good, at the first touch, drag or keyboard coming up (typing the next message): after that the view is the reader's (#5686).
 */
export const PIN_WINDOW = 2500;
/** A glide that has reported nothing for this long (ms) has ended, whatever the events said (a gesture cancelled with no end event). */
export const GLIDE_SILENCE = 1500;
/** The keyboard's slide is over this long (ms) after its announced time even if its end is never reported. */
export const KEYBOARD_MARGIN = 150;

/**
 * Where the offset of a reader at the end goes when the keyboard covers `by` more points (less, when negative): the end the view will have once it has its new height, and never
 * past it, so a chat whose content fits stays at the top and nothing is left blank under the last row.
 */
export const keyboardTarget = (r: Report, by: number) => Math.min(Math.max(0, r.y + by), Math.max(0, r.content - (r.view - by)));
/**
 * The fingers on the list after a touch began. The touch events give every finger on the screen too, which bounds it: a touch whose end was never delivered (its view unmounted
 * under it: a streaming reply re-keyed at the turn's end) cannot stay counted once another finger lands.
 */
export const fingersAfterStart = (fingers: number, began: number, onScreen?: number) =>
  Math.min(fingers + began, onScreen ?? Number.POSITIVE_INFINITY);
/** A finger that has sent no touch event for this long (ms) is taken as gone (no end was delivered). */
export const TOUCH_SILENCE = 6000;
/** A finger that moves starts the silence timer again at most this often (ms), so a drag does not set a timer for every frame. */
export const MOVE_KEEPALIVE = 1000;
