// The one place Sage calls a model itself: a vision model that reads a screenshot for a text-only
// model, like an ordinary tool. Anthropic Messages wire; the caller says where it goes.

const { contentBlocks } = require('../../../shared/contentBlocks.mjs');

/**
 * The model on MoPilot credits that reads screenshots. Checked against the gateway's model table: web/db/migrations
 * 0004 seeds `claude-haiku-4-5` as an active Anthropic model and 0009 gives it text and image input.
 */
const MOPILOT_VISION_MODEL = 'claude-haiku-4-5';

/**
 * @param {{ baseUrl: string, headers: () => Promise<Record<string, string>> | Record<string, string>, model: string, fetch?: typeof fetch, timeoutMs?: number }} o
 * @returns {(req: { png: string, mimeType?: string, prompt: string, signal?: AbortSignal }) => Promise<string>} the model's text answer
 *   (`png` is the base64 image; `mimeType` its type, PNG unless given)
 */
function anthropicVision(o) {
  const doFetch = o.fetch || fetch;
  return async ({ png, mimeType, prompt, signal }) => {
    const r = await doFetch(`${o.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(await o.headers()) },
      body: JSON.stringify({
        model: o.model,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/png', data: png } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: signal ?? AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
    if (!r.ok) throw new Error(`vision model answered ${r.status}`);
    const b = await r.json();
    return contentBlocks(b.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();
  };
}

/**
 * A point from the model's answer, in pixels of an image of `size`. Models answer in pixels, in a
 * 0-1000 (or 0-999) grid, or as a 0-1 fraction; a pair that doesn't fit the image's pixels is
 * taken as the grid, a pair of 0-1 numbers as a fraction.
 * @returns {{ x: number, y: number } | null}
 */
function parsePoint(text, size) {
  const m = /(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/.exec(String(text).replace(/["{}()\[\]xy:]/gi, ' '));
  if (!m) return null;
  let x = Number(m[1]);
  let y = Number(m[2]);
  if (x <= 1 && y <= 1 && (x % 1 || y % 1)) return { x: Math.round(x * size.width), y: Math.round(y * size.height) };
  if ((x > size.width || y > size.height) && x <= 1000 && y <= 1000) {
    x = (x / 1000) * size.width;
    y = (y / 1000) * size.height;
  }
  if (x < 0 || y < 0 || x > size.width || y > size.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * The chat provider's own vision backend: its `visionFallbackModel`, called with the credentials the app
 * holds for that provider. Null when the provider names no such model or nothing can call it, so the
 * choice falls through to MoPilot credits.
 * @param {{ label?: string, id: string, visionFallbackModel?: string | null } | null | undefined} provider
 * @param {{ baseUrl: string, headers: Record<string, string> } | null | undefined} auth
 * @returns {{ vendor: string, model: string } | null}
 */
function providerVision(provider, auth) {
  if (!provider?.visionFallbackModel || !auth?.baseUrl) return null;
  return { vendor: provider.label ?? provider.id, model: provider.visionFallbackModel };
}

module.exports = { MOPILOT_VISION_MODEL, anthropicVision, parsePoint, providerVision };
