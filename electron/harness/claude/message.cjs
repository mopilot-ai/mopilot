// A Claude message from what was typed and attached, built in main (WP5-9). Block order is what
// Claude Code needs (C11): a handoff record first, then images, then the user's text, so a slash
// command (and @files, ultrathink, ultracode) is in the last block, where the CLI looks for it.
// The API takes JPEG, PNG, GIF and WebP only; other images (HEIC, BMP, TIFF) become PNG (D-58).
// Images are read and converted asynchronously, so a large or slow one never stalls main.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { electron } = require('../../platform/ports/electronApi.cjs');
const os = require('node:os');
const path = require('node:path');
const { proc } = require('../../platform/ports/proc.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const { withSelections } = require('../../../shared/selections.mjs');
const { withTabMentions } = require('../../../shared/tabMentions.mjs');
const API_TYPES = ownTable({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' });

/** An image file as an API image source, converted to PNG when the API can't take its format; null if unreadable. */
async function readImage(file, convert = toPng) {
  try {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (API_TYPES[ext]) return { type: 'base64', media_type: API_TYPES[ext], data: (await fs.promises.readFile(file)).toString('base64') };
    const png = await convert(file);
    return png ? { type: 'base64', media_type: 'image/png', data: png.toString('base64') } : null;
  } catch {
    return null;
  }
}

/**
 * An image file as a data URL a model API takes (JPEG, PNG, GIF or WebP; anything else converted to PNG), or null:
 * what ACP harnesses are sent, which pass it on to the same APIs as Claude Code.
 */
async function imageDataUrl(file, convert = toPng) {
  const src = await readImage(file, convert);
  return src ? `data:${src.media_type};base64,${src.data}` : null;
}

/** HEIC, BMP, TIFF… to PNG: macOS's sips reads them all; Electron's nativeImage is the fallback. */
async function toPng(file) {
  const out = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sage-img-')), 'image.png');
  try {
    return (await sipsPng(file, out)) ?? nativePng(file);
  } finally {
    try {
      await fs.promises.rm(path.dirname(out), { recursive: true, force: true });
    } catch (error) {
      // Cleanup must not discard an image that was successfully decoded.
      noteIgnored('remove a temporary converted image', error);
    }
  }
}

/** The PNG sips wrote to `out`, or null off macOS or when sips fails. */
async function sipsPng(file, out) {
  try {
    if (process.platform !== 'darwin') return null;
    await new Promise((resolve, reject) =>
      proc.execFile('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', out], { timeout: 20000 }, (error) =>
        error ? reject(error) : resolve(undefined),
      ),
    );
    return await fs.promises.readFile(out);
  } catch {
    return null;
  }
}

/** Electron's own decoder, or null when it can't read the file (or Electron isn't there). */
function nativePng(file) {
  try {
    const img = /** @type {typeof import('electron')} */ (electron).nativeImage.createFromPath(file);
    return img.isEmpty() ? null : img.toPNG();
  } catch {
    return null;
  }
}

/** Whether building the message reads image files (so it has to wait for them). */
const hasImages = (input) => Array.isArray(input?.attachments) && input.attachments.some((a) => a?.kind === 'image');

/**
 * @param {{ text: string, attachments?: any[], prefix?: string, momo?: string | null }} input what the window sent, and
 *   `momo`: MoMo's memory for a new turn of a MoMo chat (electron/momo/contract/context.cjs)
 * @param {(file: string) => any} read an image file's API image source, already read (claudeMessage reads them)
 */
function buildClaudeMessage({ text, attachments = [], prefix, momo = null }, read = () => null) {
  const { withChatReferences } = require('../../../shared/chatReferences.mjs');
  const { withComputerHistory } = require('../../../shared/computerHistory.mjs');
  const { withMomoContext } = require('../../../shared/momoContext.mjs');
  // a referenced browser tab reads as its title and URL (shared/tabMentions.mjs)
  let t = withSelections(
    withTabMentions(String(text ?? ''), 'text'),
    attachments.filter((a) => a.kind === 'selection'),
  );
  const images = [];
  for (const a of attachments) {
    if (a.kind === 'selection' || a.kind === 'session' || a.kind === 'computerHistory') continue;
    if (a.kind === 'image') {
      const source = read(a.path);
      if (source) images.push({ type: 'image', source });
      else t = `${t}\n[${a.name ?? path.basename(a.path)} couldn't be attached]`;
    } else if (a.kind === 'skill') t = `/${a.name} ${t}`;
    else t = `${t}\n@${a.path}`;
  }
  // the memories the user shared go first, as a quoted block (shared/computerHistory.mjs), and MoMo's ahead of them
  t = withMomoContext(withComputerHistory(withChatReferences(t, attachments), attachments), momo);
  const head = prefix ? [{ type: 'text', text: prefix }] : [];
  if (!head.length && !images.length) return { role: 'user', content: t };
  return { role: 'user', content: [...head, ...images, ...(t.trim() ? [{ type: 'text', text: t }] : [])] };
}

/**
 * A message the window built, with MoMo's memory ahead of its first text (a text item of its own when it has none);
 * the message as it was without a valid block.
 * @param {{ role: string, content: string | any[] }} message
 * @param {string | null} block
 */
function withMomoMessage(message, block) {
  const { withMomoContext, isMomoBlock } = require('../../../shared/momoContext.mjs');
  if (!isMomoBlock(block)) return message;
  if (typeof message.content === 'string') return { ...message, content: withMomoContext(message.content, block) };
  const content = Array.isArray(message.content) ? [...message.content] : [];
  const at = content.findIndex((c) => c?.type === 'text' && typeof c.text === 'string');
  if (at >= 0) content[at] = { ...content[at], text: withMomoContext(content[at].text, block) };
  else content.unshift({ type: 'text', text: block });
  return { ...message, content };
}

/** The text of a message the window built: its content, or its text items joined. */
function messageText(/** @type {{ content?: unknown }} */ message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.flatMap((x) => (x?.type === 'text' && typeof x.text === 'string' ? [x.text] : [])).join('\n') : '';
}

/**
 * The Claude message for what the window sent, its images read first, one at a time (each may start sips).
 * @param {{ text: string, attachments?: any[], prefix?: string, momo?: string | null }} input
 * @param {(file: string) => Promise<any>} [read] an image file as an API image source (tests pass their own)
 */
async function claudeMessage(input, read = readImage) {
  const sources = new Map();
  for (const a of input.attachments ?? []) if (a.kind === 'image' && !sources.has(a.path)) sources.set(a.path, await read(a.path));
  return buildClaudeMessage(input, (file) => sources.get(file));
}

/**
 * A MoMo chat's message as Claude Code should read it: the CLI runs a message as its own command when it, or its last
 * text block, starts with "/", so that text is made plain (shared/momoCommands.mjs momoLiteralText).
 * @param {{ role: string, content: string | any[] }} message
 */
function literalMessage(message) {
  const { momoLiteralText } = require('../../../shared/momoCommands.mjs');
  if (typeof message?.content === 'string') return { ...message, content: momoLiteralText(message.content) };
  const content = Array.isArray(message?.content) ? message.content : [];
  const last = content.at(-1);
  if (last?.type !== 'text' || typeof last.text !== 'string') return message;
  return { ...message, content: [...content.slice(0, -1), { ...last, text: momoLiteralText(last.text) }] };
}

module.exports = {
  literalMessage,
  buildClaudeMessage,
  claudeMessage,
  hasImages,
  readImage,
  imageDataUrl,
  toPng,
  withSelections,
  withMomoMessage,
  messageText,
};
