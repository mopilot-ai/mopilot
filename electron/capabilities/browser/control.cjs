// Which browser channel agents get. A session sees one set of sage_browser_* tools: the built-in
// browser's, or Your Chrome's. Each channel has its own remote switch; with Your Chrome switched off
// agents fall back to the built-in browser.
const { noteIgnored } = require('../../ignored.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');
const { panelBrowserTools } = require('./tools.cjs');
const { chromeTools } = require('./extension.cjs');
const { ToolError } = require('../contract/registry.cjs');

const CHANNELS = ['builtin', 'chrome'];

// These schemas stay identical across channels. Running SDK/CLI sessions cache their tool schemas;
// replacing them with Playwright's schemas would strand an existing session after a handoff.
function chromeCoreTools(core, chrome) {
  const byName = new Map(chrome.map((t) => [t.name, t]));
  return core.map((tool) => ({
    ...tool,
    handler: async (args, ctx) => {
      let name = tool.name;
      let input = args;
      if (name === 'sage_browser_snapshot') input = {};
      if (name === 'sage_browser_screenshot') {
        name = 'sage_browser_take_screenshot';
        input = { type: 'png' };
      }
      const implementation = byName.get(name);
      if (!implementation) throw new ToolError('This Chrome tool is unavailable. Check Browser settings and reconnect.', 'unavailable');
      if (name === 'sage_browser_click' || name === 'sage_browser_type') {
        const modern = !!implementation.schema?.properties?.target;
        const target = args.ref || (modern ? args.selector : null);
        if (!target)
          throw new ToolError(
            'Take a fresh snapshot and use an element ref. This Chrome version does not support CSS selectors.',
            'bad_args',
          );
        input = {
          [modern ? 'target' : 'ref']: target,
          element: target,
          ...(name === 'sage_browser_type' ? { text: args.text, submit: !!args.submit } : {}),
        };
      }
      return implementation.handler(input, ctx);
    },
  }));
}

/**
 * The channel that runs: the one chosen, unless its switch is off. Where MoPilot's own extension serves the user's
 * Chrome (`ownChrome`), Chrome is reached through it (the chrome_* tools) and never through the Playwright Extension:
 * that relay retires there (design D5, "Retiring step 1"), and choosing Chrome is a preference the models are told.
 */
function effectiveChannel(chosen, isEnabled, ownChrome = false) {
  if (chosen === 'chrome' && !ownChrome && isEnabled('shared.browser.extension')) return 'chrome';
  return isEnabled('shared.browser.panelCdp') ? 'builtin' : null;
}

/** The Playwright tool list, kept on disk per @playwright/mcp version so a restart needn't start it. */
function schemaCache(file) {
  return {
    read() {
      try {
        const list = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(list) ? list : null;
      } catch {
        return null;
      }
    },
    write(list) {
      try {
        writeAtomic(file, JSON.stringify(list));
      } catch (error) {
        // the cache only saves a restart; the list is fetched again next time
        noteIgnored('save the Your Chrome tool list cache', error);
      }
    },
  };
}

class BrowserControl {
  /**
   * @param {{ registry: InstanceType<typeof import('../contract/registry.cjs').Registry>, grants: InstanceType<typeof import('./origins.cjs').OriginGrants>,
   *           chromeGrants: InstanceType<typeof import('./origins.cjs').OriginGrants>,
   *           panel: InstanceType<typeof import('./cdp.cjs').PanelBrowser>, chrome: InstanceType<typeof import('./extension.cjs').ChromeChannel>,
   *           isEnabled: (key: string) => boolean, cache?: { read(): any[] | null, write(list: any[]): void },
   *           ownChrome?: () => boolean }} o
   *   ownChrome: MoPilot's own extension serves the user's Chrome (chromeControl.cjs chromeToolsOn)
   */
  constructor(o) {
    this.o = o;
    this.active = null;
    /** the channel the last configure() asked for, set before its tools load ('chrome' while Your Chrome initializes) */
    this.wanted = null;
    this.offs = [];
    this.seq = 0;
  }

  /** Registers the chosen channel's tools in place of the current ones. Resolves to the channel that runs. */
  async configure(chosen) {
    const seq = ++this.seq;
    this.chosen = chosen;
    const want = effectiveChannel(CHANNELS.includes(chosen) ? chosen : 'builtin', this.o.isEnabled, this.o.ownChrome?.() === true);
    this.wanted = want;
    const core = panelBrowserTools({
      panel: this.o.panel,
      grants: this.o.grants,
      enabled: () => this.active !== 'chrome' && this.o.isEnabled('shared.browser.panelCdp'),
    });
    let defs = [];
    if (want === 'chrome') {
      if (!this.offs.length) {
        // Make the stable core visible to sessions that start while Chrome schemas load.
        // Do not silently send their operations to a different browser/profile.
        this.offs = core.map((tool) =>
          this.o.registry.register({
            ...tool,
            handler: async () => {
              throw new ToolError('Your Chrome is initializing. Try again shortly or check Browser settings.', 'unavailable');
            },
          }),
        );
      }
      const schemas = await this.#schemas().catch((error) => {
        // no tool list: Settings shows Your Chrome as unavailable, and its connection test says why
        noteIgnored('load the Your Chrome tool list', error);
        return null;
      });
      // a newer configure() won while the tool list loaded
      if (seq !== this.seq) return this.active;
      if (schemas?.length) {
        // the user's own Chrome keeps its own site table (D4): the in-app browser's grants never open a site there
        const chrome = chromeTools({
          channel: this.o.chrome,
          grants: this.o.chromeGrants,
          schemas,
          enabled: () => this.active === 'chrome' && this.o.isEnabled('shared.browser.extension'),
        });
        const adapted = chromeCoreTools(core, chrome);
        const names = new Set(adapted.map((t) => t.name));
        defs = [...adapted, ...chrome.filter((t) => !names.has(t.name))];
      }
    } else if (want === 'builtin') {
      defs = core;
    }
    for (const off of this.offs) off();
    this.offs = defs.map((t) => this.o.registry.register(t));
    if (want !== 'chrome') this.o.chrome.stopAll();
    this.active = defs.length ? want : null;
    return this.active;
  }

  /** Whether sage_browser_* tools reach the user's own Chrome (Your Chrome) rather than the built-in browser. */
  drivesUserChrome() {
    return this.wanted === 'chrome' || this.active === 'chrome';
  }

  /**
   * The user's Chrome as the models' note says it (surfaceNote.cjs): true while sage_browser_* drive it, 'preferred'
   * when the user chose Chrome and MoPilot's own extension serves it (the chrome_* tools), else false.
   * @returns {boolean | 'preferred'}
   */
  userChrome() {
    if (this.drivesUserChrome()) return true;
    return this.chosen === 'chrome' ? 'preferred' : false;
  }

  async #schemas() {
    const cached = this.o.cache?.read();
    if (cached && cached.length) return cached;
    const list = await this.o.chrome.tools();
    if (list.length) this.o.cache?.write(list);
    return list;
  }
}

module.exports = { BrowserControl, effectiveChannel, schemaCache, CHANNELS, chromeCoreTools };
