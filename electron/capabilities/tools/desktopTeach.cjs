// Teach mode and full control for the desktop_* tools. Teach mode: the agent walks the user through a task with on-screen
// tooltips (desktop_request_teach_access, then desktop_teach_step / desktop_teach_batch): each step shows one tooltip, waits
// for the user's Next, then runs the step's actions through the same gate, tiers and checks as desktop_batch. Full control:
// desktop_request_full_control asks the screen-control consent up front (the takeover card), desktop_release_full_control
// takes it back. Both build on the grants and the takeover consent of the layers below.
const { ToolError } = require('../contract/registry.cjs');
const { userError } = require('../../../shared/userError.mjs');
const { ACTIONS, MAX_BATCH } = require('./desktopSpecs.cjs');
const { DesktopCapture } = require('./desktopCapture.cjs');

/** The actions a teach step may run: desktop_batch's, except zoom. */
const TEACH_ACTIONS = ACTIONS.filter((a) => a !== 'zoom');
const BUSY = 'Another chat is guiding the user through a task. Try again once that tour has ended.';
const NOT_ACTIVE = 'Teach mode is not active. Call desktop_request_teach_access first.';
const DECLINED =
  'The user declined to start the guided walkthrough (teach mode). Do not call desktop_request_teach_access again for this same request. Ask the user how they would like to proceed, for example whether you should just do the task directly instead of guiding them through it.';

/** @typedef {InstanceType<typeof import('./desktop.cjs').DesktopControl>} DesktopControl the control these methods run on */

/** What a step answers when the user left the tour. */
const LEFT = { exited: true, summary: { exited: true }, content: [], failed: false };

/** A text result. */
const say = (text) => [{ type: 'text', text }];

class DesktopTeach extends DesktopCapture {
  /* -- full control ------------------------------------------------ */

  /**
   * desktop_request_full_control: the screen-control consent, asked now with the reason on the card.
   * @this {DesktopControl}
   */
  async requestFullControl(chatId, ctx) {
    if (this.cu.anchor(chatId) === 'readOnly')
      throw new ToolError('This chat is in a read-only mode: desktop control can only look', 'read_only');
    const s = this.session(chatId);
    const next = this.granted(chatId).size
      ? 'The screen tools (desktop_screenshot, desktop_left_click, desktop_type, ...) will proceed.'
      : 'No app is granted yet, so request access to the apps you need next (desktop_request_access); once an app is granted, the screen tools proceed without asking again.';
    if (s.consent) return say(`Full-screen control is already available for this chat; it does not need to be approved again. ${next}`);
    await this.takeoverConsent(chatId, ctx, { explicit: true });
    return say(`Full-screen control approved for this chat. ${next} This approval lasts until the chat ends.`);
  }

  /**
   * desktop_release_full_control: lets go of the desktop and forgets the consent, so the next screen input asks again.
   * @this {DesktopControl}
   */
  async releaseFullControl(chatId) {
    this.session(chatId).consent = false;
    // a tour needs the screen: it ends with the control it ran on
    this.endTeach(chatId);
    await this.letGo(chatId);
    const keep = this.granted(chatId).size
      ? 'Keep going with the desktop_app_* tools'
      : 'No app is granted for background control yet, so request access to the apps you need before using the desktop_app_* tools';
    return say(
      `Released full-screen control. The screen overlay is off. ${keep}; ask for full-screen control again if you need it later (the user will be asked again).`,
    );
  }

  /* -- teach mode -------------------------------------------------- */

  /**
   * desktop_request_teach_access: the access card in its teach wording; on approval the tour starts.
   * @this {DesktopControl}
   */
  async requestTeachAccess(chatId, args, ctx) {
    if (!this.teachOverlay?.available) throw new ToolError('Teach mode is not available in this session.', 'unavailable');
    const other = [...this.teaching].find((id) => id !== chatId);
    if (other) throw new ToolError(BUSY, 'busy');
    if (this.teaching.has(chatId))
      throw new ToolError(
        'Teach mode is already active. To add more apps, end the current tour first, then call desktop_request_teach_access again with the full app list.',
        'denied',
      );
    if (typeof args.reason !== 'string' || !args.reason.trim()) throw new ToolError('"reason" must be a string.', 'bad_args');
    if (this.cu.anchor(chatId) === 'readOnly')
      throw new ToolError('This chat is in a read-only mode: desktop control can only look', 'read_only');
    const unattended = await this.cu.unattended(chatId, ctx);
    if (unattended)
      throw new ToolError(
        `Teach mode needs the user at the screen to click Next, and nobody is here (${unattended}). Do the task directly instead.`,
        'unattended',
      );
    return this.requestAccess(chatId, { apps: args.apps, reason: args.reason, screenControl: true }, ctx, true);
  }

  /**
   * The access card was answered: starts the tour when the user agreed and an app is granted.
   * @param {string} chatId
   * @param {any} out what desktop_request_access would return
   * @param {any} answer the card's answer
   * @this {DesktopControl}
   */
  startTeach(chatId, out, answer) {
    if (answer?.decision !== 'allow') throw new ToolError(DECLINED, 'denied');
    // another chat's tour began while the card was open
    if ([...this.teaching].some((id) => id !== chatId)) throw new ToolError(BUSY, 'busy');
    const active = out.granted.length > 0;
    if (active) {
      this.session(chatId).consent = true;
      this.teaching.add(chatId);
    }
    const result = {
      ...out,
      teachModeActive: active,
      next: active
        ? 'Teach mode is active. Take a desktop_screenshot, then call desktop_teach_step (or desktop_teach_batch): the user sees only the tooltips until teach mode ends.'
        : 'No app could be granted, so teach mode did not start.',
    };
    return [{ type: 'text', text: JSON.stringify(result, null, 1) }];
  }

  /**
   * The chat's tour ends: the tooltip goes. Safe to call when it has none.
   * @this {DesktopControl}
   */
  endTeach(chatId) {
    if (!this.teaching.delete(chatId)) return;
    this.teachOverlay?.hide(chatId);
  }

  /**
   * One step as validated: what the tooltip says, where it points (global points, or null), and the actions to run.
   * @this {DesktopControl}
   */
  teachStepOf(chatId, raw, label) {
    if (!raw || typeof raw !== 'object') throw new ToolError(`${label} must be an object`, 'bad_args');
    for (const k of ['explanation', 'next_preview'])
      if (typeof raw[k] !== 'string') throw new ToolError(`${label}: "${k}" must be a string.`, 'bad_args');
    if (!Array.isArray(raw.actions)) throw new ToolError(`${label}: "actions" must be an array (empty is allowed).`, 'bad_args');
    if (raw.actions.length > MAX_BATCH) throw new ToolError(`${label}: at most ${MAX_BATCH} actions per step`, 'bad_args');
    for (const [i, a] of raw.actions.entries()) {
      if (!a || typeof a !== 'object') throw new ToolError(`${label}: actions[${i}] must be an object`, 'bad_args');
      if (!TEACH_ACTIONS.includes(a.action))
        throw new ToolError(
          `${label}: actions[${i}].action="${a.action}" is not allowed. Allowed: ${TEACH_ACTIONS.join(', ')}.`,
          'bad_args',
        );
    }
    /** @type {{ x: number, y: number } | null} */
    let anchor = null;
    if (raw.anchor !== undefined) {
      const bad =
        !Array.isArray(raw.anchor) || raw.anchor.length !== 2 || !raw.anchor.every((n) => typeof n === 'number' && Number.isFinite(n));
      if (bad) throw new ToolError(`${label}: "anchor" must be a [x, y] number tuple or omitted.`, 'bad_args');
      try {
        anchor = this.pointOf(this.session(chatId), raw.anchor, 'anchor');
      } catch {
        // no screenshot yet, or the point lies off it: the tooltip is centered, without an arrow
        anchor = null;
      }
    }
    const near = this.session(chatId).geom;
    return {
      view: { explanation: raw.explanation, nextPreview: raw.next_preview, anchor, near: near ? { x: near.x, y: near.y } : null },
      actions: raw.actions,
    };
  }

  /**
   * Shows the step's tooltip, waits for Next, then runs its actions. {exited} when the user left; otherwise the actions'
   * summary ({ executed, failed?, remaining?, results }), the images they produced, and whether one failed.
   * @returns {Promise<{ exited: boolean, summary: any, content: any[], failed: boolean }>}
   * @this {DesktopControl}
   */
  async teachRun(chatId, step, ctx, { shot }) {
    const overlay = /** @type {NonNullable<DesktopControl['teachOverlay']>} */ (this.teachOverlay);
    if (ctx.signal?.aborted) return LEFT;
    const onAbort = () => overlay.hide(chatId);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let choice;
    try {
      choice = await overlay.show(chatId, step.view);
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
    }
    if (choice !== 'next') {
      this.endTeach(chatId);
      return LEFT;
    }
    // Next with the tour still on (the turn may have ended while the tooltip waited)
    if (!this.teaching.has(chatId) || ctx.signal?.aborted) return LEFT;
    overlay.working(chatId);
    if (!step.actions.length) return { exited: false, summary: { executed: 0, results: [] }, content: [], failed: false };
    let ran;
    let content;
    try {
      const [head, ...rest] = await this.batch(chatId, { actions: step.actions }, ctx, { screenshot: shot });
      ran = JSON.parse(head.text);
      content = rest;
    } catch (error) {
      // a missing macOS permission or another failure that is not an action's own: the tour ends with it
      this.endTeach(chatId);
      throw error;
    }
    if (ran.stoppedAt === undefined)
      return { exited: false, summary: { executed: ran.completed, results: ran.results }, content, failed: false };
    const records = ran.results;
    const summary = {
      executed: ran.stoppedAt,
      failed: records[records.length - 1],
      remaining: ran.of - ran.stoppedAt - 1,
      results: records.slice(0, -1),
    };
    return { exited: false, summary, content, failed: true };
  }

  /**
   * desktop_teach_step.
   * @this {DesktopControl}
   */
  async teachStep(chatId, args, ctx) {
    if (!this.teaching.has(chatId)) throw new ToolError(NOT_ACTIVE, 'denied');
    const step = this.teachStepOf(chatId, args, 'desktop_teach_step');
    const r = await this.teachRun(chatId, step, ctx, { shot: true });
    if (r.exited) return [{ type: 'text', text: JSON.stringify({ exited: true }) }];
    return [{ type: 'text', text: JSON.stringify(r.summary) }, ...r.content];
  }

  /**
   * desktop_teach_batch.
   * @this {DesktopControl}
   */
  async teachBatch(chatId, args, ctx) {
    if (!this.teaching.has(chatId)) throw new ToolError(NOT_ACTIVE, 'denied');
    if (!Array.isArray(args.steps) || !args.steps.length) throw new ToolError('"steps" must be a non-empty array.', 'bad_args');
    const steps = args.steps.map((raw, i) => this.teachStepOf(chatId, raw, `steps[${i}]`));
    const results = [];
    let acted = false;
    for (const [i, step] of steps.entries()) {
      const r = await this.teachRun(chatId, step, ctx, { shot: false });
      if (r.exited) return [{ type: 'text', text: JSON.stringify({ exited: true, stepsCompleted: i }) }];
      if (r.failed) {
        const { results: stepResults, ...failure } = r.summary;
        return [
          { type: 'text', text: JSON.stringify({ stepsCompleted: i, stepFailed: i, ...failure, stepResults, results }) },
          ...(await this.teachShot(chatId, ctx)),
        ];
      }
      acted ||= step.actions.length > 0;
      results.push(r.summary.results);
    }
    const summary = JSON.stringify({ stepsCompleted: steps.length, results });
    if (!acted) return [{ type: 'text', text: summary }];
    return [{ type: 'text', text: summary }, ...(await this.teachShot(chatId, ctx))];
  }

  /**
   * The fresh screenshot a batch of steps ends with.
   * @this {DesktopControl}
   */
  async teachShot(chatId, ctx) {
    const s = this.session(chatId);
    if (this.settleMs) await this.settle();
    try {
      return (await this.serial(() => this.screenshot(chatId, s, {}, ctx))).content;
    } catch (e) {
      return [{ type: 'text', text: `No screenshot after the steps: ${userError(e)}` }];
    }
  }
}

module.exports = { DesktopTeach, TEACH_ACTIONS };
