// The background desktop_app_* tools' input actions: targets, confirmation, the checks before an action and the helper request it becomes.
const { ToolError } = require('../contract/registry.cjs');
const { irreversible } = require('../contract/policy.cjs');
const P = require('../contract/desktopPolicy.cjs');
const callPhases = require('../contract/callPhases.cjs');
const { MAX_TEXT } = require('./appScopedSpecs.cjs');
const {
  TEXT_ROLES,
  MENU_ROLES,
  elementAt,
  normalizeAppKey,
  keyVerdict,
  appHelperError,
  observedEffect,
  withHint,
  NEEDS,
  contextMenuRefusal,
  menuControlRefusal,
  isCoord,
  center,
  stillActing,
  assertTypeText,
  whyNotHid,
} = require('./appScopedUtil.cjs');
const { AppScopedCapture } = require('./appScopedCapture.cjs');
const { withCursor, signClick, firstPlan, foregroundRefused } = require('./appScopedApproach.cjs');
const { mayForeground, needsEscalation, foregroundWorked, windowStateRefusal, foregroundNote, laddered } = require('./appScopedLadder.cjs');

/** @typedef {InstanceType<typeof import('./appScoped.cjs').AppScopedControl>} AppScopedControl the control these methods run on */

/**
 * An element as a helper request names it: its id and what the screenshot showed of it (element_changed when it is another now).
 * @param {{ id: string, expect: object }} el
 */
const elementRef = (el) => ({ id: el.id, expectElement: el.expect });

class AppScopedActions extends AppScopedCapture {
  /* -- targets ---------------------------------------------------- */

  /**
   * Where an action goes: {el, point (global points), focused}. coordinate, element_index and target are
   * mutually exclusive; with none, the point of the last action in this window.
   * @this {AppScopedControl}
   */
  target(c, args, w) {
    const given = ['coordinate', 'element_index', 'target'].filter((k) => args[k] !== undefined && args[k] !== null);
    if (given.length > 1) throw new ToolError(`Give one of coordinate, element_index and target, not ${given.join(' and ')}`, 'bad_args');
    if (args.target === 'focused') return { el: null, point: null, focused: true };
    if (args.target !== undefined && args.target !== null) throw new ToolError('target must be "focused"', 'bad_args');
    if (!w)
      throw new ToolError(
        `Take a desktop_app_screenshot of ${c.app.name} first: coordinates and element indexes are of the latest screenshot`,
        'bad_args',
      );
    if (typeof args.element_index === 'number') {
      const el = w.elements[args.element_index - 1];
      if (!el)
        throw new ToolError(
          `No element [${args.element_index}] in the latest screenshot of this window; take a new desktop_app_screenshot`,
          'bad_args',
        );
      return { el, point: center(el), focused: false };
    }
    if (args.coordinate !== undefined) {
      if (!isCoord(args.coordinate)) throw new ToolError('coordinate must be [x, y]', 'bad_args');
      const [x, y] = args.coordinate;
      if (x < 0 || y < 0 || x >= w.geom.width || y >= w.geom.height)
        throw new ToolError(`coordinate (${x}, ${y}) is outside the ${w.geom.width}x${w.geom.height} window frame`, 'bad_args');
      const point = P.toPoints(w.geom, { x, y });
      return { el: elementAt(w.elements, point), point, focused: false };
    }
    if (w.last) return { ...w.last };
    throw new ToolError('Give coordinate, element_index or target: "focused"', 'bad_args');
  }

  /**
   * What an action would do that can't be undone ({verb, summary, key}), as the desktop_* tools judge it; or null.
   * @this {AppScopedControl}
   */
  consequence(c, action, args, t, combo) {
    const app = { bundleId: c.app.bundleId, name: c.app.name };
    const flag = { irreversible: args.irreversible === true, summary: args.action_summary || action };
    let irr;
    if (action === 'click')
      irr = irreversible('computer_click', flag, { app, element: t.el ? { role: t.el.role, title: t.el.label } : null });
    else if (action === 'key') irr = irreversible('computer_key', { ...flag, key: combo }, { app });
    else if (action === 'type') irr = irreversible('computer_type', { ...flag, text: String(args.text ?? '') }, { app });
    else if (action === 'menu')
      irr = irreversible('computer_click', flag, { app, element: { role: 'AXMenuItem', title: args.path.slice(-1)[0] } });
    else irr = irreversible('computer_act', flag, { app });
    return irr ? { ...irr, key: `${app.bundleId}\u0000${irr.verb}\u0000${irr.summary}` } : null;
  }

  /**
   * The user confirms an action that can't be undone; nobody there refuses it and pauses the chat.
   * @this {AppScopedControl}
   */
  async confirm(c, action, irr) {
    const app = { bundleId: c.app.bundleId, name: c.app.name };
    const unattended = await this.cu.unattended(c.chatId, c.ctx);
    if (unattended) {
      const message = `This would ${irr.verb} in ${app.name}, which can't be undone, and nobody is here to confirm it (${unattended}). MoPilot paused this chat and asked the user; don't retry.`;
      this.cu.onUnattended(c.chatId, { app, code: 'unattended', message, need: null, tool: `desktop_app_${action}` });
      throw new ToolError(message, 'unattended');
    }
    // with hide-before-action MoPilot's windows may be hidden: the card has to be seen
    this.desktop.revealHost();
    const answer = await this.broker.ask(
      c.chatId,
      'computerConfirm',
      { harness: this.cu.harness(c.chatId), app, verb: irr.verb, summary: irr.summary, tool: `desktop_app_${action}` },
      { signal: c.ctx?.signal },
    );
    if (answer?.decision !== 'allow') throw new ToolError(`The user didn't confirm: ${irr.verb} in ${app.name}`, 'denied');
  }

  /* -- actions ---------------------------------------------------- */

  /** One observe or input action (a tool of its own, or an item of a batch): {record, content?}. @this {AppScopedControl} */
  async act(c, action, args) {
    if (action === 'screenshot') return this.screenshot(c, args);
    if (action === 'zoom') return this.zoom(c, args);
    if (action === 'ax_find') return this.axFind(c, args);
    const r = this.resolve(c, action, args);
    await this.preflight(c);
    if (r.irr) await this.confirm(c, action, r.irr);
    const p = await this.ready(c, action, args, r);
    return withCursor(this, c, action, r, () => this.climb(c, action, args, r, p));
  }

  /**
   * The escalation ladder around one input action. Accessibility and events to the app's process come first (the planned request; a coordinate click of an app in front goes
   * straight to the real pointer, firstPlan); when the helper saw nothing change (no_change, ineffective) for a click, typing or a key, and the user allows brief switching for an
   * app granted full control, the action runs once more with the app briefly in front (the helper restores the previous app and pointer). The rung that worked is remembered per
   * app and the next such action starts there. A window that is minimized or hidden with its app is brought back to the current desktop and the action goes on; one on another Space
   * takes the brief-foreground rung (macOS switches to its Space and back). If the helper refuses the real pointer for the first request (the user is at the mouse), the plain click is tried. The record says which rung did it.
   * @this {AppScopedControl}
   */
  async climb(c, action, args, r, p) {
    const thumb = this.thumbDue(c);
    const fgOk = mayForeground(this.ladder, c.app, action);
    const up = () => this.request(c, signClick(c, this.foregroundPlan(c, action, args, r, thumb)));
    if (fgOk && this.ladder.rung(c.app.bundleId, action) === 'foreground') {
      const out = await up();
      return { record: laddered(out.record, 'foreground', { note: foregroundNote(c.app.name, action, out.fg), fg: out.fg }) };
    }
    let out;
    try {
      out = await this.request(c, signClick(c, firstPlan(p, thumb, fgOk)));
    } catch (e) {
      const state = windowStateRefusal(appHelperError(e));
      if (state) return this.offWindow(c, action, args, r, p, state, e, thumb);
      if (!foregroundRefused(e)) throw e;
      out = await this.request(c, signClick(c, { ...p, params: { ...p.params, ...thumb } }));
    }
    if (!fgOk) return out;
    if (out.fg || !needsEscalation(out.record)) return { record: laddered(out.record, out.fg ? 'foreground' : 'background', out) };
    let next;
    try {
      next = await up();
    } catch (e) {
      return {
        record: laddered(out.record, 'background', { note: `Brief foreground was not used: ${appHelperError(e).message}` }),
      };
    }
    if (!foregroundWorked(next.record))
      return {
        record: laddered(next.record, 'foreground', {
          from: out.record.effect,
          note: `Brief foreground didn't help either; try another target or desktop_app_menu.`,
          fg: next.fg,
        }),
      };
    this.ladder.remember(c.app, action, 'foreground');
    return {
      record: laddered(next.record, 'foreground', {
        from: out.record.effect,
        note: foregroundNote(c.app.name, action, next.fg),
        fg: next.fg,
      }),
    };
  }

  /**
   * The helper refused posted input because of where the window is: a minimized window or a hidden app
   * comes back to the current desktop (behind the user's window, without focus) and the action goes on;
   * a window on another Space takes the brief-foreground rung when that's allowed, else the refusal stands.
   * @this {AppScopedControl}
   */
  async offWindow(c, action, args, r, p, state, err, thumb) {
    if (state === 'off_space') {
      if (!(P.tierRank(c.app.tier) >= P.tierRank('full') && this.ladder.allowed())) throw err;
      const out = await this.request(c, this.foregroundPlan(c, action, args, r, thumb));
      return {
        record: laddered(out.record, 'foreground', {
          note: `The window was on another Space: ${c.app.name} was brought to the front for this action (macOS showed its Space)${out.fg?.userTookOver ? '' : ', then the previous app was restored'}.`,
          fg: out.fg,
        }),
      };
    }
    stillActing();
    await c.helper.call('app.bringToCurrentSpace', this.base(c, { windowId: r.id }));
    const out = await this.request(c, { ...p, params: { ...p.params, ...thumb } });
    return {
      record: {
        ...out.record,
        window_note: `The window was ${state === 'minimized' ? 'minimized' : 'hidden with its app'}; MoPilot brought it back to the current desktop (behind the user's window) and the action went on.`,
      },
    };
  }

  /**
   * The brief-foreground request for an action: the same plan, with the helper asked to bring the app
   * forward around it; a click goes to its point (a real click in front), typing goes as keystrokes.
   * @this {AppScopedControl}
   */
  foregroundPlan(c, action, args, r, thumb) {
    const q = this.plan(c, action, args, r, true);
    return { ...q, params: { ...q.params, ...thumb } };
  }

  /**
   * Runs a planned request; a result that asks for a follow-up request (an older helper's failed press) runs that too.
   * @this {AppScopedControl}
   */
  async request(c, p) {
    stillActing();
    const out = p.finish(await c.helper.call(p.method, p.params, p.opts));
    return out.next ? this.request(c, out.next) : out;
  }

  /**
   * Everything about an input action that is decided before it runs: the window, the tier, the target,
   * the key, and what it would do that can't be undone. Throws what refuses it.
   * @this {AppScopedControl}
   */
  resolve(c, action, args) {
    const id = this.windowIdOf(c, args);
    const w = id != null ? this.appState(c).windows.get(id) : null;
    let [tier, what] = NEEDS[action];
    if (action === 'click' && (args.button === 'right' || (typeof args.modifiers === 'string' && args.modifiers.trim())))
      [tier, what] = ['full', 'right or modifier clicks'];
    this.need(c, what, tier);
    let t = null;
    /** @type {string | null} */
    let combo = null;
    let points = null;
    if (action === 'drag') points = this.dragPoints(c, args, w);
    else t = this.target(c, args, w);
    if (action === 'key') {
      combo = normalizeAppKey(args.combo);
      const why = keyVerdict(combo);
      if (why) throw new ToolError(why.message, why.code);
    }
    if (action === 'type') assertTypeText(args, MAX_TEXT);
    return { id, w, t, combo, points, irr: this.consequence(c, action, args, t || {}, combo) };
  }

  /**
   * After the checks and the user's OK: waits for an app the user took over, takes the lock, and plans the request.
   * @this {AppScopedControl}
   */
  async ready(c, action, args, r) {
    await this.waitForUser(c);
    this.lock(c.chatId, c.app, r.id ?? 0);
    const p = this.plan(c, action, args, r);
    if (r.w && r.t && !r.t.focused) r.w.last = { el: r.t.el, point: r.t.point, focused: false };
    return p;
  }

  /** @this {AppScopedControl} */
  dragPoints(c, args, w) {
    if (!w)
      throw new ToolError(`Take a desktop_app_screenshot of ${c.app.name} first: drag points are of the latest screenshot`, 'bad_args');
    let px;
    if (Array.isArray(args.path)) {
      if (args.coordinate !== undefined || args.to_coordinate !== undefined)
        throw new ToolError('Give path, or coordinate and to_coordinate, not both', 'bad_args');
      if (args.path.length < 2 || args.path.length > 20) throw new ToolError('path takes 2 to 20 points', 'bad_args');
      px = args.path;
    } else px = [args.coordinate, args.to_coordinate];
    return px.map((p, i) => {
      if (!isCoord(p)) throw new ToolError(`drag point ${i + 1} must be [x, y]`, 'bad_args');
      if (p[0] < 0 || p[1] < 0 || p[0] >= w.geom.width || p[1] >= w.geom.height)
        throw new ToolError(`drag point (${p[0]}, ${p[1]}) is outside the ${w.geom.width}x${w.geom.height} window frame`, 'bad_args');
      const q = P.toPoints(w.geom, { x: p[0], y: p[1] });
      return [q.x, q.y];
    });
  }

  /**
   * Where the element or point is for the helper: an element's id (if any) and the point.
   * @this {AppScopedControl}
   */
  where(t) {
    return { ...(t.el ? elementRef(t.el) : {}), x: t.point.x, y: t.point.y };
  }

  /**
   * The window moved since its screenshot (the helper moved the point with it): its frame and elements move too.
   * @this {AppScopedControl}
   */
  shiftWindow(w, moved) {
    const dx = Number(moved?.dx) || 0;
    const dy = Number(moved?.dy) || 0;
    if (!w || (!dx && !dy)) return false;
    w.geom.x += dx;
    w.geom.y += dy;
    w.bounds.x += dx;
    w.bounds.y += dy;
    for (const e of w.elements) e.frame = { ...e.frame, x: e.frame.x + dx, y: e.frame.y + dy };
    if (w.last?.point) w.last = { ...w.last, point: { x: w.last.point.x + dx, y: w.last.point.y + dy } };
    return true;
  }

  /**
   * The helper request for an input action: {method, params, opts?, finish(result) -> {record} | {next}}.
   * Every request asks the helper to verify its effect (after an adaptive settle); the ones that post
   * events at a point carry the window's bounds as of its screenshot, so the helper can refuse a
   * resized window or move the point with a moved one.
   * @this {AppScopedControl}
   */
  plan(c, action, args, { id, w, t, combo, points }, fg = false) {
    const verify = { verify: true, settleCapMs: this.settleCapMs, ...(fg ? { foreground: true } : {}) };
    const expect = w?.bounds ? { expectBounds: w.bounds } : {};
    const done = (reported, route, extra, res, at) => {
      const seen = observedEffect(reported, res?.verify);
      // inside the helper request's time: how long it waited for the app to settle
      if (seen.settle_ms !== undefined) callPhases.note('in-helper:settle', seen.settle_ms);
      const moved = this.shiftWindow(w, res?.moved);
      const record = withHint(
        P.actionRecord(action, seen.effect, route, {
          app: c.app.name,
          window_id: id,
          ...extra,
          ...(seen.evidence ? { evidence: seen.evidence } : {}),
          ...(seen.settle_ms !== undefined ? { settle_ms: seen.settle_ms } : {}),
          ...(moved ? { note: 'the window had moved since the screenshot; the point moved with it' } : {}),
        }),
      );
      this.report(c, action, w, at, record, res?.thumb);
      return { record, fg: res?.foreground };
    };
    const at = (p) => (typeof p?.x === 'number' && typeof p.y === 'number' ? [{ x: p.x, y: p.y }] : []);
    switch (action) {
      case 'click': {
        if (args.button === 'right') throw contextMenuRefusal();
        if (t.el && MENU_ROLES.has(t.el.role)) throw menuControlRefusal(t.el);
        const count = Math.min(Math.max(Math.round(Number(args.count) || 1), 1), 3);
        const modifiers = typeof args.modifiers === 'string' ? P.normalizeCombo(args.modifiers) : '';
        // the element's name goes in the record, so the thread can say what was clicked
        const named = t.el ? { element: t.el.index, ...(t.el.name ? { label: t.el.name.slice(0, 60) } : {}) } : {};
        const click = (point) => ({
          method: 'app.click',
          params: this.base(c, {
            windowId: id,
            x: point.x,
            y: point.y,
            button: 'left',
            count,
            ...(modifiers ? { modifiers } : {}),
            ...expect,
            ...verify,
          }),
          finish: (res) => done('unverifiable', res?.route === 'hid' ? 'hid' : 'pid', { ...named, ...whyNotHid(res) }, res, at(point)),
        });
        if ((t.focused || t.el?.actions.includes('AXPress')) && count === 1 && !modifiers && !(fg && t.point)) {
          return {
            method: 'app.press',
            // a press that fails clicks at the point instead, in the same request
            params: this.base(c, {
              windowId: id,
              ...(t.focused ? { focused: true } : elementRef(t.el)),
              action: 'AXPress',
              fallbackClick: t.focused ? {} : { x: t.point.x, y: t.point.y },
              ...expect,
              ...verify,
            }),
            finish: (res) => {
              if (res?.ok && res.fallback) return done('unverifiable', 'pid', named, res, at(t.point ?? res.center));
              if (res?.ok) return done('confirmed', 'ax', t.el ? named : { target: 'focused' }, res, at(t.point ?? res.center));
              // an older helper: the click is a request of its own
              if (!t.focused) return { next: click(t.point) };
              if (typeof res?.center?.x !== 'number')
                throw new ToolError(
                  'unsupported(no_press): the focused element has no press action and no position; target it by coordinate or element_index',
                  'unsupported',
                );
              return { next: click(res.center) };
            },
          };
        }
        if (t.focused)
          throw new ToolError('unsupported(focused): target: "focused" takes a single left click without modifiers', 'unsupported');
        return click(t.point);
      }
      case 'type': {
        const text = String(args.text ?? '');
        if (t.el?.secure) throw new ToolError('MoPilot never types into password fields', 'refused');
        if (!t.focused && (!t.el || !TEXT_ROLES.has(t.el.role))) {
          throw new ToolError(
            `unsupported(not_text): ${t.el ? `[${t.el.index}] ${t.el.role.replace(/^AX/, '')}` : 'nothing'} at that point is not a text field, so the text would land wherever keyboard focus is. Target a text field, or use target: "focused" for the app's own text cursor.`,
            'unsupported',
          );
        }
        return {
          method: 'app.setText',
          params: this.base(c, {
            windowId: id,
            ...(t.focused ? { focused: true, allowKeys: true } : elementRef(t.el)),
            text,
            mode: args.mode === 'replace' ? 'replace' : 'insert',
            overwrite: args.overwrite_existing === true,
            ...(fg ? { typeKeys: true } : {}),
            ...verify,
          }),
          opts: { timeoutMs: 120000 },
          finish: (r) =>
            done(
              r.effect || 'unverifiable',
              r.route || 'ax',
              {
                characters: Array.from(text).length,
                ...(t.el ? { element: t.el.index } : {}),
                ...(r.previous !== undefined ? { previous: r.previous } : {}),
              },
              r,
              at(t.point),
            ),
        };
      }
      case 'key':
        return {
          method: 'app.key',
          params: this.base(c, { windowId: id, combo, ...(t.focused ? { focused: true } : t.el ? elementRef(t.el) : {}), ...verify }),
          finish: (r) =>
            done(
              r.effect || (r.ok ? 'confirmed' : 'ineffective'),
              r.route || 'pid',
              { keys: combo, ...(r.action ? { via: r.action } : {}) },
              r,
              at(t.point),
            ),
        };
      case 'scroll': {
        const dy = Number(args.dy);
        if (!Number.isFinite(dy) || dy === 0) throw new ToolError('dy must be a non-zero number', 'bad_args');
        if (t.focused) throw new ToolError('Scroll at a coordinate or element_index', 'bad_args');
        return {
          method: 'app.scroll',
          params: this.base(c, { windowId: id, ...this.where(t), dy, ...expect, ...verify }),
          finish: (r) =>
            done(
              r.route === 'ax' ? 'confirmed' : 'unverifiable',
              r.route || 'pid',
              { dy, ...(r.saturated ? { note: 'reached the end of the scroll range' } : {}) },
              r,
              at(t.point),
            ),
        };
      }
      case 'drag':
        return {
          method: 'app.drag',
          params: this.base(c, { windowId: id, points, ...expect, ...verify }),
          finish: (r) =>
            done(
              'unverifiable',
              'pid',
              { points: points.length },
              r,
              points.map(([x, y]) => ({ x, y })),
            ),
        };
      default: {
        // focus
        if (t.focused) throw new ToolError('Focus an element by coordinate or element_index', 'bad_args');
        if (!t.el) throw new ToolError('No element at that point to focus; take a new desktop_app_screenshot', 'bad_args');
        return {
          method: 'app.focus',
          params: this.base(c, { windowId: id, ...elementRef(t.el), ...verify }),
          finish: (r) =>
            done(
              r.moved ? 'confirmed' : 'ineffective',
              'ax',
              {
                element: t.el.index,
                ...(r.moved
                  ? {}
                  : {
                      reason:
                        "focus did not move: the app's text cursor is in another of its windows; desktop_app_click the element instead",
                    }),
              },
              r,
              at(t.point),
            ),
        };
      }
    }
  }

  /**
   * A single desktop_app_* tool: its record (or its screenshot/zoom content).
   * @this {AppScopedControl}
   */
  async one(c, action, args) {
    try {
      const out = await this.act(c, action, args);
      return this.withShot(c, args, out);
    } catch (e) {
      const err = appHelperError(e);
      if (err.code === 'permission') throw err;
      const record = P.actionRecord(action, err.code === 'unsupported' ? 'unsupported' : 'refused', 'none', { reason: err.message });
      throw Object.assign(new ToolError(`${err.message}\n${JSON.stringify(record)}`, err.code), { record });
    }
  }
}

module.exports = { AppScopedActions };
