// The sage_browser_* tools for the built-in browser. Each call checks the site permission for the
// page it touches first: reading needs a 'read' grant, clicking and typing need 'write', and on a
// high-risk site (siteRisk.cjs) each click and typing asks the user (grants.act). Clicks and typing get
// browser_*'s checks of what they act on (hostTools.cjs actionGate): a password field refuses typing, a bot check
// refuses both (botCheck.cjs), and a sensitive action (a delete, purchase, payment entry, a submit that sends a form) asks, by the same rule.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { sensitiveAction } = require('./siteRisk.cjs');
const { botCheckRefusal, HANDOFF } = require('./botCheck.cjs');

const target = {
  ref: { type: 'string', description: 'An element ref (e.g. "e3") from the latest snapshot' },
  selector: { type: 'string', description: 'A CSS selector, when there is no ref' },
};

/**
 * @param {{ panel: InstanceType<typeof import('./cdp.cjs').PanelBrowser>, grants: InstanceType<typeof import('./origins.cjs').OriginGrants>, enabled?: () => boolean }} o
 * @returns {import('../contract/registry.cjs').ToolDef[]}
 */
function panelBrowserTools({ panel, grants, enabled = () => true }) {
  const live = () => {
    if (!enabled()) throw new ToolError('Browser control is turned off.', 'disabled');
  };
  /** The page a call reads or changes must be allowed for that; an action on a high-risk site asks the user too. */
  const onPage = async (
    ctx,
    need,
    /** @type {{ tool: string, summary: string, target: { ref?: string, selector?: string }, acts: { kind: string, keys?: string }[] } | null} */ action = null,
  ) => {
    live();
    const page = await panel.tab(ctx.chatId);
    const url = page.backend.getURL();
    await grants.require(url, need, ctx);
    if (action) {
      const intent = await panel.intent(ctx.chatId, action.target, page);
      if (intent?.secret && action.acts.some((a) => a.kind === 'type'))
        throw new ToolError('This is a password field: agents never type passwords. Ask the user to sign in themselves.', 'password_field');
      const bot = action.acts.map((a) => botCheckRefusal(intent, a, HANDOFF.legacy)).find(Boolean);
      if (bot) throw bot;
      const sensitive = action.acts.map((a) => sensitiveAction(intent, a)).find(Boolean) ?? null;
      await grants.act(url, ctx, { tool: action.tool, summary: action.summary, sensitive });
    }
    live();
    if (page.backend.isDestroyed() || page.backend.getURL() !== url || (await panel.tab(ctx.chatId)).backend !== page.backend)
      throw new ToolError('The page changed while waiting for permission. Try again on the current page.', 'page_changed');
    return { ...page, expectedUrl: url };
  };
  return [
    {
      name: 'sage_browser_navigate',
      description:
        "Open a web page in the selected browser: the built-in browser has its own saved logins, Your Chrome uses the user's Chrome session. In-app login popups become the active page until closed. The first visit to a site asks for permission unless this chat has Full access.",
      schema: { type: 'object', properties: { url: { type: 'string', description: 'An http or https URL' } }, required: ['url'] },
      policy: 'observe',
      authorizesItself: true,
      handler: async ({ url }, ctx) => {
        live();
        await grants.require(url, 'read', ctx);
        live();
        const r = await panel.navigate(ctx.chatId, url);
        try {
          // a redirect may land somewhere else, which needs its own permission
          await grants.require(r.url, 'read', ctx);
        } catch (e) {
          await panel.navigate(ctx.chatId, 'about:blank').catch((error) => {
            // best effort: leave the page; the permission error below is what the caller sees
            noteIgnored('leave a page the user did not allow (built-in browser)', error);
          });
          throw e;
        }
        return `Opened ${r.url}${r.title ? ` (${r.title})` : ''}${r.note ? `. ${r.note}` : ''}`;
      },
    },
    {
      name: 'sage_browser_snapshot',
      description:
        'Read the current page with element refs for click and type. The built-in browser supports accessibility (default) or visible text (mode "text"); Your Chrome always returns its accessibility snapshot.',
      schema: { type: 'object', properties: { mode: { type: 'string', enum: ['accessibility', 'text'] } } },
      policy: 'observe',
      authorizesItself: true,
      handler: async ({ mode }, ctx) => {
        const page = await onPage(ctx, 'read');
        return panel.snapshot(ctx.chatId, mode === 'text' ? 'text' : 'accessibility', page);
      },
    },
    {
      name: 'sage_browser_click',
      description: 'Click an element on the current page. Needs read and write access to the site.',
      schema: { type: 'object', properties: target },
      policy: 'act',
      authorizesItself: true,
      handler: async ({ ref, selector }, ctx) => {
        const page = await onPage(ctx, 'write', {
          tool: 'click',
          summary: `click ${ref || selector}`,
          target: { ref, selector },
          acts: [{ kind: 'click' }],
        });
        await panel.click(ctx.chatId, { ref, selector }, page);
        return `Clicked ${ref || selector}`;
      },
    },
    {
      name: 'sage_browser_type',
      description: 'Type text into a field on the current page, optionally pressing Enter. Needs read and write access to the site.',
      schema: { type: 'object', properties: { ...target, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'] },
      policy: 'act',
      authorizesItself: true,
      handler: async ({ ref, selector, text, submit }, ctx) => {
        const page = await onPage(ctx, 'write', {
          tool: 'type',
          summary: `type into ${ref || selector}${submit ? ' and press Enter' : ''}`,
          target: { ref, selector },
          // typing (a payment field), then Enter (the form it submits)
          acts: submit ? [{ kind: 'type' }, { kind: 'key', keys: 'Enter' }] : [{ kind: 'type' }],
        });
        await panel.type(ctx.chatId, { ref, selector }, text, !!submit, page);
        return `Typed into ${ref || selector}`;
      },
    },
    {
      name: 'sage_browser_screenshot',
      description: 'Take a screenshot of the current page.',
      schema: { type: 'object', properties: {} },
      policy: 'observe',
      authorizesItself: true,
      handler: async (_args, ctx) => {
        const page = await onPage(ctx, 'read');
        return panel.screenshot(ctx.chatId, page);
      },
    },
  ];
}

module.exports = { panelBrowserTools };
