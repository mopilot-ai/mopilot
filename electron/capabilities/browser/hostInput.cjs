// The browser host's input: clicks, hovers, drags, scrolls, keys and text through CDP Input.*, shown by the agent cursor and cut short when a dialog opens.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { chordEvents } = require('./keys.cjs');
const { HOLD_MS_MAX, noteInput, releaseHeld, holdFor } = require('./heldInput.cjs');
const { HostTabs } = require('./hostTabs.cjs');
const { stopped, checkAct } = require('../contract/actionGuard.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs the host these methods and helpers run on */
/** @typedef {import('./host.cjs').Tab} Tab */
/** @typedef {import('./host.cjs').PagePoint} PagePoint */

class HostInput extends HostTabs {
  /**
   * @param tab
   * @this {BrowserTabs}
   */
  async click(
    tab,
    /** @type {PagePoint} */ { x, y, name },
    /** @type {{ button?: 'left' | 'right' | 'middle', clickCount?: number, modifiers?: number, holdMs?: number }} */ {
      button = 'left',
      clickCount = 1,
      modifiers = 0,
      holdMs = 0,
    } = {},
  ) {
    const buttons = { left: 1, right: 2, middle: 4 }[button];
    if (holdMs * clickCount > HOLD_MS_MAX)
      throw new ToolError(`Hold the button for at most ${HOLD_MS_MAX / 1000} seconds in all.`, 'bad_args');
    await show(this, tab, { kind: 'click', x, y, name, button, clickCount });
    const p = { x, y };
    return guard(this, tab, (cut) =>
      holding(tab, cut, async (send) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, modifiers });
        for (let i = 1; i <= clickCount; i++) {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button, buttons, clickCount: i, modifiers });
          // a stopped call or an ended turn lets go at once, and presses no more
          if (holdMs && !(await holdFor(holdMs, cut))) return 'stopped';
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button, buttons: 0, clickCount: i, modifiers });
        }
      }),
    );
  }

  /**
   * @param tab
   * @this {BrowserTabs}
   */
  async hover(tab, /** @type {PagePoint} */ { x, y, name }) {
    await show(this, tab, { kind: 'hover', x, y, name });
    return guard(this, tab, () => tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }));
  }

  /** @this {BrowserTabs} */
  async drag(tab, from, to) {
    await show(this, tab, { kind: 'drag', x: from.x, y: from.y, to });
    return guard(this, tab, async () => {
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: from.x,
        y: from.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await tab.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          button: 'left',
          buttons: 1,
        });
      }
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: to.x,
        y: to.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    });
  }

  /** @this {BrowserTabs} */
  async scroll(tab, { x, y }, direction, amount = 3) {
    const n = Math.max(1, Math.min(10, Math.round(amount)));
    const d = { up: [0, -100], down: [0, 100], left: [-100, 0], right: [100, 0] }[direction];
    if (!d) throw new ToolError('scroll_direction must be up, down, left or right.', 'bad_args');
    await show(this, tab, { kind: 'scroll', x, y, direction });
    return guard(this, tab, () => tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: d[0] * n, deltaY: d[1] * n }));
  }

  /** @this {BrowserTabs} */
  async typeText(tab, text) {
    // the field it goes into, never the text
    await show(this, tab, { kind: 'type' });
    return guard(this, tab, () => tab.send('Input.insertText', { text: String(text) }));
  }

  /** @this {BrowserTabs} */
  async keys(tab, text, repeat = 1, /** @type {{ holdMs?: number }} */ { holdMs = 0 } = {}) {
    const seq = String(text).trim().split(/\s+/).filter(Boolean);
    if (!seq.length) throw new ToolError('Give the key(s) to press.', 'bad_args');
    const events = seq.map((k) => chordEvents(k, this.o.platform));
    const n = Math.max(1, Math.min(100, Math.round(repeat)));
    if (holdMs * n * seq.length > HOLD_MS_MAX)
      throw new ToolError(`Hold keys for at most ${HOLD_MS_MAX / 1000} seconds in all.`, 'bad_args');
    await show(this, tab, { kind: 'key', keys: seq.join(' ') });
    return guard(this, tab, (cut) =>
      holding(tab, cut, async (send) => {
        for (let r = 0; r < n; r++)
          for (const e of events) {
            for (const down of e.downs) await send('Input.dispatchKeyEvent', down);
            // a stopped call or an ended turn lets go at once, and presses no more
            if (holdMs && !(await holdFor(holdMs, cut))) return 'stopped';
            for (const up of e.ups) await send('Input.dispatchKeyEvent', up);
          }
      }),
    );
  }

  /**
   * A mouse wheel turn of (dx, dy) CSS pixels at a point.
   * @this {BrowserTabs}
   */
  async wheel(tab, { x, y }, dx, dy) {
    const deltaX = Number(dx) || 0;
    const deltaY = Number(dy) || 0;
    await show(this, tab, {
      kind: 'scroll',
      x,
      y,
      direction: deltaY < 0 ? 'up' : deltaY > 0 || !deltaX ? 'down' : deltaX < 0 ? 'left' : 'right',
    });
    return guard(this, tab, () => tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }));
  }
}

/**
 * Runs input `work` that presses keys or buttons through `send`, then lets go of whatever it left down (it was
 * stopped mid-hold, a dialog opened under it, or a send failed): nothing stays held on the page after the action.
 * @param {Tab} tab
 * @param {AbortSignal} cut aborted when a dialog opens under the action (guard): a hold ends then too
 * @param {(send: (method: string, params: Record<string, any>) => Promise<unknown>) => Promise<'stopped' | undefined>} work
 */
async function holding(tab, cut, work) {
  // noted before it goes: an event whose answer never came may still have pressed the key
  const send = (method, params) => {
    noteInput(tab, method, params);
    return tab.send(method, params);
  };
  let r;
  try {
    r = await work(send);
  } finally {
    await releaseHeld(tab, (method, params) => tab.send(method, params));
  }
  // a hold a dialog cut short has told its caller already (guard returned 'dialog')
  if (r === 'stopped' && !cut.aborted) throw stopped('the hold ended (everything held was let go)');
}

/**
 * Runs an input action; a dialog opening under it ends the wait (the input can't finish until it is answered), and
 * aborts the signal `work` gets, so a hold lets go instead of holding on after its action has returned.
 * @param {BrowserTabs} host
 * @param {(cut: AbortSignal) => Promise<unknown>} work
 */
async function guard(host, tab, work) {
  const blocked = whenBlocked(host, tab);
  const cut = new AbortController();
  const p = Promise.resolve().then(() => work(cut.signal));
  try {
    const r = await Promise.race([p.then(() => 'done'), blocked.promise]);
    // the dialog won: the input finishes once it is answered, and a failure then has no caller left to tell
    if (r === 'dialog') {
      cut.abort();
      p.catch((error) => noteIgnored('finish an input action a dialog interrupted', error));
    }
    return r;
  } finally {
    blocked.cancel();
  }
}

/**
 * Resolves when a dialog or file chooser opens on the tab; `cancel` drops the wait.
 * @param {BrowserTabs} host
 */
function whenBlocked(host, tab) {
  let waiter;
  const promise = new Promise((resolve) => {
    waiter = () => resolve('dialog');
    tab.dialogWaiters.add(waiter);
  });
  return { promise, cancel: () => tab.dialogWaiters.delete(waiter) };
}

/**
 * Shows the action on the page (agentCursor.cjs, when given) and waits for its pointer to arrive, so the input lands
 * under it; a call stopped meanwhile (Stop, Esc, the turn's end) acts no more. Bounded; the cursor never fails it.
 * @param {BrowserTabs} host
 */
async function show(host, tab, action) {
  if (!host.o.cursor) return;
  await host.o.cursor.act(tab, action);
  checkAct(`the ${action.kind} in the browser`);
}

module.exports = { HostInput, whenBlocked };
