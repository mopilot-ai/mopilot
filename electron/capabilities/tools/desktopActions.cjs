// The desktop tools' input actions: targets, irreversible-action confirmation, clicks, drags, scrolls, keys and typing with its read-back.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { irreversible } = require('../contract/policy.cjs');
const { helperError } = require('./computer.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { MAX_WAIT_S, MAX_REPEAT, MAX_HOLD_S, VERIFY_TRIES } = require('./desktopSpecs.cjs');
const { elementAt, sleep } = require('./desktopUtil.cjs');
const { DesktopGate } = require('./desktopGate.cjs');
const { mayAct } = require('../contract/actionGuard.cjs');
/** @typedef {import('./desktop.cjs').Clipboard} Clipboard */
/** Helper refusals for an element_index whose id no longer names the element the screenshot listed. */
const STALE = new Set(['element_changed', 'element_gone']);

/** @typedef {InstanceType<typeof import('./desktop.cjs').DesktopControl>} DesktopControl the control these methods run on */

class DesktopActions extends DesktopGate {
  /* -- actions ---------------------------------------------------- */

  /**
   * A coordinate of the latest screenshot as global points, checked to lie inside it.
   * @this {DesktopControl}
   */
  pointOf(s, coord, name = 'coordinate') {
    if (!s.geom) throw new ToolError('Take a desktop_screenshot first: coordinates are pixels of the latest screenshot', 'bad_args');
    if (!Array.isArray(coord) || coord.length !== 2 || !coord.every((n) => typeof n === 'number' && Number.isFinite(n)))
      throw new ToolError(`${name} must be [x, y]`, 'bad_args');
    const [x, y] = coord;
    if (x < 0 || y < 0 || x >= s.geom.width || y >= s.geom.height)
      throw new ToolError(`${name} (${x}, ${y}) is outside the ${s.geom.width}x${s.geom.height} screenshot`, 'bad_args');
    return P.toPoints(s.geom, { x, y });
  }

  /** @this {DesktopControl} */
  elementOf(s, index) {
    const e = s.elements[index - 1];
    if (!e) throw new ToolError(`No element [${index}] in the latest screenshot; take a new desktop_screenshot`, 'bad_args');
    return e;
  }

  /**
   * The point of an action and the element it names, if any.
   * @this {DesktopControl}
   */
  target(s, args) {
    if (typeof args.element_index === 'number') {
      const el = this.elementOf(s, args.element_index);
      return { el, point: { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 } };
    }
    return { el: null, point: this.pointOf(s, args.coordinate) };
  }

  /**
   * One action, already past the consent (input) and inside the serial queue. Returns {record, content?}.
   * Refusals throw a ToolError whose message ends with the action record.
   * @this {DesktopControl}
   */
  async act(chatId, action, args, ctx) {
    const s = this.session(chatId);
    /** @type {(e: any) => never} */
    const refuse = (e) => {
      /** @type {InstanceType<typeof ToolError> & { permission?: string }} */
      const err = e instanceof ToolError ? e : helperError(e);
      if (err.code === 'permission') throw err;
      const record = P.actionRecord(action, 'refused', 'global', { reason: err.message });
      throw Object.assign(new ToolError(`${err.message}\n${JSON.stringify(record)}`, err.code), { record, permission: err.permission });
    };
    try {
      if (action === 'wait') {
        const secs = Math.min(Math.max(Number(args.duration) || 0, 0), MAX_WAIT_S);
        await sleep(secs * 1000);
        return { record: P.actionRecord('wait', 'confirmed', 'global', { seconds: secs }) };
      }
      const helper = await this.ready();
      if (action === 'screenshot') return await this.screenshot(chatId, s, args, ctx);
      if (action === 'zoom') return await this.zoom(chatId, s, args, ctx);
      if (action === 'cursor_position') {
        await this.gate(chatId, action, args, null);
        const p = await helper.cursor();
        if (!s.geom) return { record: P.actionRecord('cursor_position', 'confirmed', 'global', { points: [p.x, p.y] }) };
        const px = P.toPixels(s.geom, p);
        return { record: P.actionRecord('cursor_position', 'confirmed', 'global', { coordinate: [px.x, px.y] }) };
      }
      return await this.input(chatId, s, action, args, ctx);
    } catch (e) {
      refuse(e);
    }
  }

  /**
   * An input action: checked and run inside the serial queue. One that can't be undone (a click on a
   * "Send" or "Delete" control, Return in a messaging app, cmd+delete, or flagged irreversible by the
   * model) is confirmed by the user every time, outside the queue, and then checked again before it runs.
   * @this {DesktopControl}
   */
  async input(chatId, s, action, args, ctx) {
    /** @type {{ key: string } | null} */
    let confirmed = null;
    // the desktop as this call found it: one taken for an action that is then refused (the gate, or the user
    // declining the card) is let go again, instead of being held until the turn ends
    // (a lock the chat's ended or stopped turn kept is not held: liveHolder lets go of it)
    const held = this.cu.liveHolder() === chatId;
    const letGo = async (e) => {
      if (!held && this.cu.controlling === chatId) await this.cu.release(chatId);
      throw e;
    };
    for (let confirms = 0; confirms < 2; ) {
      const r = await this.serial(async () => {
        const prep = await this.prepare(chatId, s, action, args).catch(letGo);
        const irr = this.consequence(s, action, args, prep);
        if (irr && irr.key !== confirmed?.key) return { irr, prep };
        // the user took over: the action waits for "Done, continue" outside the queue, then is checked again (#1905)
        if (this.cu.takeover.is(chatId)) return { wait: true };
        return { out: await this.perform(chatId, s, action, args, prep) };
      }).catch((e) => this.cu.cutShort(chatId, e, ctx?.signal));
      if (r.out) return r.out;
      const { irr, prep } = r;
      if (!irr || !prep) {
        await this.cu.takeover.wait(chatId, ctx?.signal);
        continue;
      }
      // the card's Allow also hands the desktop back, should the user have taken it over (#1902)
      await this.confirm(chatId, action, irr, prep.g.front, ctx).catch(letGo);
      confirmed = irr;
      confirms++;
    }
    throw new ToolError(
      'What this action reaches changed while the user was confirming it; take a new desktop_screenshot and try again',
      'changed',
    );
  }

  /**
   * What an action would do that can't be undone ({verb, summary, key}), by the policy the computer_* tools use; or null.
   * @this {DesktopControl}
   */
  consequence(s, action, args, prep) {
    const front = prep.g.front;
    const app = front ? { bundleId: front.bundleId, name: front.name } : null;
    const flag = { irreversible: args.irreversible === true, summary: action.replace(/_/g, ' ') };
    /** @type {ReturnType<typeof irreversible>} */
    let irr = null;
    if (/_click$/.test(action)) {
      const el = prep.el || elementAt(s.elements, prep.point);
      irr = irreversible('computer_click', flag, { app, element: el ? { role: el.role, title: el.label } : null });
    } else if (action === 'key' || action === 'hold_key') {
      for (const combo of prep.combos) if ((irr = irreversible('computer_key', { ...flag, key: combo }, { app }))) break;
    } else if (action === 'type') {
      irr = irreversible('computer_type', { ...flag, text: String(args.text ?? '') }, { app });
    } else if (flag.irreversible) {
      irr = irreversible('computer_act', flag, { app });
    }
    return irr ? { ...irr, key: `${app?.bundleId ?? ''}\u0000${irr.verb}\u0000${irr.summary}` } : null;
  }

  /**
   * Asks the user to confirm an action that can't be undone; nobody there to ask refuses it and pauses the chat.
   * @this {DesktopControl}
   */
  async confirm(chatId, action, irr, front, ctx) {
    const app = { bundleId: front?.bundleId || '', name: front?.name || 'this app' };
    const unattended = await this.cu.unattended(chatId, ctx);
    if (unattended) {
      const message = `This would ${irr.verb} in ${app.name}, which can't be undone, and nobody is here to confirm it (${unattended}). MoPilot paused this chat and asked the user; don't retry.`;
      this.cu.onUnattended(chatId, { app, code: 'unattended', message, need: null, tool: `desktop_${action}` });
      throw new ToolError(message, 'unattended');
    }
    this.revealHost();
    const answer = await this.broker.ask(
      chatId,
      'computerConfirm',
      { harness: this.cu.harness(chatId), app, verb: irr.verb, summary: irr.summary, tool: `desktop_${action}` },
      { signal: ctx?.signal },
    );
    if (answer?.decision !== 'allow') throw new ToolError(`The user didn't confirm: ${irr.verb} in ${app.name}`, 'denied');
    // the Allow hands the desktop back for the action the user confirmed, should they have taken it over meanwhile (#1902)
    await this.cu.resumeAfterCard(chatId);
  }

  /**
   * Validates an action and checks it against the grants (gate), right before it runs.
   * @this {DesktopControl}
   */
  async prepare(chatId, s, action, args) {
    const helper = this.helper;
    /** @type {{ x: number, y: number } | null} */
    let point = null;
    let el = null;
    /** @type {{ x: number, y: number } | null} */
    let end = null;
    const given = (v) => v !== undefined && v !== null;
    if (action === 'left_click_drag') {
      const start = given(args.start_coordinate) ? this.pointOf(s, args.start_coordinate, 'start_coordinate') : null;
      end = this.pointOf(s, args.coordinate);
      // no start: the drag starts where the pointer is
      point = start || (await this.pointer());
    } else if (action === 'left_mouse_down' || action === 'left_mouse_up') {
      point = given(args.coordinate) ? this.pointOf(s, args.coordinate) : action === 'left_mouse_down' ? await this.pointer() : null;
    } else if (P.POINTER.has(action)) {
      ({ el, point } = this.target(s, args));
    } else if (action === 'type' && typeof args.element_index === 'number') {
      el = this.elementOf(s, args.element_index);
    }
    /** @type {string[]} */
    let combos = [];
    if (action === 'key' || action === 'hold_key') {
      combos = P.keySequence(args.text);
      if (!combos.length) throw new ToolError('Name a key, e.g. "Return" or "cmd+a"', 'bad_args');
      const sys = combos.find(P.isSystemCombo);
      if (sys && !s.systemKeyCombos)
        throw new ToolError(
          `${sys} acts on the whole Mac; it needs systemKeyCombos: call desktop_request_access with systemKeyCombos: true`,
          'denied',
        );
    }
    await this.stage(chatId);
    // letting go of the left button is never refused: holding it down any longer would be worse
    const g = action === 'left_mouse_up' ? this.anyGranted(chatId) : await this.gate(chatId, action, args, point);
    if (end) {
      // a failed lookup is the helper's error, not a refusal: act() reports it as such
      const at = await helper.targetInfo(end);
      const endGrant = at?.bundleId ? g.granted.get(at.bundleId.toLowerCase()) : null;
      if (!endGrant || P.tierRank(endGrant.tier) < P.tierRank('full'))
        throw new ToolError(`The drag would end on ${at?.name || 'an app'}, which isn't granted at full control`, 'denied');
    }
    return { g, point, el, end, combos };
  }

  /**
   * Where the pointer is, in global points.
   * @this {DesktopControl}
   */
  async pointer() {
    const p = await this.helper.cursor();
    return { x: p.x, y: p.y };
  }

  /**
   * The gate's answer for an action any granted app may receive (letting go of a button).
   * @this {DesktopControl}
   */
  anyGranted(chatId) {
    const granted = this.granted(chatId);
    return { granted, allowed: [...granted.values()].map((g) => g.bundleId), front: null };
  }

  /**
   * Runs a checked action (inside the serial queue, right after prepare).
   * @this {DesktopControl}
   */
  async perform(chatId, s, action, args, prep) {
    const helper = this.helper;
    const { g, end, combos } = prep;
    let { point } = prep;
    const { el } = prep;
    await this.acquire(chatId, g.front?.name || null, g.front?.bundleId);
    if (g.front) s.lastApp = g.front.bundleId;
    const only = { bundleIds: g.allowed };
    const app = g.front?.name;
    const done = (effect, route, extra = {}) => ({ record: P.actionRecord(action, effect, route, { app, ...extra }) });
    switch (action) {
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
        const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
        const modifiers = typeof args.text === 'string' ? P.normalizeCombo(args.text) : '';
        if (el && action === 'left_click' && !modifiers) {
          // the element's own press action: no pointer, and the app reports whether it happened
          const r = await helper.axPress(el.pid, el.id, { ...only, expectElement: el.expect }).catch((error) => {
            // the id names another control now, or none: a click at the old center would hit whatever is there
            if (STALE.has(error?.reason)) throw error;
            // the element can't be pressed for us: a pointer click at its center does it instead
            noteIgnored("press a desktop element through its app's accessibility", error);
            return null;
          });
          if (r?.ok) return done('confirmed', 'ax', { element: el.index });
          if (r?.center) point = { x: r.center.x, y: r.center.y };
        }
        const clicked = P.clickOutcome(
          await helper.click(point.x, point.y, { button, count, ...(modifiers ? { modifiers } : {}), ...only }),
        );
        return done(clicked.effect, clicked.route, { ...clicked.extra, ...(el ? { element: el.index } : {}) });
      }
      case 'mouse_move':
        await helper.move(point.x, point.y, only);
        return done('unverifiable', 'global');
      case 'left_click_drag':
        s.held.buttons.add('left');
        try {
          await helper.drag(point.x, point.y, end.x, end.y, only);
        } catch (e) {
          // a drag that timed out may have left the button down: let go of it (only it)
          await helper.releaseInput({ buttons: ['left'] }).catch((error) => {
            // best effort; the drag error below is what the caller sees
            noteIgnored('let go of the mouse button after a failed drag', error);
          });
          throw e;
        } finally {
          s.held.buttons.delete('left');
        }
        return done('unverifiable', 'global');
      case 'left_mouse_down':
        s.held.buttons.add('left');
        try {
          await helper.button('left', true, point, only);
        } catch (e) {
          // a press that failed half way may have left the button down: let go of it (only it)
          s.held.buttons.delete('left');
          await helper.releaseInput({ buttons: ['left'] }).catch((error) => {
            // best effort; the press error below is what the caller sees
            noteIgnored('let go of the mouse button after a failed press', error);
          });
          throw e;
        }
        return done('unverifiable', 'global');
      case 'left_mouse_up':
        await helper.button('left', false, point, only);
        s.held.buttons.delete('left');
        return done('unverifiable', 'global');
      case 'scroll': {
        const n = Math.min(Math.max(Math.round(Number(args.scroll_amount) || 3), 1), 50);
        const dir = args.scroll_direction;
        if (!['up', 'down', 'left', 'right'].includes(dir))
          throw new ToolError('scroll_direction must be up, down, left or right', 'bad_args');
        // wheel lines: positive is up (or left)
        const dy = dir === 'up' ? n : dir === 'down' ? -n : 0;
        const dx = dir === 'left' ? n : dir === 'right' ? -n : 0;
        await helper.scroll(point.x, point.y, dx, dy, { units: 'line', ...only });
        return done('unverifiable', 'global', { amount: n, direction: dir });
      }
      case 'type': {
        const text = String(args.text ?? '');
        let focused = false;
        if (el) {
          const r = await helper.axFocus(el.pid, el.id, { ...only, expectElement: el.expect }).catch((error) => {
            // the id names another field now, or none: typing would go wherever the old center is
            if (STALE.has(error?.reason)) throw error;
            // the field can't be focused for us: a click at its center focuses it instead
            noteIgnored("focus a desktop field through its app's accessibility", error);
            return null;
          });
          if (r?.ok) focused = true;
          else {
            const c = r?.center || { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 };
            await helper.click(c.x, c.y, { button: 'left', count: 1, ...only });
          }
        }
        const at = el ? { element: el.index } : {};
        if (!text) return done('unverifiable', focused ? 'ax' : 'global', { characters: 0, ...at });
        const r = await this.typeText(chatId, text, args, only);
        const mismatch =
          r.effect === 'mismatch'
            ? {
                reason:
                  'the field reads differently from the text typed (autocorrect, an input mask or a length limit may have changed it, or the text went elsewhere); take a screenshot',
              }
            : {};
        return done(r.effect, focused || r.method === 'ax' ? 'ax' : 'global', {
          characters: r.typed,
          method: r.method,
          ...mismatch,
          ...at,
        });
      }
      case 'key': {
        const repeat = Math.min(Math.max(Math.round(Number(args.repeat) || 1), 1), MAX_REPEAT);
        for (let i = 0; i < repeat; i++) {
          for (const combo of combos) {
            if (!mayAct()) throw new ToolError('Stopped by the user', 'stopped');
            const press = () => helper.key(combo, only);
            if (P.hasEscape(combo) && this.indicator) await this.indicator.suspendEscape(press);
            else await press();
          }
        }
        return done('unverifiable', 'global', { keys: combos.join(' '), repeat });
      }
      case 'hold_key': {
        const secs = Math.min(Math.max(Number(args.duration) || 0, 0), MAX_HOLD_S);
        const combo = combos[0];
        s.held.keys.add(combo);
        try {
          const hold = () =>
            helper.call('input.key', { key: combo, holdMs: Math.round(secs * 1000), ...only }, { timeoutMs: secs * 1000 + 5000 });
          if (P.hasEscape(combo) && this.indicator) await this.indicator.suspendEscape(hold);
          else await hold();
        } catch (e) {
          await helper.releaseInput({ keys: [combo] }).catch((error) => {
            // best effort; the key error below is what the caller sees
            noteIgnored('let go of a held key after a failed key press', error);
          });
          throw e;
        } finally {
          s.held.keys.delete(combo);
        }
        return done('unverifiable', 'global', { keys: combo, seconds: secs });
      }
      default:
        throw new ToolError(`Unknown action: ${action}`, 'bad_args');
    }
  }

  /**
   * Puts text into the focused field, the first way that works (P.typingRoutes): an accessibility
   * insert (skipped when the app reports it done but the field didn't change), a paste through the
   * clipboard (kept and restored at the turn's end), or keystrokes in chunks (Esc stops them between
   * chunks; the app's substitutions off unless disable_substitutions is false). A way the helper doesn't
   * have falls to the next. Then the field is read back: {method, typed, effect}.
   * @this {DesktopControl}
   */
  async typeText(chatId, text, args, only) {
    const helper = this.helper;
    const substitutions = args.disable_substitutions === false;
    const missing = (e) => {
      if (e?.reason === 'method_not_found') return null;
      throw e;
    };
    const before = await this.readField(only);
    const count = Array.from(text).length;
    // keystrokes are always the last way, and always there
    for (const way of P.typingRoutes(text, { substitutions, clipboard: !!this.clipboard }).filter((w) => w !== 'keys')) {
      if (way === 'paste') {
        // typingRoutes offers paste only when there is a clipboard
        this.writeOwn(await this.stashClipboard(chatId, /** @type {Clipboard} */ (this.clipboard)), text);
        if (!(await helper.paste(only).catch(missing))) continue;
        return { method: 'paste', typed: count, effect: await this.verifyField(before, text, only) };
      }
      if (way === 'ax') {
        const r = await helper.insertText(text, only).catch(missing);
        if (!r?.ok) continue;
        const after = await this.readField(only);
        // reported done, yet the field reads as before: the app ignored it, so type it instead
        if (before && after && after.value === before.value) continue;
        return { method: 'ax', typed: count, effect: P.typingEffect(before, after, text) };
      }
    }
    let typed = 0;
    for (const chunk of P.chunkText(text, 50)) {
      if (!mayAct()) throw new ToolError(`Stopped by the user after ${typed} characters`, 'stopped');
      const r = await helper.type(chunk, { ...only, ...(substitutions ? {} : { disableSubstitutions: true }) });
      typed += Number(r?.typed ?? Array.from(chunk).length);
    }
    return { method: 'keys', typed, effect: await this.verifyField(before, text, only) };
  }

  /**
   * The focused field as the helper reads it ({value, selection?, truncated?}), or null when it can't.
   * @this {DesktopControl}
   */
  async readField(only) {
    const r = await this.helper.focusedText(only).catch((error) => {
      // unreadable: the typing is reported as unverified
      noteIgnored('read back the focused field after typing', error);
      return null;
    });
    return r && typeof r.value === 'string' ? r : null;
  }

  /**
   * Reads the field back (the app may take a moment to show a paste or keystrokes) until it reads as it should.
   * @this {DesktopControl}
   */
  async verifyField(before, text, only) {
    if (!before) return 'unverifiable';
    let effect = 'unverifiable';
    for (let i = 0; i < VERIFY_TRIES; i++) {
      if (this.verifyMs) await sleep(this.verifyMs);
      effect = P.typingEffect(before, await this.readField(only), text);
      if (effect !== 'mismatch') return effect;
    }
    return effect;
  }
}

module.exports = { DesktopActions };
