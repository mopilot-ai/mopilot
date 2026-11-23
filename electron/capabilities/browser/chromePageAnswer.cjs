// What navigate and a click answer with besides their own text (chromeTools.cjs): the page's interactive elements (#1699) and, behind its own switch, the start of its visible text (#3810).
const { noteIgnored } = require('../../ignored.cjs');
const { span } = require('../contract/callPhases.cjs');

const PAGE_TREE_CHARS = 6000;
/** How much of a page's visible text the page-text switch adds to an action's answer (get_page_text takes 1000 at least). */
const PAGE_TEXT_CHARS = 1500;

/**
 * The action's answer `out` with the page tree and the page text added, as the switches say. A tree or text that can't be read
 * is left out; the action's own answer stands.
 * @param {{ name: string, args: any, a: any, out: any[], ctx: any, o: { pageTree?: () => boolean, pageText?: () => boolean }, inner: Map<string, any>, content: (chatId: string, items: any[]) => any[] }} d
 */
async function pageAnswer({ name, args, a, out, ctx, o, inner, content }) {
  if (!(name === 'navigate' || (name === 'computer' && /click$/.test(String(args?.action))))) return out;
  let answer = out;
  if (o.pageTree?.()) {
    try {
      const tree = await span('tree', () =>
        /** @type {any} */ (inner.get('browser_read_page')).handler(
          { tabId: a.tabId, filter: 'interactive', max_chars: PAGE_TREE_CHARS },
          ctx,
        ),
      );
      const text = content(ctx.chatId, tree)
        .filter((c) => c.type === 'text')
        .map((c) => c.text.replace(/\n*<browser_state>[\s\S]*?<\/browser_state>\s*/g, ''))
        .join('\n');
      // said outright: Codex read the page again anyway, paying for both (#1699 A/B: Claude -19% calls, Codex +13%)
      answer = [...answer, { type: 'text', text: `The page now (no read_page needed unless you need more): ${text}` }];
    } catch (e) {
      // the action's own answer stands: the tree was a convenience
      noteIgnored('read the page tree after an action', e);
    }
  }
  // with the page-text switch (#3810, off by default): the start of the page's visible text too, so reading a mail or an
  // article takes no get_page_text after the action
  if (o.pageText?.()) {
    try {
      const read = await /** @type {any} */ (inner.get('browser_get_page_text')).handler(
        { tabId: a.tabId, max_chars: PAGE_TEXT_CHARS },
        ctx,
      );
      const text = content(ctx.chatId, read)
        .filter((c) => c.type === 'text')
        .map((c) => c.text.replace(/\n*<browser_state>[\s\S]*?<\/browser_state>\s*/g, ''))
        .join('\n');
      answer = [...answer, { type: 'text', text: `The page's text (start): ${text}` }];
    } catch (e) {
      // the tree and the action's own answer stand
      noteIgnored('read the page text after an action', e);
    }
  }
  return answer;
}

module.exports = { pageAnswer };
