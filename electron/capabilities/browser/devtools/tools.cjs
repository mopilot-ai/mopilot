// The developer tools of the browser_* surface (and chrome_* over it): browser_perf_trace, browser_vitals, browser_accessibility_audit, browser_har and browser_record, each behind its tab's page gate, saving into the chat's upload folder.
//
// They sit in the deferred "devtools" tool group (toolTiers.cjs), so none of them adds to a session's fixed context.
// One DevtoolsHub per browser host (as the GIF recorder is one per host) keeps the chats' running recordings; a chat's
// turn end saves whatever is still running there, and the next call of that tool says where it went.
// Pages run code only in the isolated world WORLD (never the page's own), and read no field values.
const { ToolError } = require('../../contract/registry.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { tabArg } = require('../hostToolArgs.cjs');
const { oneLine } = require('../hostUtil.cjs');
const { freeFile } = require('./files.cjs');
const { fs } = require('../../../platform/ports/fs.cjs');
const { VideoRecorder } = require('./videoRecorder.cjs');
const { HarRecorder } = require('./harRecorder.cjs');
const { PerfTraces, insightText } = require('./perfTrace.cjs');
const { VITALS_SOURCE, vitalsText } = require('./vitals.cjs');
const { A11Y_AUDIT_SOURCE } = require('./a11yAudit.cjs');
const { REACT_SPECS, reactTool } = require('./react.cjs');

const WORLD = 'mopilot-devtools';
// the page tools' own tab argument: which tab, and what happens to a tab it opens
const TAB_ID = require('../hostToolSpecs.cjs').SPECS.browser_read_page.inputSchema.properties.tabId;
/** The file name a recording is saved under (letters, digits, ".", "-" and "_"); the default names the time. */
const FILENAME = (/** @type {string} */ when) => ({
  type: 'string',
  description: `For ${when}: the file name (letters, digits, ".", "-" and "_"); the default names the time.`,
});
const action = (/** @type {string[]} */ actions) => ({ type: 'string', enum: actions, description: 'What to do.' });

const DEVTOOLS_SPECS = Object.freeze({
  ...REACT_SPECS,
  browser_perf_trace: {
    policy: 'observe',
    description:
      "Record a Chrome performance trace of a tab. start begins (reload: true reloads the page first, to measure its load), stop saves the trace in this chat's upload folder (DevTools' Performance panel and Perfetto open it) and returns an insight summary: LCP, FCP, CLS, INP and long tasks. A trace ends by itself after 60 seconds or when the turn ends.",
    inputSchema: {
      type: 'object',
      properties: {
        action: action(['start', 'stop']),
        reload: { type: 'boolean', description: 'For start: reload the page once tracing runs.' },
        filename: FILENAME('start'),
        tabId: TAB_ID,
      },
      required: ['action'],
    },
  },
  browser_vitals: {
    policy: 'observe',
    description:
      "Read a tab's Core Web Vitals now: LCP, CLS and INP, with FCP, TTFB, load time and long tasks, each rated good, needs improvement or poor. INP needs an interaction first; for a load measurement use browser_perf_trace with reload.",
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'How long to listen for new entries first (default 250).' },
        tabId: TAB_ID,
      },
    },
  },
  browser_accessibility_audit: {
    policy: 'observe',
    description:
      "Audit a tab's page for accessibility problems (axe rule ids: image-alt, label, button-name, color-contrast, aria-*, heading-order and more), worst first, with a selector for each element. Field values are never read.",
    inputSchema: {
      type: 'object',
      properties: {
        rules: { type: 'array', items: { type: 'string' }, description: 'Only these rule ids.' },
        selector: { type: 'string', description: 'Only inside this element (a CSS selector).' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 50, description: 'Elements listed per rule (default 10).' },
        tabId: TAB_ID,
      },
    },
  },
  browser_har: {
    policy: 'observe',
    description:
      "Record this chat's network traffic as a HAR file. start begins with a tab (each tab you then use is recorded too), stop saves the HAR in this chat's upload folder. Cookies, auth headers and secret fields are REDACTED, and sign-in pages keep no bodies. It ends by itself when the turn ends.",
    inputSchema: {
      type: 'object',
      properties: { action: action(['start', 'stop']), filename: FILENAME('stop'), tabId: TAB_ID },
      required: ['action'],
    },
  },
  browser_record: {
    policy: 'observe',
    description:
      "Record a tab as a video (.mov). start begins, stop saves it in this chat's upload folder (attach it with browser_file_upload). Pages of high-risk sites, pages with a password field and sign-in are left out. It ends by itself after 10 minutes or when the turn ends.",
    inputSchema: {
      type: 'object',
      properties: { action: action(['start', 'stop']), filename: FILENAME('start'), tabId: TAB_ID },
      required: ['action'],
    },
  },
});

/** The chats' running recordings on one browser host; its turn ends save them. */
class DevtoolsHub {
  /** @param {{ tabs: any, riskOf: (url: string) => { level: string, credentials?: boolean }, images?: any }} o */
  constructor({ tabs, riskOf, images = null }) {
    this.video = new VideoRecorder({ images, riskOf });
    this.har = new HarRecorder({ riskOf });
    this.perf = new PerfTraces();
    /** chat -> its upload folder, as the last call that started a recording there found it (a turn end saves into it) */
    this.roots = new Map();
    /** chat -> what a HAR that ended with its turn saved */
    this.harSaved = new Map();
    tabs.onTurnEnd?.((/** @type {string} */ chatId) => void this.endTurn(chatId));
  }

  /** A tool call on `tab` passed its page gate (hostPageGates.cjs): running recordings take it up. */
  touch(tab) {
    void this.video.touch(tab);
    void this.har.touch(tab);
  }

  async endTurn(/** @type {string} */ chatId) {
    this.video.endTurn(chatId);
    this.perf.endTurn(chatId);
    this.har.endTurn(chatId);
    const rec = this.har.ended.get(chatId);
    const root = this.roots.get(chatId);
    if (!rec || !root) return;
    this.har.ended.delete(chatId);
    try {
      this.harSaved.set(chatId, await saveHar(this.har, rec, root, null));
    } catch (error) {
      noteIgnored('save a HAR when its turn ended', error);
    }
  }
}

/** The HAR's creator version: this writer's own format version (capabilities read no app metadata). */
const VERSION = '1';

/** Writes a stopped HAR recording; returns its file and counts. */
async function saveHar(
  /** @type {InstanceType<typeof HarRecorder>} */ har,
  /** @type {any} */ rec,
  /** @type {string} */ root,
  /** @type {unknown} */ name,
) {
  const doc = await har.har(rec, VERSION);
  const file = freeFile(root, 'har', name, 'network', 'har');
  const text = JSON.stringify(doc, null, 1);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, entries: doc.log.entries.length, bytes: Buffer.byteLength(text), why: rec.why };
}

const size = (/** @type {number} */ bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const endedNote = (/** @type {string | null} */ why) => (why ? ` It stopped by itself: ${why}.` : '');

/** Runs page code in the tab's isolated devtools world; returns its value. */
async function inWorld(tab, /** @type {string} */ source, /** @type {any} */ args) {
  const { frameTree } = await tab.send('Page.getFrameTree');
  const { executionContextId } = await tab.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: WORLD,
    grantUniveralAccess: false,
  });
  const r = await tab.send('Runtime.evaluate', {
    expression: `${source}(${JSON.stringify(args)})`,
    contextId: executionContextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new ToolError(
      `The page check failed: ${oneLine(r.exceptionDetails.exception?.description || r.exceptionDetails.text, 300)}`,
      'failed',
    );
  return r?.result?.value;
}

/** The audit's result as text: each violated rule, its elements, then what could not be decided. */
function auditText(/** @type {any} */ a) {
  if (a.error) return `Accessibility audit of ${oneLine(a.url, 200)}: nothing audited, the ${a.error}.`;
  const head = `Accessibility audit of ${oneLine(a.url, 200)}: ${a.violations.length} rule${a.violations.length === 1 ? '' : 's'} violated, ${a.passes} passed, ${a.rulesRun} run.`;
  const rules = a.violations.map(
    (/** @type {any} */ v) =>
      `\n[${v.impact}] ${v.id} (${v.count}): ${v.help}${v.wcag?.length ? ` WCAG ${v.wcag.join(', ')}.` : ''}\n${v.nodes.map((/** @type {any} */ n) => `  - ${n.selector} ${n.html}${n.why ? ` — ${n.why}` : ''}`).join('\n')}${v.count > v.nodes.length ? `\n  … and ${v.count - v.nodes.length} more` : ''}`,
  );
  const open = a.incomplete?.length
    ? `\nNeeds a manual check: ${a.incomplete.map((/** @type {any} */ i) => `${i.id} (${i.count})`).join(', ')}.`
    : '';
  return `${head}${rules.join('')}${open}`;
}

/**
 * The tools' handlers, for createBrowserTools.
 * @param {{ tabs: any, pageGate: (tab: any, need: string, ctx: any) => Promise<unknown>, uploadRoot: (chatId: string, what: string) => string,
 *           riskOf: (url: string) => { level: string, credentials?: boolean } }} o
 */
function devtoolsTools({ tabs, pageGate, uploadRoot, riskOf }) {
  const hub = /** @type {DevtoolsHub} */ ((tabs.devtools ??= new DevtoolsHub({ tabs, riskOf, images: tabs.o?.images })));
  /** The tab the call names, ready and past its page gate (`need`), with `fn` run alone on it. */
  const onTab = async (
    /** @type {any} */ args,
    /** @type {any} */ ctx,
    /** @type {string} */ need,
    /** @type {(tab: any) => Promise<any>} */ fn,
  ) => {
    const tab = await tabs.resolve(ctx.chatId, tabArg(args));
    return tabs.run(tab, async () => {
      await tabs.ready(tab, ctx.chatId);
      await pageGate(tab, need, ctx);
      return fn(tab);
    });
  };
  const root = (/** @type {string} */ chatId, /** @type {string} */ what) => {
    const r = uploadRoot(chatId, what);
    hub.roots.set(chatId, r);
    return r;
  };
  const badAction = () => new ToolError('action must be "start" or "stop".', 'bad_args');

  const videoSaved = (/** @type {any} */ r) =>
    r.saved
      ? `Saved a video of ${r.saved.frames} frames (${r.saved.width}x${r.saved.height}, ${(r.saved.ms / 1000).toFixed(1)} s, ${size(r.saved.bytes)}) to ${r.saved.file}.${endedNote(r.why)}${r.skipped ? ` ${r.skipped} frames were left out (high-risk pages, password fields and sign-in are never recorded).` : ''} Attach it with browser_file_upload (paths: [that file]); the user confirms each upload.`
      : `Nothing was recorded${r.why ? ` before it stopped (${r.why})` : ''}: no frame of an ordinary page came in.`;
  const harSaved = (/** @type {any} */ r) => `Saved a HAR of ${r.entries} requests (${size(r.bytes)}) to ${r.file}.${endedNote(r.why)}`;
  const traceSaved = (/** @type {any} */ r) =>
    `Saved a trace of ${(r.ms / 1000).toFixed(1)} s (${r.events} events, ${size(r.bytes)}) to ${r.file}.${endedNote(r.why)}${r.lost ? ' Chrome dropped part of it (its buffer filled).' : ''}\n${insightText(r.insights)}`;

  return {
    browser_react: reactTool({ tabs, pageGate }),

    async browser_record(/** @type {any} */ args, /** @type {any} */ ctx) {
      const before = hub.video.takeEnded(ctx.chatId);
      const earlier = before ? `Earlier: ${videoSaved(before)}\n` : '';
      if (args.action === 'start')
        return onTab(args, ctx, 'read', async (tab) => {
          const file = freeFile(root(ctx.chatId, 'Saving recordings'), 'recordings', args.filename, 'recording', 'mov');
          const prev = await hub.video.start(ctx.chatId, tab, file);
          return `${earlier}${prev ? `The earlier recording ended: ${videoSaved(prev)}\n` : ''}Recording ${tab.id} to a video. Call stop to save it; it stops by itself after 10 minutes or when this turn ends.`;
        });
      if (args.action !== 'stop') throw badAction();
      const r = hub.video.stop(ctx.chatId);
      if (!r) return earlier ? earlier.trim() : 'Nothing is recording in this chat. Call start first.';
      return `${earlier}${videoSaved(r)}`;
    },

    async browser_har(/** @type {any} */ args, /** @type {any} */ ctx) {
      const before = hub.harSaved.get(ctx.chatId);
      hub.harSaved.delete(ctx.chatId);
      const earlier = before ? `Earlier: ${harSaved(before)}\n` : '';
      if (args.action === 'start')
        return onTab(args, ctx, 'read', async (tab) => {
          root(ctx.chatId, 'Saving HAR files');
          const prev = await hub.har.start(ctx.chatId, tab);
          return `${earlier}${prev ? `Dropped the earlier recording (${prev.entries.size} requests, not saved). ` : ''}Recording this chat's network traffic, starting with ${tab.id}. Call stop to save the HAR; it stops by itself when this turn ends.`;
        });
      if (args.action !== 'stop') throw badAction();
      const rec = hub.har.stop(ctx.chatId);
      if (!rec) return earlier ? earlier.trim() : 'Nothing is recording in this chat. Call start first.';
      return `${earlier}${harSaved(await saveHar(hub.har, rec, root(ctx.chatId, 'Saving HAR files'), args.filename))}`;
    },

    async browser_perf_trace(/** @type {any} */ args, /** @type {any} */ ctx) {
      const before = hub.perf.takeEnded(ctx.chatId);
      const earlier = before
        ? `Earlier: ${await before.then(traceSaved, (/** @type {any} */ e) => `the trace that stopped by itself was lost (${oneLine(e?.message, 200)}).`)}\n`
        : '';
      if (args.action === 'start')
        return onTab(args, ctx, args.reload ? 'write' : 'read', async (tab) => {
          const file = freeFile(root(ctx.chatId, 'Saving traces'), 'traces', args.filename, 'trace', 'json');
          try {
            await hub.perf.start(ctx.chatId, tab, file);
          } catch (e) {
            // nothing traced: the empty file it would have filled goes
            fs.rmSync(file, { force: true });
            throw e;
          }
          if (args.reload) await tabs.history(tab, 'reload');
          return `${earlier}Tracing ${tab.id}${args.reload ? ', reloaded' : ''}. Do what you want to measure, then call stop; it stops by itself after 60 seconds or when this turn ends.`;
        });
      if (args.action !== 'stop') throw badAction();
      const r = hub.perf.stop(ctx.chatId);
      if (!r) return earlier ? earlier.trim() : 'Nothing is tracing in this chat. Call start first.';
      return `${earlier}${traceSaved(await r)}`;
    },

    async browser_vitals(/** @type {any} */ args, /** @type {any} */ ctx) {
      return onTab(args, ctx, 'read', async (tab) => vitalsText(await inWorld(tab, VITALS_SOURCE, { waitMs: args.waitMs ?? 250 })));
    },

    async browser_accessibility_audit(/** @type {any} */ args, /** @type {any} */ ctx) {
      return onTab(args, ctx, 'read', async (tab) =>
        auditText(await inWorld(tab, A11Y_AUDIT_SOURCE, { rules: args.rules, selector: args.selector, maxNodes: args.maxNodes ?? 10 })),
      );
    },
  };
}

/** Every browser_* spec: the page tools' (hostToolSpecs.cjs), then this group's. */
const BROWSER_SPECS = { ...require('../hostToolSpecs.cjs').SPECS, ...DEVTOOLS_SPECS };
const { ACTIONS } = require('../hostToolSpecs.cjs');

module.exports = { BROWSER_SPECS, ACTIONS, DEVTOOLS_SPECS, DevtoolsHub, devtoolsTools, inWorld, auditText, saveHar, WORLD };
