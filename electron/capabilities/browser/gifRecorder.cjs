// browser_gif_creator (and gif_creator on the chrome_* surface): records the pages a chat's agent works on as an animated GIF in the chat's upload folder, as Claude in Chrome's gif tool does.
//
// Recording is per chat (Claude in Chrome scopes it to the tab group). While it records:
// - every tool call on a tab of the chat adds a frame of that tab once its page gate passed (hostPageGates.cjs calls
//   touch), so a background Chrome tab that paints no frames is still recorded step by step, and a site the chat may
//   not read never is;
// - the tab's CDP screencast adds the frames in between where the tab paints (the in-app browser, a Chrome tab in front),
//   so typing, scrolling and the agent cursor's moves show. Its frames are acknowledged as they come.
// Frames are JPEGs at most WIDTH pixels wide, at most one per GAP_MS (a burst keeps its last), and when more than
// MAX_FRAMES are kept every other one goes, so a long recording keeps its whole length at a lower frame rate. A page of
// a high-risk site (siteRisk.cjs), one with credentials in its address, a page with a password field (the frames are
// not masked as screenshots are) and a tab the user is signing in on or took over are never recorded. export encodes the frames (gifEncode.cjs) into `<uploads>/recordings/`, as browser_save_screenshot saves
// into `<uploads>/screenshots/`, so browser_file_upload can attach it.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const lease = require('./screencastLease.cjs');
const { encodeGif } = require('./gifEncode.cjs');
const { PROBE_MS, credentialFieldIn } = require('./credentialProbe.cjs');
const { tabArg } = require('./hostToolArgs.cjs');

const WIDTH = 640;
const GAP_MS = 150;
const MAX_FRAMES = 150;
/** How many chats keep a recording (the least recent goes first). */
const MAX_CHATS = 10;
/** An encoded GIF larger than this is encoded again from every other frame. */
const MAX_GIF_BYTES = 15 * 1024 * 1024;
/** How long the last frame shows, and the longest any frame shows (a pause between turns is cut to it). */
const LAST_MS = 1500;
const LONGEST_MS = 4000;
const SUBFOLDER = 'recordings';
/** Whether the page has a password field (read in the page's world: nothing of it comes back but this boolean). */
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: WIDTH, maxHeight: WIDTH * 2, everyNthFrame: 1 };

/** @typedef {{ recording: boolean, frames: { jpeg: Buffer, at: number }[], skipped: number, casting: Set<any> }} Recording */

class GifRecorder {
  /**
   * @param {{ images: { fromBuffer: (buf: Buffer) => any }, riskOf?: (url: string) => { level: string, credentials?: boolean },
   *           now?: () => number, width?: number, gapMs?: number, maxFrames?: number, maxBytes?: number }} o
   */
  constructor({
    images,
    riskOf = () => ({ level: 'normal' }),
    now = Date.now,
    width = WIDTH,
    gapMs = GAP_MS,
    maxFrames = MAX_FRAMES,
    maxBytes = MAX_GIF_BYTES,
  }) {
    this.images = images;
    this.riskOf = riskOf;
    this.now = now;
    this.width = width;
    this.gapMs = gapMs;
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    /** @type {Map<string, Recording>} */
    this.chats = new Map();
    /** debuggers whose screencast frames this recorder takes */
    this.heard = new WeakSet();
    /** tab -> whether its page had a password field at its last tool call (its frames are left out then) */
    this.passwords = new WeakMap();
  }

  /** Starts a new recording for the chat; returns how many frames an earlier one had (they are dropped). */
  start(chatId) {
    const old = this.chats.get(chatId);
    this.#stopCasts(old);
    this.chats.delete(chatId);
    this.chats.set(chatId, { recording: true, frames: [], skipped: 0, casting: new Set() });
    while (this.chats.size > MAX_CHATS) this.clear(/** @type {string} */ (this.chats.keys().next().value));
    return old?.frames.length ?? 0;
  }

  /** Stops recording; the frames stay for export. Returns the recording, or null when there is none. */
  stop(chatId) {
    const s = this.chats.get(chatId) ?? null;
    if (s) s.recording = false;
    this.#stopCasts(s);
    return s;
  }

  clear(chatId) {
    this.#stopCasts(this.chats.get(chatId));
    this.chats.delete(chatId);
  }

  /** A tool call on `tab` (BrowserTabs.ready): while its chat records, a frame now and the tab's screencast from now on. Never throws. */
  async touch(tab) {
    const s = this.chats.get(tab.chatId);
    if (!s?.recording) return;
    try {
      this.#cast(s, tab);
      // a sign-in form in another site's frame counts too; a page or frame it can't read is skipped
      this.passwords.set(tab, await credentialFieldIn(tab, { ms: PROBE_MS, unreadable: true }));
      if (!this.#allowed(tab)) return void s.skipped++;
      const r = await tab.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, optimizeForSpeed: true });
      const img = this.images.fromBuffer(Buffer.from(r.data, 'base64'));
      const jpeg = img.getSize().width > this.width ? img.resize({ width: this.width }).toJPEG(70) : img.toJPEG(70);
      this.#keep(s, jpeg);
    } catch (error) {
      noteIgnored('record a frame of a browser tab', error);
    }
  }

  #allowed(tab) {
    const risk = tab.url ? this.riskOf(tab.url) : null;
    return !tab.signin && !tab.takenOver && !this.passwords.get(tab) && !!risk && risk.level === 'normal' && !risk.credentials;
  }

  #keep(s, jpeg) {
    const at = this.now();
    const last = s.frames[s.frames.length - 1];
    // a burst keeps its last frame, at the burst's start
    if (last && at - last.at < this.gapMs) last.jpeg = jpeg;
    else s.frames.push({ jpeg, at });
    if (s.frames.length > this.maxFrames) s.frames = s.frames.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
  }

  /** The tab's screencast, once per CDP session: it ends when the debugger detaches, and the next touch starts it again. */
  #cast(s, tab) {
    const dbg = tab.backend?.debugger;
    if (s.casting.has(tab) || typeof dbg?.on !== 'function') return;
    s.casting.add(tab);
    if (!this.heard.has(dbg)) {
      this.heard.add(dbg);
      dbg.on('message', (_e, method, p, sessionId) => {
        if (method !== 'Page.screencastFrame' || sessionId) return;
        tab
          .send('Page.screencastFrameAck', { sessionId: p.sessionId })
          .catch((error) => noteIgnored('acknowledge a screencast frame', error));
        const cur = this.chats.get(tab.chatId);
        if (!cur?.recording || !cur.casting.has(tab)) return;
        if (this.#allowed(tab)) this.#keep(cur, Buffer.from(p.data, 'base64'));
        else cur.skipped++;
      });
      dbg.on('detach', () => {
        lease.detached(tab);
        for (const c of this.chats.values()) {
          if (c.casting.delete(tab)) lease.release(tab, c);
        }
      });
    }
    lease.acquire(tab, s, SCREENCAST, () => {
      s.casting.delete(tab);
      lease.release(tab, s);
    });
  }

  #stopCasts(s) {
    if (!s) return;
    for (const tab of s.casting) lease.release(tab, s);
    s.casting.clear();
  }

  /**
   * Encodes the chat's frames into `<root>/recordings/<name>.gif`.
   * @returns {Promise<{ file: string, frames: number, width: number, height: number, ms: number, bytes: number, skipped: number }>}
   */
  async export(chatId, root, name = null) {
    const s = this.chats.get(chatId);
    if (!s?.frames.length)
      throw new ToolError(
        'Nothing is recorded in this chat. Call this tool with action "start_recording", work in the tab, then "stop_recording" and "export".',
        'bad_args',
      );
    let kept = s.frames;
    const decode = (f) => {
      const img = this.images.fromBuffer(f.jpeg);
      return img.getSize().width > this.width ? img.resize({ width: this.width }) : img;
    };
    // sizes first, the pixels one frame at a time while encoding: never every frame's bitmap at once
    const sizes = new Map(s.frames.map((f) => [f, decode(f).getSize()]));
    for (;;) {
      const frames = kept.map((f, i) => ({
        ...sizes.get(f),
        load: () => decode(f).toBitmap(),
        delayMs: i + 1 < kept.length ? Math.min(LONGEST_MS, kept[i + 1].at - f.at) : LAST_MS,
      }));
      const out = await encodeGif(frames);
      if (out.gif.length > this.maxBytes && kept.length > 2) {
        kept = kept.filter((_, i) => i % 2 === 0 || i === kept.length - 1);
        continue;
      }
      const file = writeGif(root, out.gif, name);
      const ms = frames.reduce((sum, f) => sum + f.delayMs, 0);
      return { file, frames: out.frames, width: out.width, height: out.height, ms, bytes: out.gif.length, skipped: s.skipped };
    }
  }
}

/** Writes the GIF under a free name in `<root>/recordings/`; returns its path. */
function writeGif(root, gif, name) {
  const dir = path.join(root, SUBFOLDER);
  require('../../platform/privateFiles.cjs').mkdirPrivate(dir);
  // hostScreenshots.cjs requires this module: its file-name rule is read when a GIF is written
  const { safeName } = require('./hostScreenshots.cjs');
  const asked = safeName(String(name ?? '').replace(/\.gif$/i, ''));
  const base = asked || `recording-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  /** @returns {string} the first free name from `-n` on */
  const write = (n) => {
    const file = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}.gif`);
    try {
      fs.writeFileSync(file, gif, { flag: 'wx', mode: 0o600 });
      return file;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      return write(n + 1);
    }
  };
  return write(1);
}

/**
 * browser_gif_creator's handler.
 * @param {{ tabs: any, recorder: GifRecorder, uploadRoot: (chatId: string, what: string) => string,
 *           pageGate: (tab: any, need: string, ctx: any) => Promise<unknown> }} o
 */
function gifTool({ tabs, recorder, uploadRoot, pageGate }) {
  /** The tab the action names (or the current one) gets a frame once its page gate passed, as any tool call's does. */
  const frameOf = async (args, ctx) => {
    const tab = await tabs.resolve(ctx.chatId, tabArg(args));
    await tabs.run(tab, async () => {
      await tabs.ready(tab, ctx.chatId);
      await pageGate(tab, 'read', ctx);
    });
    return tab;
  };
  return async (args, ctx) => {
    switch (args.action) {
      case 'start_recording': {
        const dropped = recorder.start(ctx.chatId);
        const tab = await frameOf(args, ctx);
        return `Recording this chat's tabs, starting with ${tab.id}: each step you take adds a frame until stop_recording.${dropped ? ` The earlier recording (${dropped} frames, not exported) was dropped.` : ''}`;
      }
      case 'stop_recording': {
        if (recorder.chats.get(ctx.chatId)?.recording) await frameOf(args, ctx);
        const s = recorder.stop(ctx.chatId);
        if (!s) return 'Nothing was recording in this chat.';
        return `Stopped recording: ${s.frames.length} frame${s.frames.length === 1 ? '' : 's'} kept. Call export to save the GIF.`;
      }
      case 'export': {
        if (recorder.chats.get(ctx.chatId)?.recording) {
          await frameOf(args, ctx);
          recorder.stop(ctx.chatId);
        }
        const root = uploadRoot(ctx.chatId, 'Saving recordings');
        const r = await recorder.export(ctx.chatId, root, args.filename ?? null);
        const left = r.skipped
          ? ` ${r.skipped} frame${r.skipped === 1 ? ' was' : 's were'} left out (high-risk pages and sign-in are never recorded).`
          : '';
        return `Saved a GIF of ${r.frames} frames (${r.width}x${r.height}, ${(r.ms / 1000).toFixed(1)} s, ${Math.ceil(r.bytes / 1024)} KB) to ${r.file}.${left} Attach it with browser_file_upload (paths: [that file]); the user confirms each upload.`;
      }
      case 'clear':
        recorder.clear(ctx.chatId);
        return "Cleared this chat's recording.";
      default:
        throw new ToolError('action must be "start_recording", "stop_recording", "export" or "clear".', 'bad_args');
    }
  };
}

module.exports = { GifRecorder, gifTool, writeGif, WIDTH, GAP_MS, MAX_FRAMES, SUBFOLDER };
