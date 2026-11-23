// App zoom (View → Zoom In, Zoom Out, Actual Size) as Claude Desktop does it: every app window's page zoom, in half zoom-level steps.
/** One step, in Chromium zoom levels (each level is 1.2×): about 9.5%, as Claude Desktop steps. */
export const ZOOM_STEP = 0.5;
/** About 53%: below it macOS's traffic lights no longer fit the title bar. */
export const MIN_ZOOM_LEVEL = -3.5;
/** About 299%: above it the smallest window leaves the layout no room. */
export const MAX_ZOOM_LEVEL = 6;
/** Settings → Appearance → Chat font size: the sizes it offers (tests/typeScale.test.ts holds them equal). Zoom never changes the chat font size. */
export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18];
const DEFAULT_CHAT_FONT_SIZE = 14;

/** The page zoom factor of a zoom level. */
export const zoomFactorOf = (level) => 1.2 ** level;

/** A saved or computed zoom level on the step grid, within the limits; anything else is Actual Size (0). */
export function normalizeZoomLevel(level) {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  const snapped = Math.round(level / ZOOM_STEP) * ZOOM_STEP;
  // + 0: -0 is Actual Size too
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, snapped)) + 0;
}

/** The zoom level after Zoom In (1), Zoom Out (-1) or Actual Size (0). */
export function zoomStep(level, direction) {
  if (direction === 0) return 0;
  return normalizeZoomLevel(normalizeZoomLevel(level) + Math.sign(direction) * ZOOM_STEP);
}

/**
 * Builds before zoom changed the chat font size by 1px per step (10px to 24px), so a size Settings doesn't offer
 * came from those shortcuts: it moves to the zoom level nearest it, the chat font back to its default.
 * Null when there is nothing to move (zoom already saved, or a size Settings offers).
 */
export function legacyZoomPatch(prefs) {
  if (!prefs || typeof prefs !== 'object' || 'zoomLevel' in prefs) return null;
  const size = prefs.fontSize;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || CHAT_FONT_SIZES.includes(size)) return null;
  const level = normalizeZoomLevel(Math.log(size / DEFAULT_CHAT_FONT_SIZE) / Math.log(1.2));
  return { zoomLevel: level, fontSize: DEFAULT_CHAT_FONT_SIZE };
}

/** The zoom level saved prefs ask for, before or after legacyZoomPatch moved an old font size to it. */
export function zoomLevelOf(prefs) {
  const legacy = legacyZoomPatch(prefs);
  if (legacy) return legacy.zoomLevel;
  return normalizeZoomLevel(prefs && typeof prefs === 'object' ? prefs.zoomLevel : undefined);
}

/** macOS's window buttons are 12pt circles. */
const WINDOW_BUTTON = 12;
/**
 * Where macOS's window buttons go at a zoom factor: their centers scale with the title bar they sit in, as
 * Claude Desktop places them, so they stay centered in it. `at` is their position at Actual Size.
 */
export function windowButtonsAt(at, factor) {
  const half = WINDOW_BUTTON / 2;
  const scale = (v) => Math.max(0, Math.round((v + half) * factor - half));
  return { x: scale(at.x), y: scale(at.y) };
}

/** The height of Windows' caption buttons at a zoom factor: the title bar's `height` CSS pixels, in screen pixels. */
export const titleBarHeightAt = (height, factor) => Math.round(height * factor);
