// browser_page_tools and browser_page_tool (#3571, G6): read and run the tools a page publishes for agents (WebMCP,
// webmcp.cjs), for every harness and every browser host (the in-app browser; the user's Chrome as chrome_page_tools and
// chrome_page_tool, chromeTools.cjs). A call is an action on the tool's origin: the site's card, a high-risk site's card
// and a sensitive action's card (siteRisk.cjs sensitiveTool: what its name and description say, or the page's own
// "consequential") ask exactly as a click there would. Stop, the turn's end and a time limit cancel it.
const { ToolError } = require('../contract/registry.cjs');
const { sensitiveTool } = require('./siteRisk.cjs');
const { oneLine } = require('./hostUtil.cjs');
const { catalogOf, watchWebMcp, resultText, callMs, UNTRUSTED, CALL_MAX_MS, FLAG } = require('./webmcp.cjs');
const { isEnabled } = require('../../platform/flags.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const FRAME = { type: 'string', description: 'The frame that publishes the tool, when several frames publish one with that name.' };

/** The two tools' schemas, with the browser_* tools' own tab id (hostToolSpecs.cjs). @param {object} TAB_ID */
const webmcpSpecs = (TAB_ID) => ({
  browser_page_tools: {
    policy: 'observe',
    description: `The tools the tab's page publishes for agents (WebMCP): each tool's name, description, input schema, hints and frame, as JSON. Pass name for one tool. ${UNTRUSTED}`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'One tool to describe.' }, tabId: TAB_ID },
    },
  },
  browser_page_tool: {
    policy: 'act',
    description: `Run a tool the tab's page publishes (WebMCP) with params matching its input schema (browser_page_tools), and get its answer. It asks the user as a click on that site would, and more for a tool that sends, deletes, buys, pays or that the page marks consequential. timeout: seconds (default 30, at most ${CALL_MAX_MS / 1000}); Stop cancels it. A long one: detach starts it and answers with its call id at once; result waits for that call's answer (up to timeout), cancel stops it. ${UNTRUSTED}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool, as browser_page_tools names it.' },
        params: { type: 'object', description: "The tool's input, matching its input schema." },
        frameId: FRAME,
        timeout: { type: 'number', minimum: 1, maximum: CALL_MAX_MS / 1000 },
        detach: { type: 'boolean', description: 'Start it and answer with its call id at once.' },
        result: { type: 'string', description: "A detached call's id: wait for its answer." },
        cancel: { type: 'string', description: "A detached call's id: cancel it." },
        tabId: TAB_ID,
      },
    },
  },
});

/** A tool as browser_page_tools shows it. */
const shown = (/** @type {any} */ t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  hints: t.annotations,
  ...(t.declarative ? { form: true } : {}),
  frameId: t.frameId,
  origin: t.origin || null,
});

/**
 * The two tools' handlers over a browser host. `tabs`, `grants`, `pageGate` and `checkPage` are hostTools.cjs's.
 * @param {{ tabs: any, grants: any, pageGate: (tab: any, need: 'read' | 'write', ctx: any) => Promise<any>,
 *           checkPage: (tab: any, need: 'read' | 'write', ctx: any) => any, tabArg: (args: any) => any,
 *           enabled?: (key: string) => boolean }} o
 */
function webmcpTools({ tabs, grants, pageGate, checkPage, tabArg, enabled = isEnabled }) {
  /**
   * The tab's catalog once the page's tools are reported; refuses when the switch is off. A tab attached while the
   * switch was off starts reading its page's tools now.
   */
  const catalog = async (/** @type {any} */ tab) => {
    if (!enabled(FLAG)) throw new ToolError('Page tools (WebMCP) are turned off in MoPilot.', 'disabled');
    const c = catalogOf(tab) ?? watchWebMcp(tab, enabled);
    await c.ready;
    return c;
  };

  /** A detached call's answer (`result`), or its cancel: the user allowed the call when it started. */
  const detachedCall = (/** @type {any} */ tab, /** @type {any} */ args, /** @type {any} */ ctx) =>
    tabs.run(tab, async () => {
      await tabs.ready(tab, ctx.chatId);
      const c = await catalog(tab);
      if (args.cancel !== undefined) {
        const tool = c.cancelDetached(String(args.cancel));
        return `Canceled page tool ${JSON.stringify(oneLine(tool.name, 80))} (call ${oneLine(args.cancel, 60)}).`;
      }
      // its answer is page content: the page must still be one the chat may read
      await pageGate(tab, 'read', ctx);
      const id = String(args.result);
      const { tool, r } = await c.result(id, { signal: ctx.signal, timeoutMs: callMs(args.timeout) });
      if (r.status === 'Running')
        return `Page tool ${JSON.stringify(oneLine(tool.name, 80))} (call ${oneLine(id, 60)}) is still running. Ask again for its result, or cancel it.`;
      ctx.touched = tab;
      const out = resultText(tool, r);
      // (one that ran past its time was cancelled and is gone: result says it ended)
      if (!out.ok) throw new ToolError(out.text, 'page_tool_failed');
      return out.text;
    });

  return {
    async browser_page_tools(/** @type {any} */ args, /** @type {any} */ ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'read', ctx);
        const c = await catalog(tab);
        const list = args.name ? [c.find(String(args.name), undefined)] : c.list();
        // the model was told what it now reads in full (one tool read is not the catalog)
        if (!args.name) c.told.set(ctx.segmentId, c.digest());
        if (!list.length) return `${tab.id}'s page publishes no page tools (WebMCP).`;
        return `${list.length} page tool${list.length === 1 ? '' : 's'} in ${tab.id}. ${UNTRUSTED}\n${JSON.stringify(list.map(shown))}`;
      });
    },

    async browser_page_tool(/** @type {any} */ args, /** @type {any} */ ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      const params = args.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ToolError('params must be an object.', 'bad_args');
      if (args.result !== undefined || args.cancel !== undefined) return detachedCall(tab, args, ctx);
      if (typeof args.name !== 'string' || !args.name) throw new ToolError('name is required: the tool to run.', 'bad_args');
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'write', ctx);
        const c = await catalog(tab);
        const name = args.name;
        const frameId = args.frameId === undefined ? undefined : String(args.frameId);
        const tool = c.find(name, frameId);
        // an action on the tool's own page (a frame's, if it is in one), as a click there: its risk class and the
        // sensitive-action card; a frame nobody could read asks
        const url = tool.top ? tab.url : tool.url;
        const sensitive = sensitiveTool(tool, url);
        const input = JSON.stringify(params);
        const summary = `run page tool ${JSON.stringify(oneLine(name, 80))}${input === '{}' ? '' : ` with ${oneLine(input, 200)}`}`;
        const asked = await tabs.awaitUser(tab, grants.act(url || tab.url, ctx, { tool: 'page_tool', summary, sensitive }), ctx.signal);
        checkPage(tab, 'write', ctx);
        // the page may have changed while the card was open: the tool the user allowed must still be the one there
        const now = asked ? c.find(name, tool.frameId) : tool;
        const same = (/** @type {any} */ a, /** @type {any} */ b) =>
          a.description === b.description &&
          JSON.stringify([a.annotations, a.inputSchema]) === JSON.stringify([b.annotations, b.inputSchema]);
        if (asked && !same(now, tool))
          throw new ToolError('The page tool changed while you answered. Read its page tools again and try again.', 'page_changed');
        if (args.detach === true) {
          const id = await c.detach(now, params);
          return `Started page tool ${JSON.stringify(oneLine(name, 80))} in ${tab.id} as call ${id}. Get its answer with browser_page_tool {"result": "${id}"} (it waits up to timeout), or stop it with {"cancel": "${id}"}; it is cancelled after 5 minutes.`;
        }
        const r = await c.invoke(now, params, { signal: ctx.signal, timeoutMs: callMs(args.timeout) });
        await tabs.settle(tab, { grace: 100 });
        ctx.touched = tab;
        const out = resultText(now, r);
        if (!out.ok)
          throw new ToolError(out.text, r.status === 'TimedOut' ? 'timeout' : r.status === 'Stopped' ? 'aborted' : 'page_tool_failed');
        return out.text;
      });
    },
  };
}

/**
 * The note about each of a chat's tabs whose page tools the model has not heard of in this segment (discovery,
 * change or removal), for the end of a browser tool's result.
 * @param {any} tabs @param {{ chatId: string, segmentId: string }} ctx @param {(key: string) => boolean} [enabled]
 */
function pageToolNotes(tabs, ctx, enabled = isEnabled) {
  if (!enabled(FLAG)) return [];
  const notes = [];
  try {
    for (const tab of tabs.list(ctx.chatId)) {
      const n = catalogOf(tab)?.note(ctx.segmentId);
      if (n) notes.push({ type: 'text', text: n });
    }
  } catch (error) {
    // the call itself succeeded: a note that can't be made now is left out, as a page diff is
    noteIgnored('tell the page tools of a chat', error);
  }
  return notes;
}

module.exports = { webmcpTools, pageToolNotes, webmcpSpecs };
