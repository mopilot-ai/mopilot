// One banner at a time above the composer, in order of urgency: the error, then the refusal, then the usage limit, then the note about the tab in front.
// Each owner still shows and hides its own banner (panelErrors.mjs, panelChrome.mjs limit(), panelSignals.mjs, panelNotice.mjs); this only makes a lower one yield while a higher one shows.

/** The banners' ids, highest priority first. */
export const BANNERS = ['error', 'refusal', 'usage', 'notice'];

export class PanelBanners {
  /** @param {{ document: any, MutationObserver: any }} g the window (its document, and its MutationObserver) */
  constructor(g) {
    /** the banners this page has, in priority order */
    this.list = BANNERS.map((id) => g.document.getElementById(id)).filter(Boolean);
    this.observer = new g.MutationObserver(() => this.update());
    for (const banner of this.list) this.observer.observe(banner, { attributes: true, attributeFilter: ['hidden'] });
    this.update();
  }

  /** The first banner that is not hidden shows; each one below it yields (data-yielded: the stylesheet hides it, with the same 0.15 s fade). */
  update() {
    let shown = false;
    for (const banner of this.list) {
      banner.toggleAttribute('data-yielded', shown && !banner.hidden);
      shown ||= !banner.hidden;
    }
  }

  close() {
    this.observer.disconnect();
  }
}
