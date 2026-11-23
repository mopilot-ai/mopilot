// Screenshots an agent can attach to a form: every image a browser tool returns gets an id (kept in memory, per chat), and browser_save_screenshot or browser_file_upload's `screenshots` writes one into the chat's upload folder.
//
// Nothing here loosens what an upload may send: a saved screenshot is a file inside the chat's upload folder like any
// other, and browser_file_upload still checks the folder and asks the user for each upload (hostTools.cjs). The capture
// goes through the read gate and keeps password fields and the agent cursor out (hostCapture.cjs).
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { oneLine } = require('./host.cjs');
const { tabArg, isInside } = require('./hostToolArgs.cjs');
const { GifRecorder, gifTool } = require('./gifRecorder.cjs');
const { devtoolsTools } = require('./devtools/tools.cjs');
const { mkdirPrivate } = require('../../platform/privateFiles.cjs');

/**
 * How many screenshots a chat keeps (the oldest goes first), how many chats keep theirs (the least recent goes first),
 * and how many bytes of image data all of them may hold in main (the least recent chat's oldest goes first).
 */
const PER_CHAT = 20;
const CHATS = 50;
const MAX_BYTES = 64 * 1024 * 1024;
/** The folder under the chat's upload folder that saved screenshots go to. */
const SUBFOLDER = 'screenshots';
/** How a screenshot's id line says the browser_* tools attach it. */
const DEFAULT_NOTE = "To attach it to a file input, give it in browser_file_upload's screenshots.";
/** How the browser_* tools attach a saved screenshot. */
const ATTACH = (/** @type {string} */ _file, /** @type {string} */ id) =>
  `Attach it with browser_file_upload (paths: [that file], or screenshots: ["${id}"])`;

/**
 * The recent screenshots of each chat, by id. An id is random, so an id one browser's tools reported never names
 * another browser's image (the in-app browser and Chrome each have their own tools and shelf).
 */
class ScreenshotShelf {
  constructor({ perChat = PER_CHAT, chats = CHATS, maxBytes = MAX_BYTES } = {}) {
    this.perChat = perChat;
    this.chats = chats;
    this.maxBytes = maxBytes;
    /** the length of every kept image's data */
    this.bytes = 0;
    /** @type {Map<string, Map<string, { data: string, mimeType: string, url: string, file?: string }>>} */
    this.byChat = new Map();
  }

  /** Keeps an image for the chat; returns its id. The newest image is always kept. */
  keep(chatId, /** @type {{ data: string, mimeType: string, url?: string }} */ shot) {
    const id = `ss_${crypto.randomBytes(4).toString('hex')}`;
    const list = this.byChat.get(chatId) ?? new Map();
    // the chat used last goes to the end, so the one dropped is the least recent
    this.byChat.delete(chatId);
    this.byChat.set(chatId, list);
    list.set(id, { data: shot.data, mimeType: shot.mimeType, url: shot.url || '' });
    this.bytes += shot.data.length;
    while (list.size > this.perChat) this.#dropOldest(chatId);
    while (this.byChat.size > this.chats) this.#dropChat(this.byChat.keys().next().value);
    // the current chat is last, so it gives up images only when it is the only one left
    while (this.bytes > this.maxBytes && !(this.byChat.size === 1 && list.size === 1)) this.#dropOldest(this.byChat.keys().next().value);
    return id;
  }

  get(chatId, id) {
    return this.byChat.get(chatId)?.get(String(id)) ?? null;
  }

  #dropOldest(chatId) {
    const list = /** @type {Map<string, { data: string }>} */ (this.byChat.get(chatId));
    const [id, shot] = /** @type {[string, { data: string }]} */ (list.entries().next().value);
    list.delete(id);
    this.bytes -= shot.data.length;
    if (!list.size) this.byChat.delete(chatId);
  }

  #dropChat(chatId) {
    for (const shot of /** @type {Map<string, { data: string }>} */ (this.byChat.get(chatId)).values()) this.bytes -= shot.data.length;
    this.byChat.delete(chatId);
  }
}

/** A file name from what the agent asked for: letters, digits, dot, dash and underscore, no extension, at most 80. */
function safeName(name) {
  const base = String(name ?? '')
    .replace(/\.(png|jpe?g)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return base;
}

/** The page's host for a file name (the upload card shows it): empty when the page has none. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/[^A-Za-z0-9.-]/g, '');
  } catch {
    return '';
  }
}

/**
 * Writes a kept screenshot into `<root>/screenshots/`; returns its absolute path. The file for an id is always the
 * same, so the same screenshot uploaded twice is one file; a name the agent gave that is taken gets -2, -3, ...
 */
function writeShot(root, shot, id, name = null) {
  const dir = path.join(root, SUBFOLDER);
  mkdirPrivate(dir);
  const ext = shot.mimeType === 'image/png' ? '.png' : '.jpg';
  const host = hostOf(shot.url);
  const asked = safeName(name);
  const base = asked || `screenshot-${host ? `${host}-` : ''}${id}`;
  let file = '';
  for (let n = 1; !file; n++) {
    const next = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}${ext}`);
    try {
      fs.writeFileSync(next, Buffer.from(shot.data, 'base64'), { flag: 'wx', mode: 0o600 });
      file = next;
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'EEXIST') throw e;
      // this id's own file is already there: the same image
      if (!asked) file = next;
    }
  }
  return file;
}

/**
 * The screenshot side of the browser tools, for createBrowserTools.
 * @param {{ tabs: any, folders: ((chatId: string) => { uploads: string, downloads?: string | null } | null) | null, shelf: ScreenshotShelf,
 *           pageGate: (tab: any, need: string, ctx: any) => Promise<any>, status: (tab: any) => string,
 *           riskOf: (url: string) => { level: string, credentials?: boolean },
 *           chromeShots?: ((chatId: string, tabId: unknown) => ((args: any, ctx: any) => Promise<any[]>) | null) | null,
 *           chromeRoute?: ((chatId: string) => string | null) | null, attach?: ((file: string, id: string) => string) | null }} o
 *   riskOf: the site's risk (OriginGrants.riskOf): a file name names only an ordinary site, so an upload never tells the
 *   destination which bank or health site the screenshot came from
 *   chromeShots: browser_save_screenshot for a tab of the chat's Chrome group that these tabs don't have (a native Codex
 *   thread's plugin tab on MoPilot's Chrome backend, chromeScreenshots.cjs), or null for any other tab id
 *   chromeRoute: the Chrome controller the chat's browser tools don't reach (hostTools.cjs), named when a tab is not found
 *   attach: how another browser's saved screenshot is attached, as its result and its image's id say (null: browser_file_upload)
 */
function screenshotTools({ tabs, folders, shelf, pageGate, status, riskOf, chromeShots = null, chromeRoute = null, attach = null }) {
  // another browser's tools say how their screenshot is attached, on its result and its id line
  const attachNote = !!attach;
  attach ??= ATTACH;
  /** The page a kept image came from, for its file name: empty for a high-risk site or a URL with credentials. */
  const source = (url) => {
    const risk = url ? riskOf(url) : null;
    return risk && risk.level === 'normal' && !risk.credentials ? url : '';
  };

  /** The chat's upload folder (real path), made if missing; refuses when the chat has none. */
  const uploadRoot = (chatId, what) => {
    const f = folders?.(chatId);
    if (!f) throw new ToolError(`${what} is turned off.`, 'disabled');
    mkdirPrivate(f.uploads);
    return fs.realpathSync(f.uploads);
  };

  /**
   * Content items with an id after each image: the image is kept on the chat's shelf (or was, by browser_save_screenshot),
   * and the text says how to attach it. `from` (the page's URL) and `screenshotId` are taken off the image item.
   */
  const tag = (chatId, items) =>
    items.flatMap((c) => {
      if (!c || c.type !== 'image') return [c];
      // `attachNote`: a screenshot another browser's tools saved says how it is attached there
      const { from, screenshotId, attachNote, ...image } = c;
      const id = screenshotId || shelf.keep(chatId, { data: image.data, mimeType: image.mimeType, url: source(from) });
      const how = attachNote || DEFAULT_NOTE;
      return [image, { type: 'text', text: `Screenshot ID: ${id}. ${how}` }];
    });

  /** The files browser_file_upload sets: `paths` and saved `screenshots`, each a file inside the chat's upload folder. */
  const uploadFiles = (args, chatId) => {
    const root = uploadRoot(chatId, 'File upload');
    const saved = (Array.isArray(args.screenshots) ? args.screenshots : []).map((id) => {
      const shot = shelf.get(chatId, id);
      if (!shot)
        throw new ToolError(
          `No screenshot ${oneLine(id, 40)} in this chat: take a screenshot and give the Screenshot ID its result names.`,
          'bad_args',
        );
      // a screenshot browser_save_screenshot already saved is that file, under the name the agent gave it
      return shot.file && fs.existsSync(shot.file) ? shot.file : writeShot(root, shot, String(id));
    });
    const files = [...(Array.isArray(args.paths) ? args.paths : []), ...saved].map((p) => {
      let real;
      try {
        real = fs.realpathSync(path.isAbsolute(String(p)) ? String(p) : path.join(root, String(p)));
      } catch {
        throw new ToolError(`No such file: ${oneLine(p, 300)}`, 'bad_args');
      }
      if (!isInside(real, root) || !fs.statSync(real).isFile())
        throw new ToolError(`Only files inside ${root} can be uploaded: ${oneLine(p, 300)}`, 'bad_args');
      return real;
    });
    // no files at all: the chooser is answered with none, as before
    return files;
  };

  /** browser_save_screenshot: the viewport, a region, one element (ref) or the whole page, as a file in the upload folder. */
  const save = async (args, ctx) => {
    const tabId = tabArg(args);
    // a tab of the chat's Chrome group (#1539): an id of the pane's tabs stays the pane's
    const chrome =
      tabId != null &&
      /** @type {any} */ (tabs).localDataAllowed?.(ctx.chatId) !== false &&
      !tabs.list(ctx.chatId).some((t) => t.id === tabId)
        ? chromeShots?.(ctx.chatId, tabId)
        : null;
    if (chrome) return chrome(args, ctx);
    const tab = await tabs.resolve(ctx.chatId, tabId).catch((/** @type {any} */ e) => {
      throw notHere(e, ctx.chatId);
    });
    const root = uploadRoot(ctx.chatId, 'Saving screenshots');
    return tabs.run(tab, async () => {
      await tabs.ready(tab, ctx.chatId);
      await pageGate(tab, 'read', ctx);
      let shot;
      let what;
      if (args.full_page) {
        shot = await tabs.captureFull(tab);
        what = shot.truncated ? 'the whole page, cut at 8000 pixels' : 'the whole page';
      } else {
        let region = args.region ?? null;
        what = region ? 'a region' : 'the viewport';
        // scrolled into view first, so the viewport is read after it
        const box = args.ref ? await tabs.locate(tab, String(args.ref), { hit: true }) : null;
        if (box) region = [box.x - box.w / 2, box.y - box.h / 2, box.x + box.w / 2, box.y + box.h / 2];
        const st = await tabs.ready(tab, ctx.chatId, { input: true });
        shot = await tabs.capture(tab, st, { region });
        // an element larger than the viewport is captured as far as the viewport shows it: the result says so
        const cut = box && shot.rect && (shot.rect.width < Math.floor(box.w) || shot.rect.height < Math.floor(box.h));
        if (box) what = `element ${oneLine(args.ref, 40)}${cut ? ' (cut to the part inside the viewport)' : ''}`;
      }
      const image = { data: shot.data, mimeType: 'image/jpeg', url: source(tab.url) };
      const id = shelf.keep(ctx.chatId, image);
      const file = writeShot(root, image, id, args.name ?? null);
      /** @type {any} */ (shelf.get(ctx.chatId, id)).file = file;
      return [
        {
          type: 'text',
          text: `Saved a screenshot of ${what} of ${tab.id} (${shot.width}x${shot.height}) to ${file}. ${attach(file, id)}; the user confirms each upload. ${status(tab)}`,
        },
        {
          type: 'image',
          data: image.data,
          mimeType: image.mimeType,
          screenshotId: id,
          ...(attachNote ? { attachNote: `${attach(file, id)}.` } : {}),
        },
      ];
    });
  };

  /**
   * A tab these tools don't have, in a chat whose Chrome another controller drives (Claude in Chrome, the Codex Browser
   * plugin on the vendor's Chrome, Your Chrome): the agent is told what can't be done and what to do instead.
   */
  const notHere = (/** @type {any} */ e, /** @type {string} */ chatId) => {
    const route = e?.code === 'bad_args' ? chromeRoute?.(chatId) : null;
    if (!route) return e;
    return new ToolError(
      `${e.message} This chat's browser is ${route}, whose tabs browser_save_screenshot can't capture. To attach a screenshot of a page there, use that controller's own screenshot upload where it has one, or open the page in the built-in browser (browser_navigate) and save it there; otherwise ask the user to attach the file.`,
      'bad_args',
    );
  };

  // one recorder per browser host, which its ready() feeds (hostPage.cjs): the chrome_* tools' inner tools share it
  const recorder = (tabs.gif ??= new GifRecorder({ images: tabs.o?.images, riskOf }));
  const impl = {
    browser_save_screenshot: save,
    browser_gif_creator: gifTool({ tabs, recorder, uploadRoot, pageGate }),
    // the devtools group: video, HAR, traces, vitals and audits, saved into the same upload folder
    ...devtoolsTools({ tabs, pageGate, uploadRoot, riskOf }),
  };
  return { tag, uploadFiles, save, impl };
}

module.exports = { ScreenshotShelf, screenshotTools, writeShot, safeName, PER_CHAT, CHATS, MAX_BYTES, SUBFOLDER };
