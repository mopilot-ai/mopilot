// Minimal Chrome-panel navigation, deliberate clipboard actions, scroll recovery and elapsed time observed in this panel.
import { PanelBanners } from './panelBanners.mjs';
import { Dismissals, PanelRefusal, expiryWait, warningBanner } from './panelSignals.mjs';

export class PanelChrome {
  constructor(g) {
    this.g = g;
    this.doc = g.document;
    this.$ = (id) => this.doc.getElementById(id);
    this.now = g.now ?? Date.now;
    this.started = null;
    this.chat = null;
    this.timer = null;
    this.listeners = [];
    this.dismissedLimit = new Dismissals();
    this.lastLimit = null;
    /** @type {any} the wait until the usage warning on show stops holding */
    this.warnTimer = null;
    this.follow = true;
    this.scrollChat = null;
    this.copyRevision = 0;
    this.copyTimers = new Map();
    // the error, the usage limit and the tab note share one slot above the composer: one shows at a time
    this.banners = new PanelBanners(g);
    const listen = (target, event, fn, capture = false) => {
      target.addEventListener(event, fn, capture);
      this.listeners.push(() => target.removeEventListener(event, fn, capture));
    };
    this.refusal = new PanelRefusal(g, listen);
    listen(this.$('more'), 'click', () => this.menu(this.$('header-menu').hidden));
    listen(this.$('more-settings'), 'click', () => {
      this.menu(false);
      this.$('side-settings').click();
    });
    listen(this.$('more-tasks'), 'click', () => {
      this.menu(false);
      if (this.$('sidebar').hidden) this.$('side').click();
      this.$('tasks').scrollIntoView({ block: 'start' });
    });
    listen(this.doc, 'pointerdown', (e) => {
      if (!this.$('header-menu').contains(e.target) && !this.$('more').contains(e.target)) this.menu(false);
    });
    listen(this.doc, 'keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') this.menu(false);
    });
    listen(this.$('app'), 'click', () => this.menu(false));
    listen(this.$('usage-off'), 'click', () => {
      this.dismissedLimit.add(this.lastLimit);
      this.limit();
    });
    listen(this.$('chat'), 'scroll', () => {
      const box = this.$('chat');
      this.follow = box.scrollHeight - box.scrollTop - box.clientHeight <= 80;
      this.scroll();
    });
    listen(this.$('rows'), 'toggle', () => this.scroll(), true);
    listen(this.$('rows'), 'click', (event) => {
      if (event.target.closest?.('summary')) this.follow = false;
    });
    listen(this.$('jump'), 'click', () => {
      this.follow = true;
      this.$('chat').scrollTo({ top: this.$('chat').scrollHeight, behavior: 'auto' });
    });
    listen(this.doc, 'click', (e) => {
      const button = e.target.closest?.('[data-panel-copy]');
      if (button) void this.copy(button);
    });
    this.observer = new g.MutationObserver(() => {
      this.layout();
      this.activity();
      this.limit();
      this.refusal.update();
    });
    this.observer.observe(this.$('rows'), { childList: true, subtree: true });
    this.observer.observe(this.$('live'), { childList: true, characterData: true, subtree: true });
    this.observer.observe(this.$('cards'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    this.observer.observe(this.$('progress-text'), { childList: true, subtree: true });
    this.observer.observe(this.$('chat'), {
      attributes: true,
      attributeFilter: [
        'data-chat-id',
        'data-limit-key',
        'data-limit-text',
        'data-warning',
        'data-refusal-key',
        'data-turn',
        'data-turn-start',
        'hidden',
      ],
    });
    this.resize = g.ResizeObserver ? new g.ResizeObserver(() => this.layout()) : null;
    this.resize?.observe(this.$('composer'));
    this.resize?.observe(this.$('pin-tip'));
    this.layout();
    this.activity();
    this.limit();
    this.refusal.update();
  }

  /**
   * The usage banner: the account's limit when main said it is reached (its text), else the harness's warning that a window is nearly used up
   * (dismissible; it goes by itself when the window resets).
   */
  limit() {
    const chat = this.$('chat');
    const reached = chat.dataset.limitKey ? JSON.stringify([chat.dataset.chatId, chat.dataset.limitKey]) : null;
    const warning = reached ? null : warningBanner(chat.dataset.warning, this.now());
    const key = reached ?? (warning ? JSON.stringify([chat.dataset.chatId, 'approaching', warning.key]) : null);
    this.lastLimit = key;
    this.$('usage').hidden = chat.hidden || !key || this.dismissedLimit.has(key);
    this.$('usage').dataset.kind = warning ? 'approaching' : 'reached';
    this.$('usage-text').textContent = warning ? warning.text : (chat.dataset.limitText ?? '');
    this.g.clearTimeout(this.warnTimer);
    this.warnTimer = warning?.until == null ? null : this.g.setTimeout(() => this.limit(), expiryWait(warning.until, this.now()));
  }

  menu(open) {
    this.$('header-menu').hidden = !open;
    this.$('more').setAttribute('aria-expanded', String(open));
  }

  scroll() {
    const box = this.$('chat');
    this.$('jump').hidden = box.hidden || box.scrollHeight - box.scrollTop - box.clientHeight <= 80;
    this.$('jump').style.bottom =
      `${Math.max(8, this.doc.documentElement.clientHeight - this.$('composer').getBoundingClientRect().top + 8)}px`;
  }

  layout() {
    const box = this.$('chat');
    if (this.scrollChat !== box.dataset.chatId) {
      this.scrollChat = box.dataset.chatId;
      this.follow = true;
    }
    if (this.follow && !box.hidden && !this.$('cards').querySelector('.holding')) box.scrollTop = box.scrollHeight;
    this.scroll();
  }

  activity() {
    const chat = this.$('chat').dataset.chatId;
    if (chat !== this.chat) {
      this.started = null;
      this.chat = chat;
      this.copyRevision++;
      this.$('copy-notice').textContent = '';
    }
    const running =
      this.$('progress-dot').classList.contains('wait') && ['Working…', 'Using your Chrome'].includes(this.$('progress-text').textContent);
    this.g.clearTimeout(this.timer);
    this.timer = null;
    if (!running || this.$('chat').hidden) {
      this.started = null;
      this.$('elapsed').textContent = '';
      this.$('activity-count').textContent = '';
      this.$('activity-thumbnail').hidden = true;
      this.$('activity-thumbnail').removeAttribute('src');
      return;
    }
    const now = this.now();
    // from the turn's own start when MoPilot could say it (PanelThread.read), else from when this panel first saw it run
    const own = Number(this.$('chat').dataset.turnStart);
    this.started = own > 0 ? Math.min(own, now) : (this.started ?? now);
    this.$('elapsed').textContent = `Watching ${Math.max(0, Math.floor((now - this.started) / 1000))}s`;
    /** @type {any} */
    let latest = null;
    for (const el of this.$('rows').children) {
      if (el.classList.contains('you')) latest = null;
      else if (el.classList.contains('steps') || el.classList.contains('step')) latest = el;
    }
    const count = latest?.classList.contains('step') ? 1 : latest ? latest.querySelectorAll('.step:not(summary)').length : 0;
    const label =
      latest?.dataset.surface === 'chrome' || latest?.querySelector('[data-surface="chrome"]') ? 'Using your Chrome' : 'Working…';
    if (this.$('progress-text').textContent !== label) this.$('progress-text').textContent = label;
    const screenshot = latest?.querySelector('.step-thumbnail');
    this.$('activity-thumbnail').hidden = !screenshot;
    if (screenshot) {
      if (this.$('activity-thumbnail').src !== screenshot.src) this.$('activity-thumbnail').src = screenshot.src;
    } else this.$('activity-thumbnail').removeAttribute('src');
    this.$('activity-count').textContent = count > 1 ? `+${count - 1}` : '';
    this.timer = this.g.setTimeout(() => this.activity(), 1000);
  }

  async copy(button) {
    const chat = this.$('chat').dataset.chatId;
    const revision = ++this.copyRevision;
    const current = () => this.$('chat').dataset.chatId === chat && revision === this.copyRevision;
    try {
      if (!this.g.navigator.clipboard?.writeText) throw new Error('Copy is unavailable in this browser.');
      await this.g.navigator.clipboard.writeText(button.dataset.panelCopy);
      if (!current()) return;
      button.dataset.copyState = button.dataset.copyDone ?? 'Copied';
      this.$('copy-notice').textContent = button.dataset.copyState;
      this.g.clearTimeout(this.copyTimers.get(button));
      this.copyTimers.set(
        button,
        this.g.setTimeout(() => {
          button.dataset.copyState = button.dataset.copyIdle ?? 'Copy';
          this.copyTimers.delete(button);
          if (current()) this.$('copy-notice').textContent = '';
        }, 2000),
      );
    } catch (error) {
      if (!current()) return;
      this.$('copy-notice').textContent = String(error?.message ?? error ?? 'Copy failed');
    }
  }

  close() {
    this.copyRevision++;
    for (const timer of this.copyTimers.values()) this.g.clearTimeout(timer);
    this.copyTimers.clear();
    this.g.clearTimeout(this.timer);
    this.g.clearTimeout(this.warnTimer);
    this.observer.disconnect();
    this.banners.close();
    this.resize?.disconnect();
    for (const remove of this.listeners) remove();
  }
}
