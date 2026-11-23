// The browser host's page operations: readiness checks before an action, settling after it, navigation, reading and finding, locators, dialogs, files, device emulation and the console and network logs.
const { heldError } = require('./userTurn.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { deviceOf, emulationCommands, resetCommands } = require('./devices.cjs');
const { BUFFER_MAX, sleep, stale, oneLine } = require('./hostUtil.cjs');
const { reveal, used } = require('./hostTabs.cjs');
const { HostNavigation } = require('./hostNavigation.cjs');
const { paint } = require('./hostViewport.cjs');
const { holdNativeScale } = require('./pageZoom.cjs');
const { levelPinch } = require('./pinchLevel.cjs');
const { UNREADABLE_FRAME } = require('./siteRisk.cjs');
const { execIn, peekIn } = require('./pageExec.cjs');
const { readHidden } = require('./hiddenText.cjs');

/** How many cross-origin frames deep an action's target is followed before it counts as unreadable. */
const MAX_FRAME_HOPS = 16;

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs the host these methods and helpers run on */
/** @typedef {import('./host.cjs').Tab} Tab */
/** @typedef {import('./host.cjs').PagePoint} PagePoint */

class HostPage extends HostNavigation {
  /* ----------------------------------------------------------------- */
  /* page operations (called inside run())                              */
  /* ----------------------------------------------------------------- */

  /**
   * Fails closed: the tab must still be this chat's, with no blocking dialog, and visible for input.
   * @this {BrowserTabs}
   */
  async ready(tab, chatId, { input = false, allowDialog = false } = {}) {
    if (tab.chatId !== chatId) throw new ToolError(`Tab ${tab.id} is not this chat's.`, 'bad_target');
    tab.check();
    const root = tab.kind === 'popup' ? tab.root : tab;
    if (tab.takenOver || root?.takenOver)
      throw new ToolError(
        `The user took over ${root?.takenOver ? root.id : tab.id} and is using it now. Don't act on it again this turn: tell the user what is left to do, or use another tab.`,
        'taken_over',
      );
    const signing = tab.signin ? tab : root?.signin ? root : null;
    if (signing) throw heldError(signing);
    // the agent has the tab again: a hand-off the user once took to their Chrome is over
    tab.signinMoved = '';
    tab.hold();
    used(this, tab);
    reveal(this, tab);
    await tab.attach();
    // the user's Chrome shows that an agent works on the tab (agentControlFrame.cjs): drawn beside the call, never in its way
    if (this.o.cursor) void this.o.cursor.hold(tab);
    if (tab.dialog && !allowDialog)
      throw new ToolError(
        `A ${tab.dialog.type} dialog is open in ${tab.id}: "${oneLine(tab.dialog.message, 300)}". Answer it with browser_handle_dialog first.`,
        'dialog_open',
      );
    // The view owns page layout. Agent control must not shrink text or change responsive breakpoints.
    if (!input) return null;
    // pointer input and the screenshot frame are in layout pixels; reads are too and need nothing, so the user's pinch stays for them
    await levelPinch(tab);
    await paint(this, tab);
    let st = await tab.agent('state');
    if (st.visibility === 'hidden' && tab.kind === 'tab' && !this.o.inputWhileHidden) {
      // input to a hidden guest can be dropped: bring its pane tab to the front
      try {
        this.o.select(tab);
      } catch (error) {
        // if it stays hidden the loop below gives up
        noteIgnored('bring a hidden pane tab to the front for input', error);
      }
      for (let i = 0; i < 15 && st.visibility === 'hidden'; i++) {
        await sleep(100);
        st = await tab.agent('state');
      }
      if (st.visibility === 'hidden')
        throw new ToolError(
          'The browser pane is hidden, so the page cannot take input. Open the browser pane in MoPilot (or call browser_tabs_select) and try again.',
          'hidden',
        );
    }
    return st;
  }

  /**
   * The URL "back" or "forward" would open, or null when there is none.
   * @this {BrowserTabs}
   */
  historyTarget(tab, dir) {
    const h = tab.backend.navigationHistory;
    const i = h.getActiveIndex() + (dir === 'back' ? -1 : 1);
    if (i < 0 || i >= h.length()) return null;
    return h.getEntryAtIndex(i)?.url ?? null;
  }

  /** @this {BrowserTabs} */
  async readPage(tab, { filter = 'visible', depth = 15, ref = null, maxChars = 50000 } = {}) {
    const lines = [];
    let truncated = false;
    let budget = maxChars;
    const expand = async (sessionId, args, indent) => {
      const out = await tab.agent('tree', { ...args, maxChars: Math.max(1000, budget) }, sessionId);
      if (out?.error === 'stale') throw stale(args.ref);
      tab.noteRefs(out.lines, sessionId);
      if (out.truncated) truncated = true;
      for (const line of out.lines) {
        const m = /^\u0001FRAME (ref_\d+) (\d+)\u0001$/.exec(line);
        if (!m) {
          lines.push(indent + line);
          budget -= line.length + indent.length + 1;
          continue;
        }
        const d = Number(m[2]);
        const pad = indent + '  '.repeat(d);
        const frame = await frameByOwner(this, tab, sessionId, m[1]);
        if (!frame) {
          lines.push(`${pad}- (frame content unavailable)`);
          continue;
        }
        if (args.depth - d <= 0 || budget <= 0) continue;
        await expand(frame.sessionId, { filter: args.filter, depth: args.depth - d }, pad);
      }
    };
    const sessionId = ref ? tab.frameOf(ref) : '';
    await expand(sessionId, { filter, depth, ref }, '');
    return { lines, truncated: truncated || budget <= 0 };
  }

  /** @this {BrowserTabs} */
  async find(tab, query, limit = 20) {
    const lines = [];
    const visit = async (sessionId) => {
      if (lines.length >= limit) return;
      const out = await tab.agent('find', { query, limit: limit - lines.length }, sessionId);
      tab.noteRefs(out.lines, sessionId);
      lines.push(...out.lines);
      for (const ownerRef of out.frames) {
        const frame = await frameByOwner(this, tab, sessionId, ownerRef);
        if (frame) await visit(frame.sessionId);
      }
    };
    await visit('');
    return lines.slice(0, limit);
  }

  /**
   * A ref's center in top-frame viewport coordinates (scrolled into view first unless `scroll` is false),
   * with its size; `hit` also reports what covers its center in its own frame (`cover`, or null).
   * @this {BrowserTabs}
   */
  async locate(tab, ref, { scroll = true, hit = false } = {}) {
    let sessionId = tab.frameOf(ref);
    const loc = await tab.agent('locate', hit || !scroll ? { ref, scroll, hit } : { ref }, sessionId);
    if (loc?.error === 'stale') throw stale(ref);
    // the element's name is optional detail for the action record
    const noteName = (l) => l.nameError && noteIgnored('read the name of the element a browser action targets', l.nameError);
    noteName(loc);
    let { x, y } = loc;
    while (sessionId) {
      const frame = tab.frames.get(sessionId);
      if (!frame) throw stale(ref);
      const owner = await tab.ownerRef(frame);
      const outer = await tab.agent('locate', { ref: owner, scroll: false }, frame.parent);
      if (outer?.error === 'stale') throw stale(ref);
      noteName(outer);
      x += outer.content.x;
      y += outer.content.y;
      sessionId = frame.parent;
    }
    const out = { x, y, tag: loc.tag, name: typeof loc.name === 'string' ? loc.name : '' };
    return hit || !scroll ? { ...out, w: loc.w, h: loc.h, cover: loc.cover ?? null } : out;
  }

  /**
   * A point from the model or a ref, checked against the viewport (fails closed outside it).
   * @param tab
   * @param st the viewport ({w, h})
   * @returns {Promise<PagePoint>}
   * @this {BrowserTabs}
   */
  async point(tab, st, /** @type {{ coordinate?: unknown, ref?: string | null }} */ { coordinate, ref }) {
    let x;
    let y;
    let name = '';
    if (ref) ({ x, y, name } = await this.locate(tab, ref));
    else if (Array.isArray(coordinate) && coordinate.length === 2 && coordinate.every((n) => Number.isFinite(Number(n))))
      [x, y] = coordinate.map(Number);
    else throw new ToolError('Give a coordinate [x, y] or a ref.', 'bad_args');
    if (x < 0 || y < 0 || x >= st.w || y >= st.h)
      throw new ToolError(
        `(${Math.round(x)}, ${Math.round(y)}) is outside the ${st.w}x${st.h} viewport. Scroll first, or take a new screenshot.`,
        'outside_viewport',
      );
    return name ? { x, y, name } : { x, y };
  }

  /**
   * What an action would act on (pageAgent intent): the element a ref names, the one at a point, or
   * the focused one. A point or the focus inside a cross-origin frame is followed into that frame (its
   * own process's session, or an isolated world of it through its parent's session when it shares the
   * parent's process), frame by frame, so the element itself is judged (CM-J08). Null when unknown; a
   * frame that can't be read is UNREADABLE_FRAME, which every sensitive check treats as unknown and asks; inside a bot
   * check's frame the answer carries `botCheck` (botCheck.cjs), even when nothing in the frame could be read.
   * `session` is the frame a point is in (the top frame by default; a CDP input event sent to a frame's session).
   * @param {Tab} tab
   * @this {BrowserTabs}
   */
  async intent(
    tab,
    /** @type {{ ref?: string | null, point?: PagePoint | null, session?: string }} */ { ref = null, point = null, session = '' } = {},
  ) {
    // input sent to a frame session the tab doesn't know lands somewhere nothing can read
    if (session && !tab.frames.has(session)) return UNREADABLE_FRAME;
    let first;
    try {
      if (ref) return await tab.agent('intent', { ref }, tab.frameOf(ref));
      first = await tab.agent('intent', point ? { x: point.x, y: point.y } : {}, session);
    } catch {
      return null;
    }
    let r = first;
    /** where the last answer came from: a session's frame, or a frame in that session's process (tab.childFrame) */
    let place = { sessionId: session };
    // a bot check's frame (botCheck.cjs) stays one whatever is read, or not, inside it
    let bot = false;
    const out = (/** @type {any} */ v) => (bot ? { ...v, botCheck: true } : v);
    for (let hop = 0; r?.frame; hop++) {
      bot ||= !!r.botCheck;
      if (!r.owner || hop >= MAX_FRAME_HOPS) return out(UNREADABLE_FRAME);
      try {
        place = await tab.childFrame(place, r.owner);
        r = await tab.agentAt(place, 'intent', point ? { x: r.x, y: r.y } : {});
      } catch (error) {
        // a frame that went away or can't be read: unknown, and a sensitive check asks
        noteIgnored('read what an action acts on inside a frame', error);
        return out(UNREADABLE_FRAME);
      }
    }
    return out(r);
  }

  /** @this {BrowserTabs} */
  async formInput(tab, ref, value) {
    const sessionId = tab.frameOf(ref);
    const r = await tab.agent('formInput', { ref, value }, sessionId);
    if (r?.error === 'stale') throw stale(ref);
    if (r?.error) throw new ToolError(r.error, 'bad_args');
    return r;
  }

  /** @this {BrowserTabs} */
  async scrollTo(tab, ref) {
    const r = await tab.agent('scrollTo', { ref }, tab.frameOf(ref));
    if (r?.error === 'stale') throw stale(ref);
  }

  /** @this {BrowserTabs} */
  async pageText(tab, maxChars) {
    return tab.agent('text', { maxChars });
  }

  /** The text the page hides from people (hiddenText.cjs), for G3's injection screen; null when it doesn't say. @this {BrowserTabs} */
  async hiddenText(tab) {
    return readHidden(tab);
  }

  /* -- locators (browser_script) -------------------------------------- */

  /**
   * Resolves locator steps (pageAgent query) from the top frame, following frame steps into
   * cross-origin frames: { sessionId, refs, count, desc }. A frame that hasn't attached yet matches
   * nothing (the caller waits); a bad selector throws bad_args, an ambiguous frame strict.
   * @this {BrowserTabs}
   */
  async query(tab, steps, { limit = 1000 } = {}) {
    let sessionId = steps[0]?.k === 'ref' ? tab.frameOf(steps[0].ref) : '';
    let rest = steps;
    for (;;) {
      const out = await tab.agent('query', { steps: rest, limit }, sessionId);
      if (out?.error) throw new ToolError(out.error, out.strict ? 'strict' : 'bad_args');
      if (!out.hop) {
        for (const ref of out.refs) tab.noteRef(ref, sessionId);
        return { sessionId, refs: out.refs, count: out.count, desc: out.desc };
      }
      tab.noteRef(out.hop, sessionId);
      const frame = await frameByOwner(this, tab, sessionId, out.hop);
      if (!frame) return { sessionId, refs: [], count: 0, desc: [] };
      sessionId = frame.sessionId;
      rest = out.rest;
    }
  }

  /**
   * Properties of refs from one query (pageAgent inspect): one value per ref, null for a stale one.
   * @this {BrowserTabs}
   */
  async inspect(tab, sessionId, refs, what, name) {
    return tab.agent('inspect', { refs, what, name }, sessionId);
  }

  /** @this {BrowserTabs} */
  async focus(tab, ref) {
    const r = await tab.agent('focus', { ref }, tab.frameOf(ref));
    if (r?.error) throw stale(ref);
  }

  /**
   * selectOption on a native select; returns the selected values.
   * @this {BrowserTabs}
   */
  async selectOptions(tab, ref, wants) {
    const r = await tab.agent('select', { ref, wants }, tab.frameOf(ref));
    if (r?.error === 'stale') throw stale(ref);
    if (r?.error) throw new ToolError(r.error, 'bad_args');
    return r.values;
  }

  /**
   * Waits until the page reaches a load state: 'domcontentloaded' (DOM parsed), 'load' (done loading)
   * or 'networkidle' (also no request for 500 ms). Throws timeout after `timeoutMs`.
   * @this {BrowserTabs}
   */

  /**
   * Runs model-written JavaScript in the page's own world; the last expression's value comes back (pageExec.cjs).
   * @this {BrowserTabs}
   */
  async exec(tab, text) {
    return execIn(tab, text);
  }

  /**
   * Runs JavaScript in the page's own world with side effects refused by V8 (pageExec.cjs), for a routine's replay.
   * @this {BrowserTabs}
   */
  async peek(tab, text) {
    return peekIn(tab, text);
  }

  /**
   * Answers the tab's dialog. `expect`: the page dialog the caller's approval was about (its `own` id, null for none),
   * when it waited on a card: the answer goes to no other dialog (the user may have answered that one in the pane and
   * the page opened another meanwhile).
   * @this {BrowserTabs}
   */
  async handleDialog(tab, accept, promptText, /** @type {number | null | undefined} */ expect = undefined) {
    if (expect !== undefined && (tab.dialog?.own ?? null) !== expect)
      throw new ToolError(
        `The dialog in ${tab.id} changed while the user was being asked: look at browser_state again before answering it.`,
        'dialog_changed',
      );
    if (tab.dialog?.own != null) {
      // the page's own dialog (pageDialogs.cjs): the user may have answered it in the pane first
      const d = tab.dialog;
      const answered = this.o.dialogs?.answer(tab.backend, d.own, !!accept, promptText ?? null, 'agent');
      tab.dialog = null;
      if (!answered) return `The ${d.type} dialog "${oneLine(d.message, 200)}" had already closed.`;
      await this.settle(tab);
      return `${accept ? 'Accepted' : 'Dismissed'} the ${d.type} dialog "${oneLine(d.message, 200)}"${d.type === 'prompt' && accept ? ` with "${oneLine(promptText ?? d.defaultPrompt, 120)}"` : ''}.`;
    }
    if (tab.dialog) {
      const d = tab.dialog;
      try {
        await tab.send('Page.handleJavaScriptDialog', {
          accept: !!accept,
          ...(promptText != null ? { promptText: String(promptText) } : {}),
        });
      } catch (e) {
        if (!/no dialog/i.test(String(e?.message))) throw e;
        tab.dialog = null;
        return `The ${d.type} dialog "${oneLine(d.message, 200)}" had already closed.`;
      }
      tab.dialog = null;
      await this.settle(tab);
      return `${accept ? 'Accepted' : 'Dismissed'} the ${d.type} dialog "${oneLine(d.message, 200)}".`;
    }
    if (tab.fileChooser && !accept) {
      tab.fileChooser = null;
      return 'Cancelled the file chooser.';
    }
    throw new ToolError(`No dialog is open in ${tab.id}.`, 'bad_args');
  }

  /**
   * Sets files on a file input (a ref, or the chooser the page opened). `files` are already checked.
   * @this {BrowserTabs}
   */
  async setFiles(tab, ref, files) {
    if (ref) {
      const sessionId = tab.frameOf(ref);
      const contextId = await tab.agent('state', {}, sessionId).then(() => (sessionId ? tab.frames.get(sessionId).world : tab.world));
      const r = await tab.send(
        'Runtime.evaluate',
        {
          expression: `globalThis.__mopilotAgent.element(${JSON.stringify(ref)}${tab.refHints.arg([ref], sessionId)})`,
          contextId,
          returnByValue: false,
        },
        sessionId,
      );
      const objectId = r?.result?.objectId;
      if (!objectId) throw stale(ref);
      await tab.send('DOM.setFileInputFiles', { files, objectId }, sessionId);
    } else if (tab.fileChooser?.backendNodeId != null) {
      await tab.send('DOM.setFileInputFiles', { files, backendNodeId: tab.fileChooser.backendNodeId }, tab.fileChooser.frameSession);
    } else throw new ToolError('Name the file input with a ref (no file chooser is open).', 'bad_args');
    tab.fileChooser = null;
  }

  /**
   * Emulates a device (devices.cjs): a preset ('mobile', 'tablet') or a size; 'desktop' ends it. The
   * size is the one CDP command that must work; touch and the user agent are best effort. The pane
   * shows the active device (agentTabs.cjs).
   * @this {BrowserTabs}
   */
  async resize(tab, { width, height, preset }) {
    const ua = tab.backend.getUserAgent();
    if (preset === 'desktop') {
      const [size, ...rest] = resetCommands(ua);
      await tab.send(...size);
      for (const c of rest)
        await tab.send(...c).catch((error) => {
          // touch emulation is optional; the size reset already applied
          noteIgnored('reset touch emulation and the user agent', error);
        });
      const was = tab.emulated;
      tab.emulated = null;
      holdNativeScale(tab.backend, false);
      if (was) this.emit(tab.chatId);
      return "Cleared the device emulation: the page has the pane's own size, pixel ratio, input and user agent again.";
    }
    const d = deviceOf({ width, height, preset });
    if (!d) throw new ToolError('Give width and height between 200 and 4000, or a preset (mobile, tablet, desktop).', 'bad_args');
    const [size, ...rest] = emulationCommands(d, ua);
    await tab.send(...size);
    for (const c of rest)
      await tab.send(...c).catch((error) => {
        // touch emulation is optional; the size already applied
        noteIgnored('emulate touch and the user agent of a device', error);
      });
    tab.emulated = { preset: d.preset, w: d.width, h: d.height, dpr: d.dpr, mobile: d.mobile, touch: d.touch };
    holdNativeScale(tab.backend, true);
    this.emit(tab.chatId);
    if (d.preset)
      return `Emulating a ${d.preset} device: ${d.width}x${d.height} at ${d.dpr}x, touch and a ${d.preset === 'tablet' ? 'tablet' : 'phone'} user agent. Reload the page so it re-checks the device.`;
    return `Emulating a ${d.width}x${d.height} viewport${d.mobile ? ' (mobile: touch and a phone user agent). Reload the page so it re-checks the device' : ''}.`;
  }

  /** @this {BrowserTabs} */
  console(tab, { onlyErrors = false, pattern = null, limit = 100 } = {}) {
    let list = tab.console;
    if (onlyErrors) list = list.filter((e) => e.level === 'error');
    if (pattern) list = list.filter((e) => e.text.toLowerCase().includes(String(pattern).toLowerCase()));
    return list.slice(-Math.max(1, Math.min(BUFFER_MAX, limit)));
  }

  /** @this {BrowserTabs} */
  requests(tab, { urlPattern = null, limit = 100 } = {}) {
    let list = tab.netOrder.map((id) => tab.network.get(id)).filter(Boolean);
    if (urlPattern) list = list.filter((r) => r.url.includes(String(urlPattern)));
    return list.slice(-Math.max(1, Math.min(BUFFER_MAX, limit)));
  }

  /** @this {BrowserTabs} */
  async responseBody(tab, requestId) {
    const r = [...tab.network.values()].find((n) => n.id === requestId);
    if (!r) throw new ToolError(`No request ${oneLine(requestId, 80)} in this tab's log.`, 'bad_args');
    const body = await tab.send('Network.getResponseBody', { requestId }, r.sessionId);
    return { request: r, body: body.base64Encoded ? `(binary, ${Math.round((body.body.length * 3) / 4)} bytes)` : body.body };
  }
}

/** @param {BrowserTabs} host */
async function frameByOwner(host, tab, parentSession, ownerRef) {
  for (const f of tab.frames.values()) {
    if (f.parent !== parentSession) continue;
    try {
      if ((await tab.ownerRef(f)) === ownerRef) return f;
    } catch (error) {
      // a frame that went away is skipped
      noteIgnored('match a frame to its owner element', error);
    }
  }
  return null;
}

module.exports = { HostPage };
