// Vision fallback for the desktop_* and desktop_app_* captures: a text-only model gets the accessibility elements, on-device OCR text and a vision model's description instead of the image, and `find` locates something by description.
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { messageOf } = require('../../ignored.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { ocrItems, norm, inside } = require('../vision/ocr.cjs');
const { elementAt } = require('./desktopUtil.cjs');
const { notAllowed } = require('../vision/index.cjs');

const MAX_OCR = 120;
const TEXT_ONLY = 'this is the accessibility and on-device OCR text only';

const within = (c, r) => !r || (c.x >= r[0] && c.y >= r[1] && c.x <= r[2] && c.y <= r[3]);

/**
 * The OCR text inside the frame (and `region`, in its pixels) that no listed element already shows, as lines with centers.
 * @param {any} res the helper's ocr.elements result (frames in global points)
 * @param {{ label?: string, frame: { x: number, y: number, w: number, h: number } }[]} elements
 * @param {{ x: number, y: number, ppp: number, width: number, height: number }} geom
 * @param {number[] | null} [region]
 */
function ocrLines(res, elements, geom, region = null) {
  const known = elements.map((e) => ({ frame: e.frame, text: norm(e.label) }));
  const lines = [];
  for (const it of ocrItems(res)) {
    const c = P.toPixels(geom, { x: it.frame.x + it.frame.w / 2, y: it.frame.y + it.frame.h / 2 });
    if (c.x < 0 || c.y < 0 || c.x >= geom.width || c.y >= geom.height || !within(c, region)) continue;
    const t = norm(it.text);
    if (known.some((k) => k.text && (k.text.includes(t) || t.includes(k.text)) && inside(it.frame, k.frame))) continue;
    lines.push(`"${prefixUnits(it.text.replace(/\s+/g, ' '), 100)}" at (${c.x}, ${c.y})`);
    if (lines.length >= MAX_OCR) break;
  }
  return lines;
}

/**
 * A capture as the chat's model should get it. A model that sees images gets it unchanged (plus the answer to
 * `find`); a text-only one gets no image: the capture's text, `elementLines`, the OCR text and, when a vision
 * backend may read the screen (the cross-vendor consent card first), its description. A refused consent or a
 * failed backend leaves the accessibility and OCR text, and says so.
 * @param {object} o
 * @param {any} o.cu the computer-use coordinator: plan(chatId) (vision/decide.cjs), vision, harness
 * @param {string} o.chatId
 * @param {{ bundleId: string, name: string }} o.app what the consent card names
 * @param {{ record: any, content: any[] }} o.out
 *   the capture as an image model gets it: the image first
 * @param {{ width: number, height: number }} o.size the image's pixels
 * @param {{ x: number, y: number, ppp: number, width: number, height: number }} o.geom the coordinate frame
 * @param {{ index?: number, label?: string, frame: { x: number, y: number, w: number, h: number } }[]} o.elements the listed elements
 * @param {() => Promise<any>} o.ocr the helper's ocr.elements for what was captured
 * @param {string[]} [o.elementLines] elements to list with the text (a zoom's)
 * @param {number[] | null} [o.region] only the OCR text inside this region of the frame (a zoom's)
 * @param {unknown} [o.find] what to locate, by description (a screenshot's)
 * @param {{ callId?: string | null, signal?: AbortSignal }} [o.ctx] the call's context (a subagent's call is unattended; its signal withdraws the consent card)
 * @param {() => void} [o.reveal] brings MoPilot's windows back (hidden while a chat holds the screen) before the consent card
 * @returns {Promise<any>} the capture: {record, content}
 */
async function forModel(o) {
  const plan = o.cu.plan ? await o.cu.plan(o.chatId) : null;
  const sees = !plan || plan.kinds.includes('screenshot');
  const find = typeof o.find === 'string' ? o.find.trim() : '';
  if (sees && !find) return o.out;
  const [image, ...rest] = o.out.content;
  const shot = { png: image.data, mimeType: image.mimeType, width: o.size.width, height: o.size.height };
  const notes = [];
  /** @type {any} */
  let backend = null;
  const vision = o.cu.vision;
  if (plan?.backend && vision && (!sees || plan.locate)) {
    const r = await vision.allowing(o.chatId, plan.backend, {
      harness: o.cu.harness(o.chatId),
      app: { bundleId: o.app.bundleId, name: o.app.name },
      // a scheduled run or nobody at the Mac: no card that nobody would answer
      unattended: () => o.cu.unattended(o.chatId, o.ctx),
      reveal: o.reveal,
      signal: o.ctx?.signal,
    });
    backend = r.backend;
    if (!backend) notes.push(`${notAllowed(plan.backend.vendor, r)}, so no vision model read the screen${sees ? '' : `: ${TEXT_ONLY}`}.`);
  }
  if (!sees) {
    notes.unshift("No image: this chat's model takes text only, so the screen is given as text.");
    if (o.elementLines?.length) notes.push(`Elements in this region:\n${o.elementLines.join('\n')}`);
    const res = await o.ocr().catch((error) => {
      notes.push(`The screen's text couldn't be read (on-device OCR failed: ${messageOf(error)}).`);
      return null;
    });
    const lines = res ? ocrLines(res, o.elements, o.geom, o.region) : [];
    if (lines.length) notes.push(`Text read from the screen (on-device OCR; act on it by coordinate):\n${lines.join('\n')}`);
    if (backend) {
      try {
        notes.push(`What ${backend.model} sees:\n${await vision.describe(backend, shot, null)}`);
      } catch (e) {
        notes.push(`The vision model couldn't read the screen (${e?.message ?? e}): ${TEXT_ONLY}.`);
      }
    } else if (!plan?.backend) notes.push(`No vision model can read the screen in this chat: ${TEXT_ONLY}.`);
  }
  if (find) notes.push(await locate(o, find, plan, backend, shot));
  const text = [...rest.map((c) => c.text), ...notes].join('\n');
  return { record: o.out.record, content: [...(sees ? [image] : []), { type: 'text', text }] };
}

/** The answer to `find`: where it is in the frame's pixels, and the element there. */
async function locate(o, find, plan, backend, shot) {
  if (!plan?.locate)
    return `find: no vision model can locate "${find}" in this chat; ${plan?.kinds.includes('screenshot') !== false ? 'look at the screenshot' : 'search the text above'}.`;
  if (!backend) return `find: "${find}" was not looked for.`;
  try {
    const { point } = await o.cu.vision.locate(backend, shot, find);
    if (!point) return `find: "${find}" is not on the screen.`;
    const px = { x: Math.round((point.x * o.geom.width) / o.size.width), y: Math.round((point.y * o.geom.height) / o.size.height) };
    /** @type {any} */
    const el = elementAt(o.elements, P.toPoints(o.geom, px));
    return `find: "${find}" is at (${px.x}, ${px.y})${el ? `, element [${el.index}]` : ''}.`;
  } catch (e) {
    return `find: the vision model couldn't read the screen (${e?.message ?? e}).`;
  }
}

module.exports = { forModel, ocrLines };
