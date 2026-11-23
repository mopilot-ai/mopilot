// DEV ONLY: a small WebDriverAgent client for the iOS journey: finds elements of our own app by accessibility label, taps, types, waits and takes screenshots.
import fs from 'node:fs/promises';
import path from 'node:path';

const PAUSE = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A string as an NSPredicate literal. */
const quote = (/** @type {string} */ text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The point of an element a tap goes to: near its top-left corner. That is on screen whenever any of the element is (a field at the foot of a scrolled screen is cut off at its middle),
 * and clear of a dev client's floating gear, which sits over the top right of the screen and takes taps up to about 30 pt left of the middle of the buttons beside it.
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
export function tapPoint(rect) {
  return { x: Math.round(rect.x + Math.min(rect.width / 2, 10)), y: Math.round(rect.y + Math.min(rect.height / 2, 14)) };
}

/** Every label on the screen, from a WebDriverAgent JSON source tree. */
export function labelsOf(/** @type {any} */ node, found = /** @type {string[]} */ ([])) {
  if (typeof node.label === 'string' && node.label) found.push(node.label);
  for (const child of node.children ?? []) labelsOf(child, found);
  return found;
}

/** The first node of a WebDriverAgent JSON tree (depth first, the node itself included) that the test accepts. */
export function findNode(/** @type {any} */ node, /** @type {(n: any) => boolean} */ accepts) {
  if (accepts(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, accepts);
    if (found) return found;
  }
  return null;
}

/** The labels of the buttons that accept one of our app's own system dialogs (sign-in consent, notification permission, the dev client's open prompt). */
const ACCEPT = ['Continue', 'Allow', 'Open'];

/** The center of a node's rectangle. */
const centerOf = (/** @type {{ x: number, y: number, width: number, height: number }} */ r) => ({
  x: Math.round(r.x + r.width / 2),
  y: Math.round(r.y + r.height / 2),
});

export class Wda {
  /**
   * @param {{ base: string, bundleId: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number }} o
   */
  constructor({ base, bundleId, fetchImpl = fetch, sleep = PAUSE, now = Date.now }) {
    this.base = base.replace(/\/$/, '');
    this.bundleId = bundleId;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    /** @type {string | null} */
    this.session = null;
  }

  /** @param {string} method @param {string} route @param {unknown} [body] */
  async call(method, route, body) {
    const res = await this.fetch(this.base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // a device that is locked or gone answers nothing: fail the step, do not wait minutes for it
      signal: AbortSignal.timeout(60_000),
    });
    let json;
    try {
      json = await res.json();
    } catch (error) {
      throw new Error(`WebDriverAgent ${method} ${route}: ${res.status}, not JSON (${/** @type {Error} */ (error).message})`);
    }
    if (!res.ok || json.value?.error) throw new Error(`WebDriverAgent ${method} ${route}: ${json.value?.message ?? res.status}`);
    return json;
  }

  /** A fresh session on our app; a relaunched app needs a new one. */
  async open() {
    const made = await this.call('POST', '/session', { capabilities: { alwaysMatch: { bundleId: this.bundleId } } });
    this.session = made.sessionId ?? made.value.sessionId;
    // a person types slowly; at WebDriverAgent's default speed a real device's controlled fields lose keystrokes ("discount" arrived as "dount")
    await this.call('POST', this.s('/appium/settings'), { settings: { maxTypingFrequency: 8 } });
    return this;
  }

  /** @param {string} route */
  s(route) {
    return `/session/${this.session}${route}`;
  }

  /** The first element whose accessibility id is the label, else whose label or name contains it (with the same capitals: ", Connected" must not match "Your chats, connected to your computer."); null when there is none. With `exact` only the id counts ("Settings" the tab, not a sentence that has the word). */
  async find(/** @type {string} */ label, { exact = false } = {}) {
    for (const [using, value] of [
      ['accessibility id', label],
      ['predicate string', `label CONTAINS ${quote(label)} OR name CONTAINS ${quote(label)}`],
    ].slice(0, exact ? 1 : 2)) {
      let found;
      try {
        found = (await this.call('POST', this.s('/elements'), { using, value })).value;
      } catch (error) {
        // a label that changes while WebDriverAgent looks (a streaming reply) is "not there yet", not a failure; the waiting loops ask again
        if (/no longer|not present in the current view|stale/i.test(/** @type {Error} */ (error).message)) return null;
        throw error;
      }
      if (found.length) return /** @type {string} */ (found[0].ELEMENT ?? Object.values(found[0])[0]);
    }
    return null;
  }

  async has(/** @type {string} */ label, /** @type {{ exact?: boolean }} */ o = {}) {
    return (await this.find(label, o)) !== null;
  }

  /** @param {string} label @param {{ timeoutMs?: number, intervalMs?: number }} [o] */
  async waitFor(label, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
    const end = this.now() + timeoutMs;
    for (;;) {
      const el = await this.find(label);
      if (el) return el;
      if (this.now() >= end) throw new Error(`"${label}" did not appear within ${timeoutMs / 1000}s`);
      await this.sleep(intervalMs);
    }
  }

  /** @param {string} label @param {{ timeoutMs?: number, intervalMs?: number }} [o] */
  async waitGone(label, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
    const end = this.now() + timeoutMs;
    while (await this.has(label)) {
      if (this.now() >= end) throw new Error(`"${label}" was still there after ${timeoutMs / 1000}s`);
      await this.sleep(intervalMs);
    }
  }

  /** Waits for the first of several labels and says which one came. @param {string[]} labels @param {{ timeoutMs?: number, intervalMs?: number, exact?: boolean }} [o] */
  async waitForAny(labels, { timeoutMs = 20_000, intervalMs = 500, exact = false } = {}) {
    const end = this.now() + timeoutMs;
    for (;;) {
      for (const label of labels) if (await this.has(label, { exact })) return label;
      if (this.now() >= end) throw new Error(`none of ${labels.map((l) => `"${l}"`).join(', ')} appeared within ${timeoutMs / 1000}s`);
      await this.sleep(intervalMs);
    }
  }

  /** Runs `then` when the label is on screen now, and does nothing when it is not. @param {string} label @param {() => Promise<void>} then @param {{ exact?: boolean }} [o] */
  async whenPresent(label, then, /** @type {{ exact?: boolean }} */ o = {}) {
    if (await this.has(label, o)) await then();
  }

  /** @param {string} label @param {{ timeoutMs?: number }} [o] */
  async tap(label, o) {
    const el = await this.waitFor(label, o);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const point = tapPoint(await this.settledRect(el));
      const top = await this.keyboardTop();
      if (top === null || point.y < top) return this.tapXY(point);
      // a point under the keyboard is usually a screen that has not finished moving up for it: look again before giving up
      await this.sleep(500);
    }
    // still under it: tapXY refuses with the reason
    return this.tapXY(tapPoint(await this.settledRect(el)));
  }

  /** An element's rectangle once it has stopped moving: right after a field takes focus the keyboard is still rising and the screen is moving, and a tap at the place read then lands on the keyboard. @param {string} el */
  async settledRect(el) {
    let rect = (await this.call('GET', this.s(`/element/${el}/rect`))).value;
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.sleep(250);
      const next = (await this.call('GET', this.s(`/element/${el}/rect`))).value;
      if (next.x === rect.x && next.y === rect.y && next.width === rect.width && next.height === rect.height) return next;
      rect = next;
    }
    return rect;
  }

  /** Taps the label and waits for what the tap should bring; a tap that did nothing (one lost while a sheet closes) is made again, up to `tries` times. @param {string} label @param {string} expected @param {{ tries?: number, timeoutMs?: number }} [o] */
  async tapUntil(label, expected, { tries = 3, timeoutMs = 5000 } = {}) {
    /** @type {unknown} */
    let last;
    for (let attempt = 1; attempt <= tries; attempt++) {
      await this.tap(label);
      try {
        return await this.waitFor(expected, { timeoutMs });
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  /** Throws unless our app is the one in front: a gesture by coordinates lands on whatever is, and this runner touches no other app. */
  async assertFront() {
    const front = (await this.call('GET', '/wda/activeAppInfo')).value.bundleId;
    if (front !== this.bundleId) throw new Error(`the app in front is ${front}, not ${this.bundleId}: not touching it`);
  }

  /** The top edge of the on-screen keyboard once it has stopped moving, or null when there is none: while it slides in its edge is still near the bottom of the screen, which makes a field under it look clear of it. */
  async keyboardTop() {
    /** @type {number | null} */
    let top = await this.keyboardEdge();
    for (let attempt = 0; top !== null && attempt < 8; attempt++) {
      await this.sleep(250);
      const next = await this.keyboardEdge();
      if (next === top) break;
      top = next;
    }
    return top;
  }

  /** The keyboard's top edge as it is this instant, or null. */
  async keyboardEdge() {
    const found = (await this.call('POST', this.s('/elements'), { using: 'class name', value: 'XCUIElementTypeKeyboard' })).value;
    if (!found.length) return null;
    const el = found[0].ELEMENT ?? Object.values(found[0])[0];
    try {
      return /** @type {number} */ ((await this.call('GET', this.s(`/element/${el}/rect`))).value.y);
    } catch (error) {
      // the keyboard went away between finding it and measuring it: there is none now
      if (/no longer|not present in the current view|stale/i.test(/** @type {Error} */ (error).message)) return null;
      throw error;
    }
  }

  async tapXY(/** @type {{ x: number, y: number }} */ { x, y }) {
    await this.assertFront();
    // the keyboard is drawn over the app: a tap under it types a letter instead of pressing what is there
    const top = await this.keyboardTop();
    if (top !== null && y >= top) throw new Error(`the point (${x}, ${y}) is under the keyboard (from ${top}): scroll it into view first`);
    await this.call('POST', this.s('/actions'), {
      actions: [
        {
          type: 'pointer',
          id: 'finger',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x, y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
  }

  /** A pull down from the band under the title (not the search field below it), which refreshes a list that has a pull-to-refresh control. */
  async pullDown() {
    await this.assertFront();
    await this.call('POST', this.s('/wda/dragfromtoforduration'), { fromX: 200, fromY: 160, toX: 200, toY: 650, duration: 0.5 });
  }

  /** Swipes up from the middle of the screen (above where a keyboard starts) until the label is well on screen: WebDriverAgent only sees what is visible, and an element lower than `maxBottom` (by default the keyboard's top edge, or 780 pt where the tab bar starts) is under something. Throws when it never comes. @param {string} label @param {{ maxSwipes?: number, maxBottom?: number | null }} [o] */
  async scrollTo(label, { maxSwipes = 24, maxBottom = null } = {}) {
    for (let swipes = 0; swipes <= maxSwipes; swipes++) {
      const el = await this.find(label);
      if (el) {
        const rect = (await this.call('GET', this.s(`/element/${el}/rect`))).value;
        // the limit is the keyboard's top edge when one is up (a card under it cannot be tapped), else the tab bar's
        const top = await this.keyboardTop();
        if (rect.y + rect.height <= (maxBottom ?? (top === null ? 780 : top - 20))) return;
      }
      await this.assertFront();
      await this.call('POST', this.s('/wda/dragfromtoforduration'), { fromX: 200, fromY: 520, toX: 200, toY: 160, duration: 0.4 });
    }
    throw new Error(`"${label}" did not come into view after ${maxSwipes} swipes`);
  }

  /** Keys into whatever has focus. */
  async type(/** @type {string} */ text) {
    await this.assertFront();
    await this.call('POST', this.s('/wda/keys'), { value: [...text] });
  }

  /** Replaces what a field holds, in one write (a pairing code is too long to type key by key). */
  async fill(/** @type {string} */ label, /** @type {string} */ text) {
    await this.tap(label);
    const active = (await this.call('GET', this.s('/element/active'))).value;
    const el = active.ELEMENT ?? Object.values(active)[0];
    await this.call('POST', this.s(`/element/${el}/clear`), {});
    await this.call('POST', this.s(`/element/${el}/value`), { text });
  }

  /** The label of the first element that matches, or null. */
  async labelOf(/** @type {string} */ label) {
    const el = await this.find(label);
    return el ? /** @type {string} */ ((await this.call('GET', this.s(`/element/${el}/attribute/label`))).value) : null;
  }

  /** Every label on screen. */
  async labels() {
    return labelsOf((await this.call('GET', this.s('/source?format=json'))).value);
  }

  async shot(/** @type {string} */ file) {
    const png = (await this.call('GET', this.s('/screenshot'))).value;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(png, 'base64'));
  }

  /** The text of an alert in front of our app's session, or null when there is none. */
  async alertText() {
    try {
      return String((await this.call('GET', this.s('/alert/text'))).value);
    } catch (error) {
      if (/no such alert|modal dialog/i.test(/** @type {Error} */ (error).message)) return null;
      throw error;
    }
  }

  /**
   * Accepts a dialog of ours: one in front of the app (the dev client's "Open in MoPilot?") or a system one that names it (the sign-in consent, which SpringBoard shows on a device).
   * An alert that does not name MoPilot is somebody else's and is refused. False when there is none.
   */
  async acceptAlert() {
    const text = await this.alertText();
    if (text === null) return this.acceptSystemAlert();
    if (!text.includes('MoPilot')) throw new Error(`an alert that is not ours is in front ("${text}"): not accepting it`);
    await this.call('POST', this.s('/alert/accept'), {});
    return true;
  }

  /** Which app this session reads and gestures on by default (WebDriverAgent keeps one session, so a second session would end ours); "auto" is the app under test. */
  async setActiveApplication(/** @type {string} */ bundleId) {
    await this.call('POST', this.s('/appium/settings'), { settings: { defaultActiveApplication: bundleId } });
  }

  /** A dialog SpringBoard shows for our app: the session reads SpringBoard for a moment, and a tap on the dialog's accept button answers it. Only a dialog that names MoPilot is touched. */
  async acceptSystemAlert() {
    await this.setActiveApplication('com.apple.springboard');
    try {
      const tree = (await this.call('GET', this.s('/source?format=json'))).value;
      const alert = findNode(tree, (n) => n.type === 'Alert' && String(n.label ?? '').includes('MoPilot'));
      const button = alert && findNode(alert, (n) => n.type === 'Button' && ACCEPT.includes(n.label));
      if (!button) return false;
      const { x, y } = centerOf(button.rect);
      await this.call('POST', this.s('/actions'), {
        actions: [
          {
            type: 'pointer',
            id: 'finger',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x, y },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 80 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      });
      return true;
    } finally {
      await this.setActiveApplication('auto');
    }
  }

  /** Sends the app to the background (the Home screen is not captured). */
  async background() {
    await this.call('POST', '/wda/homescreen', {});
  }

  /** Brings the app back to the front. */
  async foreground() {
    await this.call('POST', this.s('/wda/apps/activate'), { bundleId: this.bundleId });
  }
}
