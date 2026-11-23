// A pane tab's page zoom, owned by its view: fit to the pane's width (a desktop layout scaled down, never below a readable floor), or the user's per-site choice, or 100% while an explicit viewport is set.
//
// - Chromium lays a page out at its view's width divided by its zoom, so a page zoomed to 0.7 in a 700px pane gets
//   a 1000px layout. The fit aims for AUTO_LAYOUT CSS pixels and stops at AUTO_MIN, below which the site's own
//   narrow layout reads better than shrunken text.
// - The fit follows the view's width only: agent control, reads and turn ends never change it
//   (docs/bug-prevention/notes/wrong-scope/pane-viewport-ownership.md).
// - Chromium keeps one zoom per host in a session, so tabs of a site share it and a navigation to another host takes
//   that host's: the view puts its own back on every navigation and whenever its width changes.
// - An explicit device or viewport (browser_resize_window, a plugin's viewport) is laid out at 100%: Chromium would
//   divide a desktop override by the zoom too.

const { keyOf } = require('./pageKey.cjs');

/** The layout width the fit aims for, in CSS pixels: wide enough for most sites' desktop breakpoint (992px). */
const AUTO_LAYOUT = 1000;
/** The smallest zoom the fit uses: 14px text stays about 10px. */
const AUTO_MIN = 0.7;
/** Zoom In and Zoom Out go through Chrome's steps. */
const STEPS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
const EPSILON = 0.005;
/** How far a trackpad pinch may zoom a page (Chromium's visual viewport scale, 1 being the page as laid out). Electron's default limits of 1..1 turn the gesture off (#5405). */
const PINCH_ZOOM_MAX = 4;

/** Lets a pinch on `wc` zoom its page, and gives `wc` back (views.cjs calls it for every pane tab: new, restored, agent-opened, popups). Visual zoom sits on top of the page zoom above and never changes the layout, so the fit and Zoom In / Out are unaffected. */
function allowPinch(wc) {
  wc.setVisualZoomLevelLimits(1, PINCH_ZOOM_MAX);
  return wc;
}

/** The fitted zoom for a view `width` DIPs wide: 1 at AUTO_LAYOUT and wider, never below AUTO_MIN, in 1% steps. */
function autoZoom(width) {
  const w = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : AUTO_LAYOUT;
  return Math.round(Math.min(1, Math.max(AUTO_MIN, w / AUTO_LAYOUT)) * 100) / 100;
}

/** The next step above (1) or below (-1) `zoom`, or the end step when there is none. */
function stepZoom(zoom, direction) {
  if (direction > 0) return STEPS.find((s) => s > zoom + EPSILON) ?? STEPS[STEPS.length - 1];
  return [...STEPS].reverse().find((s) => s < zoom - EPSILON) ?? STEPS[0];
}

/** The site a zoom choice is kept for: the page's host, or null for a page with none (about:blank, data:). */
function hostOf(wc) {
  try {
    return new URL(wc.getURL()).host || null;
  } catch {
    return null;
  }
}

/** Pages laid out at 100% for an explicit viewport, and who refits when that changes. */
const NATIVE = new WeakSet();
/** @type {Set<(wc: any) => void>} */
const REFITS = new Set();

/**
 * Holds `wc` at 100% while an explicit viewport is set on it (on), or gives it back to its fit (off).
 * Called by whoever sets or clears the viewport, before or after the CDP command, and when the CDP session ends (tab.cjs).
 */
function holdNativeScale(wc, on) {
  const page = keyOf(wc);
  if (!page || typeof page !== 'object' || NATIVE.has(page) === !!on) return;
  if (on) NATIVE.add(page);
  else NATIVE.delete(page);
  for (const refit of REFITS) refit(page);
}

class PageZoom {
  /** @param {{ onRefit?: (wc: any) => void }} [o] onRefit: a page's explicit viewport came or went */
  constructor({ onRefit } = {}) {
    /** host -> the zoom the user chose for it (this run) */
    this.chosen = new Map();
    this.onRefit = onRefit ?? null;
    if (this.onRefit) REFITS.add(this.onRefit);
  }

  /** Stops following explicit viewports (the views went). */
  dispose() {
    if (this.onRefit) REFITS.delete(this.onRefit);
  }

  /** The zoom `wc` takes in a view `width` DIPs wide. */
  zoomFor(wc, width) {
    if (NATIVE.has(keyOf(wc))) return 1;
    const host = hostOf(wc);
    const chosen = host ? this.chosen.get(host) : undefined;
    return chosen ?? autoZoom(width);
  }

  /** Whether `wc` follows the fit (not a site the user zoomed, nor an explicit viewport). */
  isAuto(wc) {
    if (NATIVE.has(keyOf(wc))) return false;
    const host = hostOf(wc);
    return !host || !this.chosen.has(host);
  }

  /** Puts `wc` at its zoom for a view `width` DIPs wide. True when that changed it. */
  apply(wc, width) {
    if (!wc || wc.isDestroyed()) return false;
    const zoom = this.zoomFor(wc, width);
    if (Math.abs(wc.getZoomFactor() - zoom) < EPSILON / 5) return false;
    wc.setZoomFactor(zoom);
    return true;
  }

  /**
   * The user's Zoom In ('in'), Zoom Out ('out') or fit again ('reset') for the site `wc` shows. False for a page with
   * no site, or one held at 100% for an explicit viewport.
   */
  step(wc, width, action) {
    const host = hostOf(wc);
    if (!host || NATIVE.has(keyOf(wc))) return false;
    if (action === 'reset') this.chosen.delete(host);
    else this.chosen.set(host, stepZoom(this.zoomFor(wc, width), action === 'in' ? 1 : -1));
    return true;
  }
}

module.exports = { PINCH_ZOOM_MAX, allowPinch, AUTO_LAYOUT, AUTO_MIN, STEPS, autoZoom, stepZoom, hostOf, holdNativeScale, PageZoom };
