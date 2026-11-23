// The side panel's Retry under a chat's last reply (panelThread.mjs): which message it sends again, and the one button that moves to the newest reply.
//
// Retry sends the user message the last reply answers once more, as a message of its own, through the panel's send
// (sidePanel.mjs). It is there only while the chat is idle, and only for a message the panel holds whole: one main
// clipped (`truncated`) would go out shorter than it was written.

/**
 * The last reply and the message it answers, or null when there is nothing to send again: no reply, a message sent
 * after it (that one is the newer turn's), or a message that is empty or clipped.
 * @param {{ role: string, text: string, truncated?: boolean }[]} rows the chat's rows, then the messages sent from here that none has yet
 * @returns {{ index: number, text: string } | null}
 */
export function retryTarget(rows) {
  const index = rows.findLastIndex((r) => r.role === 'assistant');
  if (index < 0 || rows.slice(index + 1).some((r) => r.role === 'user')) return null;
  const message = rows.slice(0, index).findLast((r) => r.role === 'user');
  if (!message || message.truncated || !message.text.trim()) return null;
  return { index, text: message.text };
}

/** Whether Retry may send `text` now: the chat is idle and no copy of it is already waiting to be written. */
export const mayRetry = (/** @type {string} */ state, /** @type {string[]} */ sent, /** @type {string} */ text) =>
  state === 'idle' && !sent.includes(text);

/** The one Retry button: beside the Copy of the last reply, disabled while a turn runs. */
export class RetrySlot {
  /** @param {any} doc */
  constructor(doc) {
    const button = doc.createElement('button');
    button.type = 'button';
    // the look and the hover of the reply's Copy; its label is drawn by the stylesheet
    button.className = 'message-copy message-retry';
    button.setAttribute('aria-label', 'Retry');
    button.title = 'Send your last message again';
    this.button = button;
    /** @type {any} the reply the button is in */
    this.host = null;
  }

  /**
   * Puts the button after the Copy in `host`, for `text`; with no `host` it leaves the chat.
   * @param {any} host @param {string | undefined} text @param {boolean} busy a turn runs: nothing to retry yet
   */
  place(host, text, busy) {
    if (this.host !== host) {
      this.host?.removeChild(this.button);
      this.host = host;
      host?.append(this.button);
    }
    this.button.dataset.panelRetry = text ?? '';
    this.button.disabled = busy;
  }
}
