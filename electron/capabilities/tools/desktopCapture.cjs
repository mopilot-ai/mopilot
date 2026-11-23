// The desktop tools' screenshots and batches: capture of the granted apps' windows sized for the model, zoom, and desktop_batch.
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { MAX_BATCH, ACTIONS } = require('./desktopSpecs.cjs');
const { indexElements, elementLine, sleep } = require('./desktopUtil.cjs');
const { forModel } = require('./desktopVision.cjs');
const { DesktopActions } = require('./desktopActions.cjs');
const { helperError } = require('./computer.cjs');
const { handedBack } = require('./takeoverWait.cjs');

/** @typedef {InstanceType<typeof import('./desktop.cjs').DesktopControl>} DesktopControl the control these methods run on */
/** What the vision consent card names when no granted app is in front. */
const NO_APP = { bundleId: '', name: 'the granted apps' };

class DesktopCapture extends DesktopActions {
  /**
   * A capture of the granted apps' windows. The helper retries a transient ScreenCaptureKit failure and
   * waits briefly for a window that is still opening; what fails anyway is told to the model as advice.
   * @this {DesktopControl}
   */
  async capture(g, opts) {
    try {
      return await this.helper.screenshot(opts);
    } catch (e) {
      if (e?.reason !== 'no_windows') throw e;
      const names = [...g.granted.values()].filter((a) => opts.includeBundleIds.includes(a.bundleId)).map((a) => a.name);
      throw new ToolError(
        `Nothing to capture: none of the granted apps (${names.join(', ')}) has a window on screen; it may still be opening, be hidden, or be on another Space. Bring one forward with desktop_open_application (or open a window in it), then take the screenshot again.`,
        'unavailable',
      );
    }
  }

  /**
   * The size limits for the chat's model (the helper caps them too), times `scale`.
   * @param {string} chatId
   * @param {number} [scale]
   * @this {DesktopControl}
   */
  async limits(chatId, scale) {
    /** @type {string | null} */
    let model = null;
    try {
      model = await this.modelOf(chatId);
    } catch (error) {
      // unknown model: default screenshot limits
      noteIgnored("look up the chat's model for screenshot limits", error);
    }
    return P.screenshotLimits(model, scale);
  }

  /**
   * The granted apps' windows on the chat's display, sized for the chat's model, with the frontmost granted app's elements.
   * @this {DesktopControl}
   */
  async screenshot(chatId, s, args = {}, ctx = undefined) {
    const helper = this.helper;
    const g = await this.gate(chatId, 'screenshot', {}, null);
    const ids = g.allowed;
    const lim = await this.limits(chatId, args.scale);
    let shot = await this.capture(g, {
      includeBundleIds: ids,
      ...(s.display != null ? { display: s.display } : {}),
      maxSide: lim.maxSide,
      maxPixels: lim.maxPixels,
      format: 'jpeg',
      quality: 0.75,
    });
    let note = '';
    if (!Array.isArray(shot?.included)) {
      // an older helper: the frontmost granted app's own windows only (a failed lookup is the helper's error)
      const front = await helper.targetInfo();
      const fg = front?.bundleId ? g.granted.get(front.bundleId.toLowerCase()) : null;
      if (!fg || !front.pid)
        throw new ToolError('Bring a granted app forward with desktop_open_application, then take the screenshot', 'denied');
      shot = { ...(await helper.screenshot({ pid: front.pid, bundleIds: [fg.bundleId], maxSide: lim.maxSide })), shown: [fg.bundleId] };
      note = ' (only the frontmost app; update the helper to see every granted app)';
    }
    const d = shot.display || { x: 0, y: 0, id: null };
    // the display this shot is of (a zoom stays on it); later shots follow the granted apps unless desktop_switch_display picked one
    s.geom = { x: d.x || 0, y: d.y || 0, ppp: shot.pixelsPerPoint || 1, width: shot.width, height: shot.height, display: d.id ?? null };
    s.elements = [];
    let frontLine = 'No granted app is in front.';
    const front = await helper.targetInfo().catch((error) => {
      frontLine = `Couldn't tell which app is in front (${messageOf(error)}).`;
      return null;
    });
    const fg = front?.bundleId ? g.granted.get(front.bundleId.toLowerCase()) : null;
    // the apps with a window in the image (a helper before `shown` only says which have one on any display)
    const shown = (Array.isArray(shot.shown) ? shot.shown : shot.included).map((id) => g.granted.get(String(id).toLowerCase())?.name || id);
    // the app keys go to when another app is in front: the frontmost granted one, else the only one shown
    const only = (shot.included || []).length === 1 ? g.granted.get(String(shot.included[0]).toLowerCase()) : null;
    if (fg || only) s.lastApp = (fg || only).bundleId;
    if (fg && front.pid) {
      frontLine = `Frontmost: ${fg.name} (tier ${fg.tier}).`;
      const snap = await helper.axSnapshot({ pid: front.pid, bundleIds: [fg.bundleId] }).catch((error) => {
        frontLine += ` Its elements couldn't be read (${messageOf(error)}); act by coordinate.`;
        return null;
      });
      if (snap) s.elements = indexElements(snap, s.geom, { pid: front.pid, bundleId: fg.bundleId, name: fg.name });
    } else if (front?.name) {
      const next = s.lastApp ? g.granted.get(s.lastApp.toLowerCase()) : null;
      frontLine = `${front.name} is in front and isn't granted; ${next ? `input brings ${next.name} forward first` : 'bring a granted app forward with desktop_open_application before keys or typing'}.`;
    }
    const lines = [
      `Screenshot ${shot.width}x${shot.height} of display ${d.id ?? ''} (${Math.round(d.width || 0)}x${Math.round(d.height || 0)} points)${note}. Coordinates for desktop tools are pixels of this image.`,
      shown.length
        ? `Shows only: ${shown.join(', ')}. Everything else is left out.`
        : `No granted app has a window on this display, so the image is empty.${s.display != null ? ' desktop_switch_display picked it; call desktop_switch_display to pick the display the app is on.' : ''}`,
      frontLine,
    ];
    if (s.elements.length) lines.push(`Elements (use element_index):\n${s.elements.map(elementLine).join('\n')}`);
    return this.forModel(
      chatId,
      g,
      fg || NO_APP,
      s,
      shot,
      {
        record: P.actionRecord('screenshot', 'confirmed', 'global'),
        content: [
          { type: 'image', data: shot.jpeg || shot.png, mimeType: shot.mimeType || (shot.jpeg ? 'image/jpeg' : 'image/png') },
          { type: 'text', text: lines.join('\n') },
        ],
      },
      { find: args.find, ctx },
    );
  }

  /**
   * A small JPEG for a paired phone's mirror: the same capture the model's screenshot takes (only the chat's granted
   * apps' windows, on its display; MoPilot and the deny list are never in it), without reading elements or
   * changing the session. Null when there is nothing to show (no grant, no window).
   * @param {string} chatId
   * @param {number} [maxSide] the long edge, in pixels
   * @this {DesktopControl}
   */
  async frame(chatId, maxSide = 640) {
    try {
      const g = await this.gate(chatId, 'screenshot', {}, null);
      const display = this.sessions.get(chatId)?.display;
      const shot = await this.capture(g, {
        includeBundleIds: g.allowed,
        ...(display != null ? { display } : {}),
        maxSide,
        maxPixels: maxSide * maxSide,
        format: 'jpeg',
        quality: 0.5,
      });
      return shot?.jpeg ? { data: shot.jpeg, width: shot.width, height: shot.height } : null;
    } catch (error) {
      if (error instanceof ToolError) return null;
      throw error;
    }
  }

  /**
   * A capture as the chat's model takes it (desktopVision.cjs): unchanged for a model that sees images.
   * @this {DesktopControl}
   */
  forModel(chatId, g, app, s, shot, out, extra) {
    return forModel({
      cu: this.cu,
      chatId,
      app,
      out,
      size: shot,
      geom: s.geom,
      elements: s.elements,
      // the frontmost app's text, as its elements are listed
      ocr: () => this.helper.call('ocr.elements', { bundleIds: g.allowed }, { timeoutMs: 60000 }),
      reveal: () => this.revealHost(),
      ...extra,
    });
  }

  /** @this {DesktopControl} */
  async zoom(chatId, s, args, ctx = undefined) {
    const r = args.region;
    if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && Number.isFinite(n)))
      throw new ToolError('region must be [x0, y0, x1, y1]', 'bad_args');
    if (!s.geom) throw new ToolError('Take a desktop_screenshot first: region is in pixels of the latest screenshot', 'bad_args');
    const g = await this.gate(chatId, 'zoom', {}, null);
    const [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    if (x1 - x0 < 2 || y1 - y0 < 2) throw new ToolError('The region is too small', 'bad_args');
    const a = P.toPoints(s.geom, { x: x0, y: y0 });
    const b = P.toPoints(s.geom, { x: x1, y: y1 });
    const lim = await this.limits(chatId, args.scale);
    const shot = await this.capture(g, {
      includeBundleIds: g.allowed,
      display: s.geom.display ?? undefined,
      region: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
      maxSide: lim.zoomSide,
      format: 'jpeg',
      quality: 0.85,
    });
    if (!Array.isArray(shot?.included)) throw new ToolError('Zoom needs an updated computer-use helper', 'unavailable');
    const region = [x0, y0, x1, y1];
    const inRegion = s.elements.filter((e) => e.center.x >= x0 && e.center.y >= y0 && e.center.x <= x1 && e.center.y <= y1);
    return this.forModel(
      chatId,
      g,
      NO_APP,
      s,
      shot,
      {
        record: P.actionRecord('zoom', 'confirmed', 'global'),
        content: [
          { type: 'image', data: shot.jpeg || shot.png, mimeType: shot.mimeType || 'image/jpeg' },
          {
            type: 'text',
            text: `Zoomed view of [${x0}, ${y0}, ${x1}, ${y1}] at ${shot.width}x${shot.height}. Its pixels are not coordinates; keep using the screenshot's.`,
          },
        ],
      },
      { region, elementLines: inRegion.map(elementLine), ctx },
    );
  }

  /**
   * Before a batch's closing screenshot: the helper waits until the windows on screen and the focused
   * element stop changing (up to settleMs) instead of a fixed wait; an older helper gets the fixed wait.
   * @this {DesktopControl}
   */
  async settle() {
    if (this.screenSettle) {
      try {
        await this.helper.call('screen.settle', { capMs: this.settleMs }, { timeoutMs: this.settleMs + 5000 });
        return;
      } catch (e) {
        if (e?.reason === 'method_not_found') this.screenSettle = false;
      }
    }
    await sleep(this.settleMs);
  }

  /**
   * Element `index` of the latest screenshot, read again from its app after actions[`after`] of a batch may have
   * changed the UI: its frame now, or a refusal when its id names another element or none (ids are child-index
   * paths, so the same id can name another control once the UI changed).
   * @param {ReturnType<DesktopControl['session']>} s
   * @param {number} index
   * @param {number} after
   * @this {DesktopControl}
   */
  async refreshElement(s, index, after) {
    const el = this.elementOf(s, index);
    const snap = await this.helper.axSnapshot({ pid: el.pid, bundleIds: [el.bundleId] }).catch((e) => {
      throw helperError(e);
    });
    /** @type {any} */
    let node = null;
    const find = (n) => {
      if (!n || typeof n !== 'object' || node) return;
      if (n.id === el.id) node = n;
      else for (const k of Array.isArray(n.children) ? n.children : []) find(k);
    };
    find(snap?.root);
    const f = node?.frame;
    const now = f?.w > 0 && f?.h > 0 ? P.identityOf(node) : null;
    if (!now || !P.sameIdentity(now, el.expect)) {
      const name = now?.title || now?.description;
      throw new ToolError(
        `Element [${index}] changed after actions[${after}] (${now ? `it is now ${now.role.replace(/^AX/, '') || 'an element'}${name ? ` "${name.slice(0, 80)}"` : ''}` : 'it is gone or has no size'}), so nothing was done. Take a new desktop_screenshot and pick the element again.`,
        'changed',
      );
    }
    s.elements[index - 1] = { ...el, frame: f, center: P.toPixels(s.geom, { x: f.x + f.w / 2, y: f.y + f.h / 2 }) };
  }

  /**
   * desktop_batch: in order, each action checked like its own tool; stops at the first failure; ends with one screenshot.
   * @this {DesktopControl}
   */
  async batch(chatId, args, ctx, opts = {}) {
    const list = Array.isArray(args.actions) ? args.actions : [];
    if (!list.length) throw new ToolError('actions is empty', 'bad_args');
    if (list.length > MAX_BATCH) throw new ToolError(`At most ${MAX_BATCH} actions per batch`, 'bad_args');
    for (const [i, a] of list.entries()) {
      if (!a || typeof a !== 'object' || !ACTIONS.includes(a.action))
        throw new ToolError(`actions[${i}].action must be one of: ${ACTIONS.join(', ')}`, 'bad_args');
    }
    if (list.some((a) => P.INPUT.has(a.action))) await this.preflight(chatId, ctx);
    const s = this.session(chatId);
    const epoch = s.epoch;
    const results = [];
    const images = [];
    /** @type {{ index: number, record: object } | null} */
    let failed = null;
    /** the latest action of the batch that may have changed the UI, or null */
    /** @type {number | null} */
    let changedBy = null;
    for (const [i, a] of list.entries()) {
      if (s.epoch !== epoch || ctx.signal?.aborted) {
        failed = { index: i, record: P.actionRecord(a.action, 'refused', 'global', { reason: 'stopped by the user' }) };
        break;
      }
      // a screenshot inside the batch is the one at the end
      if (a.action === 'screenshot') {
        results.push(P.actionRecord('screenshot', 'confirmed', 'global', { note: 'taken at the end of the batch' }));
        continue;
      }
      try {
        // the elements are the screenshot's from before the batch: after an action that may have changed the UI, look again
        const after = changedBy;
        // the user took over after earlier steps ran: the rest of the plan may not fit what they leave (#1905)
        if (i > 0 && P.INPUT.has(a.action) && (await this.cu.takeover.wait(chatId, ctx.signal))) throw handedBack('the mouse and keyboard');
        if (after !== null && typeof a.element_index === 'number') await this.serial(() => this.refreshElement(s, a.element_index, after));
        const out = await (a.action === 'wait' || P.INPUT.has(a.action)
          ? this.act(chatId, a.action, a, ctx)
          : this.serial(() => this.act(chatId, a.action, a, ctx)));
        results.push(out.record);
        if (P.INPUT.has(a.action)) changedBy = i;
        if (a.action === 'zoom' && out.content) images.push(...out.content);
      } catch (e) {
        if (e instanceof ToolError && e.code === 'permission') throw e;
        failed = { index: i, record: e.record || P.actionRecord(a.action, 'refused', 'global', { reason: String(e?.message ?? e) }) };
        break;
      }
    }
    if (failed) results.push(failed.record);
    const summary = {
      completed: failed ? failed.index : list.length,
      of: list.length,
      results,
      ...(failed ? { stoppedAt: failed.index } : {}),
    };
    const content = [{ type: 'text', text: JSON.stringify(summary, null, 1) }, ...images];
    if (opts.screenshot !== false && s.epoch === epoch && !ctx.signal?.aborted) {
      if (this.settleMs) await this.settle();
      try {
        const shot = await this.serial(() => this.screenshot(chatId, s, {}, ctx));
        content.push(...shot.content);
      } catch (e) {
        content.push({ type: 'text', text: `No screenshot after the batch: ${e?.message ?? e}` });
      }
    }
    return content;
  }
}

module.exports = { DesktopCapture };
