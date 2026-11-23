// The settings page's tabs (#1986), as Claude in Chrome's: Connection (with "Name this Chrome"), Site permissions (the sites MoPilot saved for this Chrome, with Revoke) and Shortcuts.
//
// The name and the sites are MoPilot's (the pairing, and Chrome's site table in the app), read and changed through
// the connection (electron/app/chromeBrowserSettings.cjs); while it is down the tabs say so. One change runs at a time,
// and a read that an earlier change or tab overtook is dropped.

export const TABS = ['connection', 'sites', 'shortcuts'];
/** Chrome's own page for extension shortcuts: Chrome lets only the user change one there. */
export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';
export const NAME_MAX = 80;
/** How a saved site's level reads, as Settings → Browser in the app says it. */
export const LEVEL_TEXT = Object.freeze({ read: 'Read only', write: 'Read and write' });
/** The command that opens the side panel (manifest.json, Cmd/Ctrl+E as Claude's). */
export const OPEN_COMMAND = '_execute_action';

/** The settings MoPilot answered, or null when they aren't its shape. */
export function settingsOf(/** @type {any} */ result) {
  if (!result || !Array.isArray(result.sites) || (result.name !== null && typeof result.name !== 'string')) return null;
  const sites = result.sites.filter((/** @type {any} */ s) => typeof s?.origin === 'string' && Object.hasOwn(LEVEL_TEXT, s.level));
  return { name: result.name ?? '', sites };
}

export class OptionsTabs {
  /** @param {any} o the page's window (`g`: document, chrome) */
  constructor(o) {
    this.o = o;
    /** the latest read or change: an answer it overtook is dropped */
    this.generation = 0;
    /** a change under way: its buttons are off until it is done */
    this.busy = false;
    /** @type {any[]} the sites' Revoke buttons */
    this.revokes = [];
    /** the tab shown */
    this.current = TABS[0];
    const $ = this.$;
    this.tabs = TABS.map((name) => $(`${name}-tab`));
    this.tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => void this.select(TABS[i]));
      // the arrows, Home and End move between tabs (the ARIA tabs pattern)
      tab.addEventListener('keydown', (/** @type {any} */ e) => {
        const n = TABS.length;
        const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        this.tabs[to].focus();
        void this.select(TABS[to]);
      });
    });
    $('name-form').addEventListener('submit', (/** @type {any} */ e) => {
      e.preventDefault();
      void this.rename();
    });
    $('shortcuts-open').addEventListener('click', () => {
      Promise.resolve(o.chrome.tabs.create({ url: SHORTCUTS_PAGE })).catch((/** @type {any} */ e) => this.#error(e));
    });
  }

  $ = (/** @type {string} */ id) => this.o.document.getElementById(id);

  /** Shows a tab and reads what it shows. */
  select(/** @type {string} */ name) {
    const at = Math.max(0, TABS.indexOf(name));
    this.tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === at));
      tab.tabIndex = i === at ? 0 : -1;
      this.$(TABS[i]).hidden = i !== at;
    });
    this.#error(null);
    this.current = TABS[at];
    return this.current === 'shortcuts' ? this.shortcut() : this.load();
  }

  /** The shortcut Chrome has for opening the panel: none when another extension or Chrome took the key. */
  async shortcut() {
    try {
      const all = await this.o.chrome.commands.getAll();
      const key = all.find((/** @type {any} */ c) => c.name === OPEN_COMMAND)?.shortcut;
      this.$('shortcut').textContent = key || 'Not set';
    } catch (e) {
      this.#error(e);
    }
  }

  async rename() {
    const name = String(this.$('chrome-name').value).trim();
    if (!name || name.length > NAME_MAX) return this.#error(new Error(`Use a name of 1 to ${NAME_MAX} characters.`));
    return this.load({ name });
  }

  async revoke(/** @type {string} */ origin) {
    return this.load({ revoke: origin });
  }

  /**
   * Reads the name and sites from MoPilot, after making the change in `params` (a name, or a site to revoke).
   * @param {{ name?: string, revoke?: string }} [params]
   */
  async load(params = {}) {
    const change = Object.keys(params).length > 0;
    if (this.busy) return;
    const own = ++this.generation;
    this.busy = change;
    this.#controls(change);
    try {
      const r = await this.o.chrome.runtime.sendMessage({ type: 'panel', method: 'browserSettings', params });
      if (own !== this.generation) return;
      // not connected: the name waits (Connection's own line says why), and Site permissions says to connect
      const away = !!r?.error && r.status !== 'connected';
      this.$('name-form').hidden = away;
      if (away && this.current === 'connection') return this.#error(null);
      if (r?.error) throw new Error(away ? 'Connect to MoPilot to see these settings.' : r.error);
      const s = settingsOf(r?.result);
      if (!s) throw new Error("Couldn't read these settings. Try again.");
      this.#error(null);
      this.#show(s, change);
    } catch (e) {
      if (own === this.generation) this.#error(e);
    } finally {
      this.busy = false;
      this.#controls(false);
    }
  }

  #show(/** @type {{ name: string, sites: { origin: string, level: 'read' | 'write' }[] }} */ s, /** @type {boolean} */ changed) {
    const { document } = this.o;
    const input = this.$('chrome-name');
    // a name being typed stays; a saved one shows as saved
    if (changed || document.activeElement !== input) input.value = s.name;
    this.revokes = [];
    this.$('sites-list').replaceChildren(
      ...s.sites.map((site) => {
        const row = document.createElement('li');
        const origin = document.createElement('span');
        origin.textContent = site.origin;
        const level = document.createElement('span');
        level.className = 'hint';
        level.textContent = LEVEL_TEXT[site.level];
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.setAttribute('aria-label', `Revoke ${site.origin}`);
        revoke.addEventListener('click', () => void this.revoke(site.origin));
        this.revokes.push(revoke);
        row.append(origin, level, revoke);
        return row;
      }),
    );
    this.$('sites-empty').hidden = s.sites.length > 0;
  }

  #controls(/** @type {boolean} */ busy) {
    for (const b of [this.$('save-name'), ...this.revokes]) b.disabled = busy;
  }

  #error(/** @type {any} */ e) {
    this.$('settings-error').textContent = e ? String(e.message) : '';
    this.$('settings-error').hidden = !e;
  }
}
