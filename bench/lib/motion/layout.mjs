// Motion bench cursor-recording layout (#3810): where the agent app's window parks so the fixture page stays uncovered, the AppleScript that moves it, and the crop of the screen that holds the fixture window at 1x.

/** The size the agent app's window shrinks to once it has the turn, in points. */
export const PARKED_SIZE = /** @type {[number, number]} */ ([440, 420]);

/**
 * The parked window's bounds `[x, y, w, h]`: the bottom right corner of the screen, inset by `margin` and clear of the
 * dock by `dock`, always on screen (it starts at 0 when the screen is smaller than the window).
 * @param {[number, number, number, number]} screen [x, y, w, h] in points @param {[number, number]} [size] @param {number} [margin] @param {number} [dock]
 */
export function parkedBounds(screen, size = PARKED_SIZE, margin = 16, dock = 80) {
  const w = Math.min(size[0], screen[2]);
  const h = Math.min(size[1], screen[3]);
  return [screen[0] + Math.max(0, screen[2] - w - margin), screen[1] + Math.max(0, screen[3] - h - margin - dock), w, h];
}

/**
 * The osascript lines (one per -e) that put window 1 of a process at bounds `[x, y, w, h]`: size first, so the move
 * cannot hang off the screen. It does not need the process in front (the vendor app may have handed the screen to another app).
 * @param {string} processName as System Events names it @param {number[]} b
 */
export function moveWindowLines(processName, b) {
  const name = JSON.stringify(processName);
  return [
    'tell application "System Events"',
    `set p to first application process whose name is ${name} or displayed name is ${name}`,
    `set size of window 1 of p to {${Math.round(b[2])}, ${Math.round(b[3])}}`,
    `set position of window 1 of p to {${Math.round(b[0])}, ${Math.round(b[1])}}`,
    'end tell',
  ];
}

/**
 * The crop ("WxH" from the screen's top left, in pixels) of a 1x recording that holds the fixture window: its place plus
 * its outer size, from the page's `ready` event; 1280x800 (the window it is opened with) when the page logged none.
 * @param {{ screenX?: number, screenY?: number, outerWidth?: number, outerHeight?: number, frame?: { x: number, y: number, width: number, height: number } | null } | null | undefined} ready @param {number} [pxPerPoint]
 */
export function cursorCrop(ready, pxPerPoint = 1) {
  // the native fixture app names its content view's place and size itself
  const f = ready?.frame;
  if (f && [f.x, f.y, f.width, f.height].every(Number.isFinite))
    return `${Math.round((f.x + f.width) * pxPerPoint)}x${Math.round((f.y + f.height) * pxPerPoint)}`;
  const [x, y, w, h] = /** @type {number[]} */ ([ready?.screenX, ready?.screenY, ready?.outerWidth, ready?.outerHeight]);
  if (![x, y, w, h].every(Number.isFinite)) return '1280x800';
  return `${Math.round((x + w) * pxPerPoint)}x${Math.round((y + h) * pxPerPoint)}`;
}
