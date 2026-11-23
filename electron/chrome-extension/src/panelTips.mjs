// The side panel's empty-state tip cycle: a new chat's message box shows its greeting, then a tip, then the next, one every 3000 ms; the old line leaves (up 6px, fading) and the new one comes (from 6px below), 0.2 s each, ease-in-out. It is drawn over the box (an overlay that takes no clicks) and shows only while a new chat's box is empty and its composer is in front: it stops, timers included, once a chat opens, text is typed, the composer or the document is hidden, and starts again from the greeting. Under prefers-reduced-motion the line changes at once. The lines go in as text only. Which tips show is decided here: only what this panel does ("/" commands and the "@" mention).
import { PLACEHOLDER } from './panelConnection.mjs';

/** The lines in turn: the greeting (the box's own placeholder, kept as its accessible hint), then the tips; each is true of this panel. */
export const TIPS = Object.freeze([PLACEHOLDER.new, 'Use / for commands', 'Type @ to mention a tab or chat']);

/** A line stays 3000 ms, counted from one change to the next. */
export const TIP_MS = 3000;

/** The leave and the enter each take 0.2 s, ease-in-out; the stylesheet's keyframes use the same. */
export const SWAP_MS = 200;

export class PanelTips {
  /** @param {any} g the panel's window: its document, its timers, matchMedia */
  constructor(g) {
    this.g = g;
    this.doc = g.document;
    this.text = this.doc.getElementById('text');
    this.tip = this.doc.getElementById('tip');
    this.composer = this.doc.getElementById('composer');
    /** @type {boolean} whether the panel's chat is a new one */
    this.isNew = false;
    this.index = 0;
    /** @type {any} the wait for the next line */
    this.timer = null;
    /** @type {any} the leave or the enter of one change */
    this.swap = null;
    // a hidden panel does not cycle; it carries on when it is shown again
    this.doc.addEventListener('visibilitychange', () => this.sync(this.isNew));
    // the page going away takes its timers with it (a page kept for later starts again with its next sync)
    g.addEventListener?.('pagehide', () => this.stop());
  }

  /**
   * Brings the box's placeholder and the cycle in line with the panel: call it whenever the chat, the composer or the text may have changed.
   * Safe to repeat: a cycle that is going on is left alone (its interval does not restart).
   */
  sync(/** @type {boolean} */ isNew) {
    const { text, tip } = this;
    this.isNew = isNew;
    text.placeholder = isNew ? PLACEHOLDER.new : PLACEHOLDER.reply;
    const shown = isNew && !this.composer.hidden && !text.value;
    if (shown !== !tip.hidden) {
      // shown or hidden now: it begins again at the greeting
      this.index = 0;
      this.settle();
      tip.hidden = !shown;
      // the box's own placeholder is hidden while the overlay draws the line in its place
      if (shown) text.dataset.tips = '';
      else delete text.dataset.tips;
    }
    if (shown && !this.doc.hidden) {
      if (this.timer == null) this.timer = this.g.setTimeout(() => this.advance(), TIP_MS);
    } else this.stop();
  }

  advance() {
    const { tip } = this;
    this.index = (this.index + 1) % TIPS.length;
    this.timer = this.g.setTimeout(() => this.advance(), TIP_MS);
    if (this.g.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      tip.textContent = TIPS[this.index];
      return;
    }
    tip.dataset.phase = 'out';
    this.swap = this.g.setTimeout(() => {
      tip.textContent = TIPS[this.index];
      tip.dataset.phase = 'in';
      this.swap = this.g.setTimeout(() => this.settle(), SWAP_MS);
    }, SWAP_MS);
  }

  /** Ends a change in progress: the line meant to show shows, with no motion left. */
  settle() {
    this.g.clearTimeout(this.swap);
    this.swap = null;
    delete this.tip.dataset.phase;
    // written only when it differs: a panel that syncs often must not rewrite a line that is already right
    if (this.tip.textContent !== TIPS[this.index]) this.tip.textContent = TIPS[this.index];
  }

  /** Nothing waits: no next line is due, and a change half-way is finished. */
  stop() {
    this.g.clearTimeout(this.timer);
    this.timer = null;
    this.settle();
  }
}
