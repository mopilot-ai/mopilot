// browser_react (devtools group): a page's React component tree, one component's props, hooks, state and source, and render counts between renders_start and renders_stop, as agent-browser's react tree|inspect|renders.
//
// React keeps its fibers on DOM nodes as properties of the page's own objects, which an isolated world cannot see, so these
// reads run in the page's world (reactPage.cjs only reads). renders_start installs a commit hook before the page's scripts
// and reloads the page (a write: a read-only site asks); renders_stop reads the counts and removes the hook. A page with a
// password field gets no string out of props or state.
const { ToolError } = require('../../contract/registry.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { oneLine } = require('../hostUtil.cjs');
const { PROBE_MS, credentialFieldIn } = require('../credentialProbe.cjs');
const { REACT_SOURCE, RENDER_HOOK } = require('./reactPage.cjs');

const TAB_ID = require('../hostToolSpecs.cjs').SPECS.browser_read_page.inputSchema.properties.tabId;

const REACT_SPECS = Object.freeze({
  browser_react: {
    policy: 'observe',
    description:
      "Inspect a React page. tree lists its components with ids; inspect (id) shows one component's props, hooks, state, owners and source; renders_start reloads the page with a render counter, renders_stop says which components rendered how often. Secret-looking values are REDACTED.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tree', 'inspect', 'renders_start', 'renders_stop'], description: 'What to do.' },
        id: { type: 'integer', description: 'For inspect: a component id from tree.' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 2000, description: 'For tree and renders_stop: how many to list.' },
        tabId: TAB_ID,
      },
      required: ['action'],
    },
  },
});

/** Runs reactPage in the tab's own world; returns its value. */
async function inPage(tab, /** @type {any} */ args) {
  const r = await tab.send('Runtime.evaluate', { expression: `${REACT_SOURCE}(${JSON.stringify(args)})`, returnByValue: true });
  if (r?.exceptionDetails)
    throw new ToolError(
      `Couldn't read React on this page: ${oneLine(r.exceptionDetails.exception?.description || r.exceptionDetails.text, 300)}`,
      'failed',
    );
  return r?.result?.value ?? {};
}

const NO_REACT = 'No React found on this page (a production build without root containers, or no React at all).';
const json = (/** @type {unknown} */ v) => JSON.stringify(v, null, 1);

/**
 * The handler, for createBrowserTools.
 * @param {{ tabs: any, pageGate: (tab: any, need: string, ctx: any) => Promise<unknown> }} o
 */
function reactTool({ tabs, pageGate }) {
  /** tab -> the identifier of its render hook script */
  const hooks = new WeakMap();
  return async function browser_react(/** @type {any} */ args, /** @type {any} */ ctx) {
    const need = args.action === 'renders_start' ? 'write' : 'read';
    const tab = await tabs.resolve(ctx.chatId, args.tabId ?? null);
    return tabs.run(tab, async () => {
      await tabs.ready(tab, ctx.chatId);
      await pageGate(tab, need, ctx);
      switch (args.action) {
        case 'tree': {
          const t = await inPage(tab, { op: 'tree', maxNodes: args.maxNodes ?? 300 });
          if (!t.react) return NO_REACT;
          const more = t.count > t.lines.length ? `\n… and ${t.count - t.lines.length} more (raise maxNodes)` : '';
          return `${t.count} components in ${tab.id}; inspect one by its [id]:\n${t.lines.join('\n')}${more}`;
        }
        case 'inspect': {
          if (!Number.isInteger(args.id)) throw new ToolError('inspect needs the id of a component from tree.', 'bad_args');
          const secret = await credentialFieldIn(tab, { ms: PROBE_MS, unreadable: true });
          const c = await inPage(tab, { op: 'inspect', id: args.id, secret });
          if (c.missing) throw new ToolError(`No component ${args.id} on this page now. Call tree again for current ids.`, 'stale_ref');
          return [
            `${c.name} [${c.id}]${c.source ? ` at ${c.source}` : ''}${c.owners.length ? `, inside ${c.owners.join(' < ')}` : ''}`,
            `props: ${json(c.props)}`,
            c.state ? `state: ${json(c.state)}` : `hooks: ${json(c.hooks)}`,
            secret ? 'This page has a password field: strings are shown as their length only.' : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
        case 'renders_start': {
          const old = hooks.get(tab);
          if (old)
            await tab
              .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old })
              .catch((e) => noteIgnored('remove an earlier React render hook', e));
          const { identifier } = await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: RENDER_HOOK });
          hooks.set(tab, identifier);
          await tabs.history(tab, 'reload');
          return `Counting React renders in ${tab.id} (the page reloaded with the counter). Interact, then call renders_stop.`;
        }
        case 'renders_stop': {
          const r = await inPage(tab, { op: 'renders', maxNodes: args.maxNodes ?? 30 });
          const id = hooks.get(tab);
          hooks.delete(tab);
          if (id)
            await tab
              .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
              .catch((e) => noteIgnored('remove the React render hook', e));
          if (!r.installed) return 'Not counting renders on this page. Call renders_start first (it reloads the page).';
          if (!r.components.length) return `${r.commits} commits, and no component rendered.`;
          return `${r.commits} commits. Renders by component:\n${r.components.map((/** @type {any} */ c) => `${c.name}: ${c.count}${c.ms ? ` (${c.ms} ms)` : ''}`).join('\n')}`;
        }
        default:
          throw new ToolError('action must be "tree", "inspect", "renders_start" or "renders_stop".', 'bad_args');
      }
    });
  };
}

module.exports = { REACT_SPECS, reactTool, inPage, NO_REACT };
