// Model-aware desktop screenshot budgets, output sizing and pixel/point geometry.

/* -- screenshots -------------------------------------------------- */
/** Long edge and pixel-count limits for a screenshot the model sees. */
const MAX_LONG_EDGE = 1568;
const MAX_PIXELS = 1_150_000;
/**
 * Models with high-resolution vision (Anthropic's docs: Claude Opus 4.7 and later, Claude Sonnet 5 and
 * later, Claude Fable and Mythos) take images up to 2576 px on the long edge and about 3.75 MP through the
 * API, but the Claude Code harness that carries MoPilot's Claude chats downsizes every image to 2000 px on the
 * long edge before the model sees it (measured in the VM: the tool returned a 2402 px frame, the transcript's
 * image was 2000 px). A frame larger than the image the model sees breaks "coordinates map 1:1 to the image's
 * pixels": the agent must rescale by hand and misses its targets (#3920). So the frame is sized to what the
 * model really sees.
 */
const HIGH_RES_LONG_EDGE = 2000;
const HIGH_RES_PIXELS = 3_750_000;
/** A zoom is a full-density crop, up to this long edge. */
const ZOOM_LONG_EDGE = 2000;

/**
 * Whether a model id or alias names a model with high-resolution vision. Aliases ("opus", "sonnet",
 * "fable") name the current model of that family. Unknown and other vendors' models are not.
 */
function highResModel(model) {
  const m = String(model ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[.*\]$/, '')
    .replace(/^(?:[a-z]+\.)?anthropic\./, '');
  if (/^(?:opus|opusplan|sonnet|fable|mythos)$/.test(m)) return true;
  const x = /(?:^|\/)claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(m);
  if (!x) return false;
  const v = Number(x[2]) + (x[3] ? Number(x[3]) / 10 : 0);
  if (x[1] === 'fable' || x[1] === 'mythos') return true;
  if (x[1] === 'opus') return v >= 4.7;
  if (x[1] === 'sonnet') return v >= 5;
  return false;
}

/**
 * The size limits for a screenshot (or zoom) a model sees: the model's own limits, times `scale`
 * (0.1 to 1, default 1) for a cheaper image. The pixel budget scales with the area.
 */
function screenshotLimits(model, scale) {
  const high = highResModel(model);
  const k = typeof scale === 'number' && Number.isFinite(scale) ? Math.min(Math.max(scale, 0.1), 1) : 1;
  const side = high ? HIGH_RES_LONG_EDGE : MAX_LONG_EDGE;
  const pixels = high ? HIGH_RES_PIXELS : MAX_PIXELS;
  return {
    maxSide: Math.round(side * k),
    maxPixels: Math.round(pixels * k * k),
    zoomSide: Math.round(Math.max(ZOOM_LONG_EDGE, side) * k),
    highRes: high,
  };
}

/** The screenshot size for a display of w×h points at `scale` pixels per point (never upscaled). */
function screenshotSize(w, h, scale = 1, maxSide = MAX_LONG_EDGE, maxPixels = MAX_PIXELS) {
  const pw = Math.max(1, w * Math.max(scale, 1));
  const ph = Math.max(1, h * Math.max(scale, 1));
  const k = Math.min(1, maxSide / Math.max(pw, ph), Math.sqrt(maxPixels / (pw * ph)));
  return { width: Math.max(1, Math.round(pw * k)), height: Math.max(1, Math.round(ph * k)) };
}

/** Screenshot pixels -> global points, through the frame of the screenshot they came from. */
const toPoints = (g, p) => ({ x: g.x + p.x / g.ppp, y: g.y + p.y / g.ppp });
/** Global points -> screenshot pixels. */
const toPixels = (g, p) => ({ x: Math.round((p.x - g.x) * g.ppp), y: Math.round((p.y - g.y) * g.ppp) });

module.exports = {
  MAX_LONG_EDGE,
  MAX_PIXELS,
  HIGH_RES_LONG_EDGE,
  HIGH_RES_PIXELS,
  ZOOM_LONG_EDGE,
  highResModel,
  screenshotLimits,
  screenshotSize,
  toPoints,
  toPixels,
};
