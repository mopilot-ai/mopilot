// The browser host's screenshots: the viewport or a region sized for the chat's model, and the whole page, with password fields and the agent cursor kept out.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { captureSize, encodeJpeg, FULL_PAGE_WIDTH } = require('./capture.cjs');
const {
  CAPTURE_MS,
  FRAME_MS,
  PAGE_BACKDROP,
  FRAME_SCRIPT,
  BLACK_PAGE_SCRIPT,
  withTimeout,
  isBlank,
  noteUnreadable,
} = require('./hostUtil.cjs');
const { HostPage } = require('./hostPage.cjs');
const { captureContents } = require('./backend.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs the host these methods and helpers run on */
/** @typedef {import('./host.cjs').Tab} Tab */
/** @typedef {import('./host.cjs').PagePoint} PagePoint */

class HostCapture extends HostPage {
  /**
   * A screenshot (or zoom of `region`) as JPEG, sized for the chat's model (capture.cjs): up to 2000 px
   * on the long edge for high-resolution models, else 1568 px. The coordinate frame is always the full
   * viewport in CSS pixels.
   * @this {BrowserTabs}
   */
  async capture(tab, st, opts = {}) {
    return concealed(this, tab, () => captureView(this, tab, st, opts));
  }

  /**
   * The whole page (up to 8000 CSS pixels tall), JPEG, at most 1280 pixels wide and 1 MB; password fields and the agent cursor kept out of it.
   * @this {BrowserTabs}
   */
  async captureFull(tab) {
    return concealed(this, tab, () => captureWholePage(this, tab));
  }
}

/**
 * Whether the page itself is black (its root or body background), so a black screenshot is the page.
 * @param {BrowserTabs} host
 */
async function pageIsBlack(host, tab) {
  const r = await tab.send('Runtime.evaluate', { expression: BLACK_PAGE_SCRIPT, returnByValue: true }).catch((error) => {
    // unknown: handled as not black, so the black capture is refused
    noteIgnored("check whether a page's own background is black", error);
    return null;
  });
  return r?.result?.value === true;
}

/**
 * The chat's current model, for the screenshot size; null when unknown.
 * @param {BrowserTabs} host
 */
async function modelOf(host, chatId) {
  try {
    return (await host.o.modelOf?.(chatId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs a capture with what the model must not see kept out of it: password fields masked in every
 * frame (and a frame painted after), and the agent cursor (drawn in the page) hidden.
 * @param {BrowserTabs} host
 */
async function concealed(host, tab, fn) {
  const sessions = ['', ...tab.frames.keys()];
  // a frame that went away has nothing to mask
  const mask = (on) =>
    Promise.all(
      sessions.map((sid) =>
        tab.agent('mask', { on }, sid).then(
          (r) => (noteUnreadable(r, 'a screenshot'), r),
          (error) => noteIgnored(`${on ? 'mask' : 'unmask'} password fields in a frame for a screenshot`, error),
        ),
      ),
    );
  if ((await mask(true)).some((r) => r?.count > 0))
    await withTimeout(
      tab.send('Runtime.evaluate', { expression: FRAME_SCRIPT, awaitPromise: true, returnByValue: true }).catch((error) => {
        // masking is already applied; the paint wait is best effort
        noteIgnored('wait for a frame painted with password fields masked', error);
      }),
      FRAME_MS,
      () => {
        /* a slow paint must not block capture indefinitely */
      },
    );
  if (host.o.cursor) await host.o.cursor.conceal(tab);
  try {
    return await fn();
  } finally {
    if (host.o.cursor) await host.o.cursor.reveal(tab);
    await mask(false);
  }
}

/**
 * `region`: [x0, y0, x1, y1] from the tool's arguments.
 * @param {BrowserTabs} host
 */
async function captureView(host, tab, st, /** @type {{ region?: any, scale?: number }} */ { region = null, scale = 1 } = {}) {
  const frame = { w: st.w, h: st.h };
  /** @type {{ x: number, y: number, width: number, height: number } | null} */
  let rect = null;
  if (region) {
    if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => Number.isFinite(Number(n))))
      throw new ToolError('region must be [x0, y0, x1, y1].', 'bad_args');
    const [x0, y0, x1, y1] = region.map(Number);
    const x = Math.max(0, Math.min(x0, x1));
    const y = Math.max(0, Math.min(y0, y1));
    rect = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.min(frame.w, Math.max(x0, x1)) - x),
      height: Math.round(Math.min(frame.h, Math.max(y0, y1)) - y),
    };
    if (rect.width < 1 || rect.height < 1) throw new ToolError('The region is empty or outside the viewport.', 'bad_args');
  }
  let img = null;
  let black = null;
  const take = (shot) => {
    if (!isBlank(shot)) img = shot;
    else if (shot && !shot.isEmpty()) black = shot;
  };
  // both capturePage and CDP's clip take DIPs, which a zoomed page (pageZoom.cjs) has fewer of than CSS pixels
  const z = zoomOf(tab);
  const clip = rect
    ? { ...dips({ x: rect.x + st.sx, y: rect.y + st.sy, width: rect.width, height: rect.height }, z), scale: 1 }
    : undefined;
  const viaCdp = async () => {
    const r = await withTimeout(tab.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }), CAPTURE_MS, () => {
      throw new ToolError(
        "Couldn't capture the page. Bring the browser pane to the front (browser_tabs_select) and try again.",
        'capture_failed',
      );
    });
    return host.o.images.fromBuffer(Buffer.from(r.data, 'base64'));
  };
  // capturePage can hang (or fail) on a page that isn't painted: bounded, then CDP.
  // An explicitly emulated page uses CDP, which takes its region in page CSS pixels.
  if (!tab.emulated)
    take(
      await withTimeout(
        Promise.resolve().then(() => captureContents(tab.backend, rect ? dips(rect, z) : undefined)),
        CAPTURE_MS,
        () => null,
      ).catch((error) => {
        // CDP below takes over
        noteIgnored('capture a browser tab with capturePage', error);
        return null;
      }),
    );
  if (!img) take(await viaCdp());
  if (!img && black) {
    // still transparent (no page background) or black: put the page on the pane's white and try once more
    await tab.send('Emulation.setDefaultBackgroundColorOverride', PAGE_BACKDROP).catch((error) => {
      // unsupported: the retry below just captures as is
      noteIgnored("put a transparent page on the pane's white for a screenshot", error);
    });
    take(await viaCdp());
  }
  // never a black image the model would take for the page, unless the page is black
  if (!img && black && (await pageIsBlack(host, tab))) img = black;
  if (!img)
    throw new ToolError(
      `The screenshot of ${tab.id} came back blank: the page isn't painted in its window. Open the browser pane in MoPilot (or call browser_tabs_select) and try again.`,
      'capture_failed',
    );
  const box = rect ? { w: rect.width, h: rect.height } : frame;
  // a zoom shows its region at up to device resolution; a screenshot never exceeds the frame
  const size = captureSize(box, { model: await modelOf(host, tab.chatId), dpr: st.dpr, zoom: !!rect, scale });
  const out = encodeJpeg(img, size);
  return { data: out.data, width: out.width, height: out.height, frame, rect };
}

/** @param {BrowserTabs} host */
async function captureWholePage(host, tab) {
  const m = await tab.send('Page.getLayoutMetrics');
  const size = m.cssContentSize || m.contentSize;
  const width = Math.max(1, Math.min(4000, Math.ceil(size.width)));
  const height = Math.max(1, Math.min(8000, Math.ceil(size.height)));
  const r = await withTimeout(
    tab.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { ...dips({ x: 0, y: 0, width, height }, zoomOf(tab)), scale: 1 },
    }),
    CAPTURE_MS,
    () => {
      throw new ToolError("Couldn't capture the page. Bring the browser pane to the front and try again.", 'capture_failed');
    },
  );
  const img = host.o.images.fromBuffer(Buffer.from(r.data, 'base64'));
  if (isBlank(img))
    throw new ToolError(
      `The full-page screenshot of ${tab.id} came back blank: the page isn't painted in its window. Open the browser pane in MoPilot and try again.`,
      'capture_failed',
    );
  const k = Math.min(1, FULL_PAGE_WIDTH / width);
  const out = encodeJpeg(img, { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) });
  return {
    data: out.data,
    width: out.width,
    height: out.height,
    frame: { w: width, h: height },
    rect: null,
    truncated: Math.ceil(size.height) > height,
  };
}

/** The page's zoom factor (1 when unknown). */
function zoomOf(tab) {
  const z = tab.backend.getZoomFactor?.();
  return typeof z === 'number' && Number.isFinite(z) && z > 0 ? z : 1;
}

/** A rect in page CSS pixels as DIPs at zoom `z`. */
function dips(r, z) {
  return {
    x: Math.round(r.x * z),
    y: Math.round(r.y * z),
    width: Math.max(1, Math.round(r.width * z)),
    height: Math.max(1, Math.round(r.height * z)),
  };
}

module.exports = { HostCapture };
