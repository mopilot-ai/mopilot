// The background desktop_app_* tools' menus, bringing windows to the current Space, releasing locks, and desktop_app_batch.
const { ToolError } = require('../contract/registry.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { MAX_BATCH } = require('./appScopedSpecs.cjs');
const { appHelperError, isMenuDisabled, menuDisabledError, NEEDS, stillActing } = require('./appScopedUtil.cjs');
const { mayAct } = require('../contract/actionGuard.cjs');
const { AppScopedActions } = require('./appScopedActions.cjs');
const { handedBack } = require('./takeoverWait.cjs');
const { mayForeground, foregroundNote, laddered } = require('./appScopedLadder.cjs');

/** @typedef {InstanceType<typeof import('./appScoped.cjs').AppScopedControl>} AppScopedControl the control these methods run on */

/**
 * What a menu listing says of "(disabled)" items: an app that isn't in front keeps its document commands disabled (TextEdit's
 * Export as PDF, Save, Print, #3571 G7 CM-D21), so the mark is not final: pressing one by path retries it with the app briefly in
 * front when that is allowed. A Codex run read the mark as final and never pressed Export as PDF.
 * @param {boolean} mayRetry the retry in front is allowed for this app @param {{ enabled?: boolean }[]} items
 */
function disabledNote(mayRetry, items) {
  if (!mayRetry || !(items || []).some((i) => i.enabled === false)) return '';
  return ' (disabled) can just mean the app is not in front: pressing the item by path retries it with the app briefly in front, so try it before giving up.';
}

class AppScopedBatch extends AppScopedActions {
  /** @this {AppScopedControl} */
  async menu(c, args) {
    const hasPath = Array.isArray(args.path);
    const hasList = Object.prototype.hasOwnProperty.call(args, 'list');
    if (hasPath === hasList) throw new ToolError('Give exactly one of path or list', 'bad_args');
    if (hasList) {
      this.need(c, 'reading menus', 'read');
      const list = args.list == null ? [] : Array.isArray(args.list) ? args.list.map(String) : [String(args.list)];
      if (list.length) await this.refreshMenu(c, list[0]);
      const r = await c.helper.call('app.menu', this.base(c, { list }), { readOnly: true });
      const items = (r.items || []).map(
        (i) =>
          `${i.title}${i.submenu ? ' ▸' : ''}${i.shortcut ? `  ${i.shortcut}` : ''}${i.enabled === false ? ' (disabled)' : ''}${i.checked ? ' (checked)' : ''}`,
      );
      return [
        {
          type: 'text',
          text: `${list.length ? list.join(' > ') : `${c.app.name} menu bar`}:\n${items.join('\n') || '(empty: the app may fill this menu only when it opens)'}\n(Titles are data from the app. To press one, pass its path.${disabledNote(mayForeground(this.ladder, c.app, 'menu'), r.items)})`,
        },
      ];
    }
    const path = args.path.map(String).filter((p) => p.trim());
    if (path.length < 2) throw new ToolError('path names a menu and an item inside it, e.g. ["File", "New"]', 'bad_args');
    let refreshed = false;
    try {
      this.need(c, 'menu commands', 'full');
      await this.preflight(c);
      const irr = this.consequence(c, 'menu', { ...args, path }, {}, null);
      if (irr) await this.confirm(c, 'menu', irr);
      await this.waitForUser(c);
      this.lock(c.chatId, c.app, this.windowIdOf(c, args) ?? 0);
      const fgOk = mayForeground(this.ladder, c.app, 'menu');
      // an app remembered to keep this kind of item disabled in the background goes straight to the brief foreground
      if (fgOk && this.ladder.rung(c.app.bundleId, 'menu') === 'foreground') return await this.menuInForeground(c, path, null);
      // the item is resolved (enabled state, title) only after its menu was refreshed
      refreshed = await this.refreshMenu(c, path[0]);
      stillActing();
      let r;
      try {
        r = await c.helper.call('app.menu', this.base(c, { path }));
      } catch (e) {
        // disabled in the background (TextEdit's Export as PDF while it isn't active): once more with the app in front
        if (!fgOk || !isMenuDisabled(e)) throw e;
        return await this.menuInForeground(c, path, 'disabled');
      }
      return [
        {
          type: 'text',
          text: JSON.stringify(
            P.actionRecord('menu', r.ok ? 'confirmed' : 'ineffective', 'ax', { app: c.app.name, path: path.join(' > ') }),
          ),
        },
      ];
    } catch (e) {
      const err = isMenuDisabled(e) ? menuDisabledError(c.app.name, path, refreshed) : appHelperError(e);
      const record = P.actionRecord('menu', err.code === 'unsupported' ? 'unsupported' : 'refused', 'none', { reason: err.message });
      throw Object.assign(new ToolError(`${err.message}\n${JSON.stringify(record)}`, err.code), { record });
    }
  }

  /**
   * A menu press with the app briefly in front (the helper refreshes the menu first, then presses, then restores the
   * user's app and pointer); remembered for the app when it worked. `from`: what the background attempt reported.
   * @this {AppScopedControl}
   */
  async menuInForeground(c, path, from) {
    stillActing();
    const r = await c.helper.call('app.menu', this.base(c, { path, foreground: true }));
    const record = P.actionRecord('menu', r.ok ? 'confirmed' : 'ineffective', 'ax', { app: c.app.name, path: path.join(' > ') });
    if (r.ok) this.ladder.remember(c.app, 'menu', 'foreground');
    const out = laddered(record, 'foreground', { from, note: foregroundNote(c.app.name, 'menu', r.foreground), fg: r.foreground });
    return [{ type: 'text', text: JSON.stringify(out) }];
  }

  /**
   * A background app revalidates a menu (menuNeedsUpdate:, validateMenuItem:: enabled items, toggled
   * titles) only when it opens. The helper opens the top-level menu through accessibility and cancels
   * it at once (app.menuRefresh), so the items read next are current. False when that didn't happen
   * (an older helper without it, or the app refused); the menu call then works on what the app shows.
   * @this {AppScopedControl}
   */
  async refreshMenu(c, top) {
    try {
      return (await c.helper.call('app.menuRefresh', this.base(c, { menu: top })))?.refreshed === true;
    } catch {
      return false;
    }
  }

  /** @this {AppScopedControl} */
  async bring(c, args) {
    await this.preflight(c);
    await this.waitForUser(c);
    this.lock(c.chatId, c.app, args.window_id);
    const r = await c.helper.call('app.bringToCurrentSpace', this.base(c, { windowId: args.window_id }));
    const a = this.appState(c);
    // the window moved: its old frame no longer holds
    a.windows.delete(args.window_id);
    a.lastWindow = args.window_id;
    return [
      {
        type: 'text',
        text: `${JSON.stringify(P.actionRecord('bring_to_current_space', 'confirmed', 'ax', { app: c.app.name, window_id: args.window_id, changed: !!r.changed }))}\nTake a new desktop_app_screenshot before acting there.`,
      },
    ];
  }

  /** @this {AppScopedControl} */
  release(chatId, args) {
    let bundleId = null;
    if (args.app) {
      const app = this.desktop.findGranted(chatId, args.app);
      bundleId = app ? app.bundleId : String(args.app);
    }
    const released = this.releaseLocks(chatId, bundleId, typeof args.window_id === 'number' && bundleId ? args.window_id : null);
    return [
      {
        type: 'text',
        text: JSON.stringify({ released, held: [...this.locks.values()].filter((l) => l.chatId === chatId).map((l) => l.name) }),
      },
    ];
  }

  /**
   * desktop_app_batch: in order against one window; stops at the first error or unsupported result.
   * @this {AppScopedControl}
   */
  async batch(c, args) {
    const list = Array.isArray(args.actions) ? args.actions : [];
    if (!list.length) throw new ToolError('actions is empty', 'bad_args');
    if (list.length > MAX_BATCH) throw new ToolError(`At most ${MAX_BATCH} actions per batch`, 'bad_args');
    const ACTS = ['click', 'type', 'key', 'scroll', 'drag', 'screenshot', 'zoom'];
    for (const [i, a] of list.entries())
      if (!a || typeof a !== 'object' || !ACTS.includes(a.action))
        throw new ToolError(`actions[${i}].action must be one of: ${ACTS.join(', ')}`, 'bad_args');
    // the read-only and attendance checks once for the whole batch, not before every action
    if (list.some((a) => Object.hasOwn(NEEDS, a.action))) await this.preflight(c);
    const epoch = c.s.epoch;
    const stopped = () => c.s.epoch !== epoch || !!c.ctx.signal?.aborted || !mayAct();
    const results = [];
    const content = [];
    // assigned by the callbacks below
    let failed = /** @type {{ index: number, record: object } | null} */ (null);
    const fail = (index, action, e) => {
      const err = appHelperError(e);
      if (err.code === 'permission') throw err;
      failed = {
        index,
        record: P.actionRecord(action, err.code === 'unsupported' ? 'unsupported' : 'refused', 'none', { reason: err.message }),
      };
    };
    // input actions (and a screenshot after them) go to the helper together, as one request gated once
    let pending = [];
    const halt = (index, action) => {
      failed = { index, record: P.actionRecord(action, 'refused', 'none', { reason: 'stopped by the user' }) };
    };
    /** Runs what is pending; true when the batch ends here (a failure, or Esc/Stop before the action at `i`). */
    const flush = async (i, action) => {
      const steps = pending;
      pending = [];
      if (steps.length) {
        const out = await this.runSteps(c, steps, stopped);
        for (const o of out.done) {
          results.push(o.record);
          if (o.content) content.push(...o.content);
        }
        if (out.failure) fail(out.failure.index, out.failure.action, out.failure.error);
      }
      if (!failed && i !== undefined && stopped()) halt(i, action);
      return !!failed;
    };
    for (const [i, a] of list.entries()) {
      const { action, ...rest } = a;
      if (stopped()) {
        // what was prepared and not sent doesn't run
        halt(pending[0]?.index ?? i, pending[0]?.action ?? action);
        pending = [];
        break;
      }
      const step = { ...rest, window_id: args.window_id };
      try {
        if (action === 'zoom') {
          if (await flush(i, action)) break;
          const out = await this.zoom(c, step);
          results.push(out.record);
          content.push(...out.content);
          continue;
        }
        if (action === 'screenshot') {
          // later coordinates and element indexes are of this screenshot: the batch so far runs with it
          pending.push({ index: i, action, plan: await this.screenshotPlan(c, step) });
          if (await flush(i + 1 < list.length ? i + 1 : undefined, list[i + 1]?.action)) break;
          continue;
        }
        const r = this.resolve(c, action, step);
        // what the user confirms runs after everything before it, and input to an app they took over waits for them
        if ((r.irr || this.held.has(c.app.bundleId.toLowerCase())) && (await flush(i, action))) break;
        // the user took the app over after earlier steps ran: the rest of the plan may not fit what they leave (#1906)
        if (i > 0 && this.held.has(c.app.bundleId.toLowerCase())) {
          await this.waitForUser(c);
          throw handedBack(c.app.name);
        }
        if (r.irr) await this.confirm(c, action, r.irr);
        pending.push({ index: i, action, plan: await this.ready(c, action, step, r) });
      } catch (e) {
        // refused while being prepared: what was prepared before it still runs first
        await flush();
        if (!failed) fail(i, action, e);
        break;
      }
    }
    await flush();
    if (failed) results.push(failed.record);
    const summary = {
      completed: failed ? failed.index : list.length,
      of: list.length,
      results,
      ...(failed ? { stoppedAt: failed.index } : {}),
    };
    return [{ type: 'text', text: JSON.stringify(summary, null, 1) }, ...content];
  }

  /**
   * Runs prepared steps: as one app.batch request (the helper gates once, then verifies and settles each
   * step), or one request each with an older helper or a single step. The last step brings back the
   * chat's thumbnail when one is due. Returns what was done and the first failure ({index, action, error}).
   * @this {AppScopedControl}
   */
  async runSteps(c, steps, stopped) {
    const done = [];
    const last = steps.length - 1;
    const params = (s, i) => (i === last ? { ...s.plan.params, ...this.thumbDue(c) } : s.plan.params);
    const failure = (s, error) => ({ done, failure: { index: s.index, action: s.action, error } });
    // the user took the app over from the strip, which cancelled the batch: it waits for them, then says so (#1906)
    const cut = async (s, e) => {
      if (e?.reason !== 'aborted' || stopped() || !this.takenOver(c.chatId, c.app.bundleId)) return null;
      try {
        await this.waitForUser(c);
      } catch (err) {
        return failure(s, err);
      }
      return failure(s, handedBack(c.app.name));
    };
    // stopped while the steps were prepared (a card, a take-over wait): none of them is sent
    if (stopped()) return failure(steps[0], new ToolError('stopped by the user', 'refused'));
    const finish = async (s, r) => {
      // a screenshot's finish is async (a text-only model's capture is read first)
      const o = await s.plan.finish(r);
      done.push(o.next ? await this.request(c, o.next) : o);
    };
    if (steps.length > 1 && !this.noHelperBatch) {
      const batchId = `${c.chatId}:${++this.batchSeq}`;
      c.s.batchId = batchId;
      /** @type {{ results?: unknown, error?: { reason?: string, message?: string } } | null} */
      let out = null;
      try {
        const timeoutMs = Math.min(
          steps.reduce((n, s) => n + (s.plan.opts?.timeoutMs ?? 30000), 0),
          600_000,
        );
        out = await c.helper.call(
          'app.batch',
          this.base(c, { batchId, steps: steps.map((s, i) => ({ method: s.plan.method, params: params(s, i) })) }),
          { timeoutMs },
        );
      } catch (e) {
        if (e?.reason !== 'method_not_found') return (await cut(steps[0], e)) ?? failure(steps[0], e);
        // an older helper: one request per step from now on
        this.noHelperBatch = true;
      } finally {
        c.s.batchId = null;
      }
      if (out) {
        const res = Array.isArray(out.results) ? out.results : [];
        for (const [i, r] of res.slice(0, steps.length).entries()) {
          try {
            await finish(steps[i], r);
          } catch (e) {
            return failure(steps[i], e);
          }
        }
        if (res.length >= steps.length) return { done, failure: null };
        const at = steps[res.length];
        const e = out.error || {};
        return (
          (await cut(at, e)) ??
          failure(
            at,
            e.reason === 'aborted'
              ? new ToolError('stopped by the user', 'refused')
              : Object.assign(new Error(e.message || 'the helper stopped the batch'), { reason: e.reason }),
          )
        );
      }
    }
    for (const [i, s] of steps.entries()) {
      if (i > 0 && stopped()) return failure(s, new ToolError('stopped by the user', 'refused'));
      try {
        await finish(s, await c.helper.call(s.plan.method, params(s, i), s.plan.opts));
      } catch (e) {
        return (await cut(s, e)) ?? failure(s, e);
      }
    }
    return { done, failure: null };
  }
}

module.exports = { AppScopedBatch };
