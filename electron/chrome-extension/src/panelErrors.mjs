// Side-panel errors and independently retained failed input; ordinary notices cannot erase a recoverable message. The error is a banner above the
// composer: the text, a Retry link when the failed action is one the panel can run again, and a dismiss X.
import { reconcile } from './panelNodes.mjs';
export const CHAT_GONE = 'panel_chat_gone';
export const CHAT_GONE_TEXT = "That chat isn't in MoPilot.";

/** Recovery belongs to this panel document until explicit dismissal; changing chats or notices does not retire it. */
export class PanelErrors {
  constructor(document) {
    this.document = document;
    this.root = document.getElementById('error');
    this.notice = document.createElement('p');
    this.recoveries = new Set();
    /** @type {(() => unknown) | null} what Retry runs: the failed action, offered only by the one that knows it is safe to run again */
    this.retry = null;
    this.line = document.createElement('div');
    this.line.className = 'banner-line';
    this.again = this.#button('banner-retry', 'Retry');
    this.again.addEventListener('click', () => this.#retry());
    this.off = this.#button('banner-dismiss', '');
    this.off.setAttribute('aria-label', 'Dismiss error');
    this.off.addEventListener('click', () => this.show(''));
  }

  #button(className, text) {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    return button;
  }

  /** Retry: the banner goes first, so a second press cannot run the action twice; the action reports its own failure. */
  #retry() {
    const act = this.retry;
    if (!act) return;
    this.show('');
    void Promise.resolve()
      .then(act)
      .catch((e) => this.show(String(e?.message ?? e)));
  }

  /** @param {string} message @param {() => unknown} [retry] runs the failed action again; shown as Retry */
  show(message, retry) {
    this.retry = message && typeof retry === 'function' ? retry : null;
    this.notice.textContent = message;
    this.line.replaceChildren(this.notice, ...(this.retry ? [this.again] : []), this.off);
    reconcile(this.root, [...(message ? [this.line] : []), ...this.recoveries]);
    this.root.hidden = !message && !this.recoveries.size;
  }

  /** @param {string} reason @param {string} text @param {boolean} inComposer the text is back in the box @param {() => unknown} [retry] */
  failed(reason, text, inComposer, retry) {
    if (inComposer) return this.show(reason, retry);
    const block = this.document.createElement('details');
    block.className = 'message-recovery';
    block.open = true;
    const title = this.document.createElement('summary');
    title.textContent = 'Message needs review';
    const why = this.document.createElement('p');
    why.textContent = reason;
    const input = this.document.createElement('pre');
    input.textContent = `Message: ${text}`;
    const copy = this.document.createElement('button');
    copy.type = 'button';
    copy.className = 'message-copy';
    copy.dataset.panelCopy = text;
    copy.dataset.copyState = copy.dataset.copyIdle = 'Copy message';
    copy.setAttribute('aria-label', 'Copy retained message');
    const dismiss = this.document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      this.recoveries.delete(block);
      this.show(this.notice.textContent, this.retry ?? undefined);
    });
    block.append(title, why, input, copy, dismiss);
    this.recoveries.add(block);
    this.show(this.notice.textContent, this.retry ?? undefined);
  }
}

/** Panel persistence failures keep the real recoverable reason, including an oversized draft. */
export function reportPanelError(what, error, show) {
  console.warn('MoPilot:', what, error);
  show(
    error instanceof Error
      ? error.message
      : "This tab's chat could not be saved or restored. Keep this panel open; choose the chat again to retry.",
  );
}
