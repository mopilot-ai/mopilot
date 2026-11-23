// The opt-in turn trace (#3571, G5): while the user has it on, each chat turn that uses the browser tools records the agent's tab as frames, each browser action with the frames before and after it, the network as a HAR and the console, into the chat's trace folder, for the Replay on that turn.
//
// A trace begins with the turn's first browser tool call (hostPageGates.cjs touch, or a recorded call) and ends with the
// chat's turn (onTurnEnd), where its trace.json is written; nothing is kept for a turn with no frame and no action.
// Frames follow the agent across the chat's tabs (VideoRecorder follow) under the GIF recorder's rule: high-risk pages,
// pages with a password field and sign-in are left out. The HAR redacts as browser_har does. Action arguments keep no
// typed text: a text or value argument is kept as its length.
const path = require('node:path');
const { fs } = require('../../../platform/ports/fs.cjs');
const { mkdirPrivate } = require('../../../platform/privateFiles.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { VideoRecorder } = require('./videoRecorder.cjs');
const { HarRecorder } = require('./harRecorder.cjs');
const { jpegSize } = require('./movWriter.cjs');
const { prefixUnits } = require('../../../../shared/textPrefix.mjs');
const { writePrivate } = require('../../../platform/fsutil.cjs');

/** About four frames a second, at most MAX_FRAMES a turn, MAX_MS long. */
const GAP_MS = 250;
const MAX_FRAMES = 1200;
const MAX_MS = 60 * 60_000;
const MAX_ACTIONS = 500;
/** Traces a chat keeps (the oldest go first). */
const KEEP = 20;
// what a page is given (typed text, a field's value, a script), not what the agent searches for
const TEXT_ARG = /^(text|value|password|code|script|expression)$/i;

/** Frames of a turn as JPEG files in `<dir>/frames/`: the VideoRecorder's writer for a trace. */
class FrameFiles {
  constructor(/** @type {string} */ dir, /** @type {number} */ max) {
    this.dir = path.join(dir, 'frames');
    mkdirPrivate(this.dir);
    this.max = max;
    /** @type {{ file: string, at: number }[]} */
    this.frames = [];
    this.width = 0;
    this.height = 0;
    this.bytes = 0;
  }

  add(/** @type {Buffer} */ jpeg, /** @type {number} */ at) {
    const size = jpegSize(jpeg);
    if (!size || this.frames.length >= this.max) return false;
    if (!this.frames.length) Object.assign(this, size);
    const file = `${String(this.frames.length + 1).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(this.dir, file), jpeg, { mode: 0o600 });
    this.frames.push({ file: `frames/${file}`, at });
    this.bytes += jpeg.length;
    return true;
  }

  finish() {
    return this.frames.length ? { frames: this.frames.length, width: this.width, height: this.height, bytes: this.bytes } : null;
  }
}

/** A tool call's arguments as a trace keeps them: no typed text, short. */
function argsOf(/** @type {any} */ args) {
  if (!args || typeof args !== 'object') return {};
  return Object.fromEntries(
    Object.entries(args)
      .slice(0, 12)
      .map(([k, v]) => [
        k,
        typeof v === 'string'
          ? TEXT_ARG.test(k)
            ? `<${v.length} chars>`
            : prefixUnits(v, 200)
          : Array.isArray(v)
            ? `[${v.length}]`
            : v && typeof v === 'object'
              ? '{…}'
              : v,
      ]),
  );
}

/**
 * @typedef {{ id: string, dir: string, started: number, frames: FrameFiles, actions: any[], tabs: Set<any>, dropped: number }} Trace
 */

class TurnTraces {
  /**
   * @param {{ enabled: () => boolean, root: (chatId: string) => string | null, riskOf?: (url: string) => { level: string, credentials?: boolean },
   *           images?: any, now?: () => number, onSaved: (chatId: string, summary: any) => void }} o
   *   root: the chat's trace folder (chatFolders.cjs browser-traces), or null when it has none
   */
  constructor({ enabled, root, riskOf = () => ({ level: 'normal' }), images = null, now = Date.now, onSaved }) {
    this.o = { enabled, root, now, onSaved };
    this.video = new VideoRecorder({ images, riskOf, now, gapMs: GAP_MS, maxMs: MAX_MS, follow: true });
    this.har = new HarRecorder({ riskOf, now });
    /** @type {Map<string, Trace>} chat -> its running trace */
    this.chats = new Map();
  }

  /** The chat's running trace, begun now when the user has traces on (its frames and HAR start with the first tab). */
  #begin(/** @type {string} */ chatId) {
    const have = this.chats.get(chatId);
    if (have || !this.o.enabled()) return have ?? null;
    const root = this.o.root(chatId);
    if (!root) return null;
    const started = this.o.now();
    const id = new Date(started).toISOString().replace(/[:.]/g, '-');
    const dir = path.join(root, id);
    mkdirPrivate(dir);
    /** @type {Trace} */
    const t = { id, dir, started, frames: new FrameFiles(dir, MAX_FRAMES), actions: [], tabs: new Set(), dropped: 0 };
    this.chats.set(chatId, t);
    return t;
  }

  /** A tool call on `tab` passed its page gate: its turn's trace begins, or takes the tab up. Never throws. */
  async touch(tab) {
    try {
      const t = this.#begin(tab.chatId);
      if (!t) return;
      const first = !t.tabs.size;
      t.tabs.add(tab);
      if (first) {
        await this.video.start(tab.chatId, tab, '', t.frames);
        await this.har.start(tab.chatId, tab);
        return;
      }
      await this.video.touch(tab);
      await this.har.touch(tab);
    } catch (error) {
      noteIgnored('trace a browser turn', error);
    }
  }

  /** A browser tool's definition whose calls a running trace records (before and after frames, how it went). */
  wrap(/** @type {{ name: string, handler: (args: any, ctx: any) => any }} */ tool) {
    if (!/^(browser|chrome)_/.test(tool.name)) return tool;
    const handler = tool.handler;
    return {
      ...tool,
      handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
        // a call begins the turn's trace itself: a navigation runs before any page gate
        const t = ctx?.chatId ? this.#begin(ctx.chatId) : null;
        const t0 = this.o.now();
        const before = t ? t.frames.frames.length : 0;
        const note = (/** @type {string | null} */ error) => {
          const now = t;
          if (!now) return;
          if (now.actions.length >= MAX_ACTIONS) return void now.dropped++;
          now.actions.push({
            tool: tool.name,
            args: argsOf(args),
            at: t0,
            ms: this.o.now() - t0,
            ok: !error,
            error,
            before,
            after: now.frames.frames.length,
          });
        };
        let out;
        try {
          out = await handler(args, ctx);
        } catch (e) {
          note(prefixUnits(String(/** @type {any} */ (e)?.message ?? e).split('\n')[0], 300));
          throw e;
        }
        note(null);
        return out;
      },
    };
  }

  /** A registry whose register() wraps the browser tools it is given (as the routine recorder's does). */
  recording(/** @type {{ register: (tool: any) => () => void }} */ registry) {
    return new Proxy(registry, {
      get: (target, prop) =>
        prop === 'register' ? (/** @type {any} */ tool) => target.register(this.wrap(tool)) : Reflect.get(target, prop),
    });
  }

  /** The chat's turn ended: its trace is written (trace.json, network.har) and told; an empty one is removed. */
  async endTurn(/** @type {string} */ chatId) {
    const t = this.chats.get(chatId);
    if (!t) return null;
    this.chats.delete(chatId);
    const shot = this.video.stop(chatId)?.saved ?? null;
    const har = this.har.stop(chatId);
    try {
      if (!shot && !t.actions.length) {
        fs.rmSync(t.dir, { recursive: true, force: true });
        return null;
      }
      const ended = this.o.now();
      // a turn whose calls never reached a tab (a refused navigation) has steps but no HAR
      const log = har ? await this.har.har(har, '1') : null;
      if (log) writePrivate(path.join(t.dir, 'network.har'), JSON.stringify(log), fs);
      const console = [...t.tabs].flatMap((tab) =>
        // a tab with no console buffer (a remote Host's) has nothing to add
        (tab.console ?? [])
          .filter((c) => c.at >= t.started && c.at <= ended)
          .map((c) => ({ at: c.at, level: c.level, text: prefixUnits(String(c.text), 500) })),
      );
      const trace = {
        version: 1,
        id: t.id,
        startedAt: t.started,
        endedAt: ended,
        width: shot?.width ?? 0,
        height: shot?.height ?? 0,
        frames: t.frames.frames,
        actions: t.actions,
        droppedActions: t.dropped,
        console: console.sort((a, b) => a.at - b.at).slice(-500),
        requests: log ? log.log.entries.length : 0,
        har: log ? 'network.har' : null,
      };
      // written last and whole: a trace.json that exists is complete (list() reads only those)
      writePrivate(path.join(t.dir, 'trace.json'), JSON.stringify(trace), fs);
      this.#prune(path.dirname(t.dir));
      const summary = { id: t.id, startedAt: t.started, endedAt: ended, frames: trace.frames.length, actions: t.actions.length };
      this.o.onSaved(chatId, summary);
      return summary;
    } catch (error) {
      noteIgnored('save a browser turn trace', error);
      return null;
    }
  }

  /** At most KEEP traces in a chat's folder: the oldest go. */
  #prune(/** @type {string} */ root) {
    const ids = fs.readdirSync(root).sort();
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) fs.rmSync(path.join(root, id), { recursive: true, force: true });
  }

  /** The chat's saved traces, newest last: each trace.json with its folder (frame files are under it). */
  list(/** @type {string} */ chatId) {
    const root = this.o.root(chatId);
    if (!root || !fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .sort()
      .flatMap((id) => {
        try {
          return [{ ...JSON.parse(fs.readFileSync(path.join(root, id, 'trace.json'), 'utf8')), dir: path.join(root, id) }];
        } catch (error) {
          // a trace still being written, or one that lost its file
          noteIgnored('read a browser turn trace', error);
          return [];
        }
      });
  }
}

module.exports = { TurnTraces, FrameFiles, argsOf, GAP_MS, MAX_FRAMES, MAX_ACTIONS, KEEP };
