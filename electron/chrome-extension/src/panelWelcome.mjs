// Side-panel onboarding and toolbar pin tip; scheduled tasks live in the history sidebar, reached through More.

/** What the panel keeps once each is done. */
export const SEEN = Object.freeze({ consent: 'panelConsent', intro: 'panelIntro', pinTip: 'panelPinTip' });

/** The risks the consent names, before the first chat from the panel. */
export const RISKS = Object.freeze([
  { title: 'Agents act in your Chrome', text: 'They open pages, click and type in the tabs they use, signed in as you.' },
  {
    title: 'Pages can try to steer them',
    text: 'A site can hide instructions meant for the agent. Watch what it does on sites you don’t trust.',
  },
  { title: 'Agents can make mistakes', text: 'Check purchases, messages and other actions that matter before they go through.' },
]);

/** The intro's slides. */
export const SLIDES = Object.freeze([
  { title: 'Chat from Chrome', text: 'Ask about the page you’re on. The chat is the same one in MoPilot.' },
  { title: 'A tab group per chat', text: 'Tabs an agent opens stay together in a group named for its chat.' },
]);

export class PanelWelcome {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {any} o.chrome
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {(page: string) => void} o.onOpen opens MoPilot at a page
   * @param {() => void} o.onChange a step started or ended (the panel shows what follows)
   * @param {() => Date} [o.now]
   */
  constructor(o) {
    this.o = o;
    /** @type {'consent' | 'intro' | null} the step in front of the chat, until it's done */
    this.step = null;
    this.slide = 0;
    /** read from storage once */
    this.ready = false;
    const $ = (/** @type {string} */ id) => o.document.getElementById(id);
    this.$ = $;
    $('consent-ok').addEventListener('click', () => void this.done(SEEN.consent));
    $('intro-next').addEventListener('click', () => {
      if (this.slide < SLIDES.length - 1) {
        this.slide++;
        this.render();
      } else void this.done(SEEN.intro);
    });
    $('pin-off').addEventListener('click', () => {
      $('pin-tip').hidden = true;
      void this.keep(SEEN.pinTip);
    });
    // pinned while the tip shows: it goes (Chrome 130+ tells; older ones keep it until dismissed)
    o.chrome.action?.onUserSettingsChanged?.addListener((/** @type {any} */ s) => {
      if (s?.isOnToolbar) $('pin-tip').hidden = true;
    });
  }

  /** What still needs showing, read once. */
  async start() {
    // storage that can't be read shows the steps again: safer than skipping the consent
    const seen =
      (await Promise.resolve(this.o.chrome.storage.local.get(Object.values(SEEN))).catch((/** @type {unknown} */ error) => {
        console.warn("MoPilot: couldn't read what the panel has shown:", error);
        return null;
      })) ?? {};
    this.step = !seen[SEEN.consent] ? 'consent' : !seen[SEEN.intro] ? 'intro' : null;
    this.pinTipDone = !!seen[SEEN.pinTip];
    this.ready = true;
    this.render();
    this.o.onChange();
  }

  /** Whether a step stands before the chat, or may (not read yet): the composer waits. */
  get blocking() {
    return !this.ready || this.step !== null;
  }

  async keep(/** @type {string} */ key) {
    await Promise.resolve(this.o.chrome.storage.local.set({ [key]: true })).catch((/** @type {unknown} */ error) =>
      console.warn(`MoPilot: couldn't keep ${key}:`, error),
    );
  }

  /** A step done: kept, and the next one shown. */
  async done(/** @type {string} */ key) {
    this.step = key === SEEN.consent ? 'intro' : null;
    this.slide = 0;
    this.render();
    this.o.onChange();
    await this.keep(key);
  }

  render() {
    const { document } = this.o;
    const $ = this.$;
    $('welcome').hidden = !this.step;
    $('consent').hidden = this.step !== 'consent';
    $('intro').hidden = this.step !== 'intro';
    if (this.step === 'consent')
      $('risks').replaceChildren(
        ...RISKS.map((r) => {
          const li = document.createElement('li');
          const b = document.createElement('strong');
          b.textContent = r.title;
          const p = document.createElement('span');
          p.textContent = r.text;
          li.append(b, p);
          return li;
        }),
      );
    if (this.step === 'intro') {
      const s = SLIDES[this.slide];
      $('intro-title').textContent = s.title;
      $('intro-text').textContent = s.text;
      $('intro-dots').textContent = SLIDES.map((_x, i) => (i === this.slide ? '●' : '○')).join(' ');
      $('intro-next').textContent = this.slide < SLIDES.length - 1 ? 'Next' : 'Let’s go';
    }
  }

  /** The pin tip, while the extension isn't on the toolbar and the tip wasn't dismissed. */
  async pinTip() {
    if (this.pinTipDone) return;
    const s = await Promise.resolve(this.o.chrome.action?.getUserSettings?.()).catch((/** @type {unknown} */ error) => {
      console.warn("MoPilot: couldn't read whether it is on the toolbar:", error);
      return null;
    });
    this.$('pin-tip').hidden = s?.isOnToolbar !== false;
  }
}
