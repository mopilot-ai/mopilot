// Claude in Chrome's tab group for one Claude Code session, as the session's own tool results report it.
//
// The CLI closes a session's tab group itself (closeSessionTabGroup): on /clear, and as it exits, when
// every tab in the group is blank. MoPilot keeps an idle CLI alive for follow-ups, so a group left with
// only the blank seed tab (tabs_context_mcp{createIfEmpty} opens one) would stay in the user's Chrome
// until the process ends. MoPilot has no channel of its own to the extension; it only reads what each
// Claude in Chrome result says the group holds, so it knows when ending the idle CLI lets the CLI's own
// exit hook close the group. Which tabs to close is always the CLI's decision, made on the live group.

/** Claude in Chrome's tools, as Claude Code names them in a session. */
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const CHROME_TOOL = /^mcp__claude-in-chrome__/;
/** The CLI's own list of blank tabs (closeSessionTabGroup's onlyIfEmpty test). */
const BLANK = new Set(['chrome://newtab/', 'about:blank']);
/** One tab line in a result's "Tab Context:" footer: `  • tabId 12: "Title" ("https://…")`. */
const TAB_LINE = /^\s*•\s*tabId\s+\d+:.*\("([^"]*)"\)\s*$/;

/**
 * The URLs of the tabs one text block says the group holds, or null when it says nothing about them:
 * tabs_context_mcp's JSON ({availableTabs: [{tabId, url}]}), or the "Available tabs:" list every
 * other tool's footer carries (an empty list once the last tab closed).
 */
function tabsOf(text) {
  if (typeof text !== 'string') return null;
  const at = text.lastIndexOf('Available tabs:');
  if (at >= 0) {
    const urls = [];
    for (const line of text
      .slice(at + 'Available tabs:'.length)
      .split('\n')
      .slice(1)) {
      const m = TAB_LINE.exec(line);
      if (!m) break;
      urls.push(m[1]);
    }
    return urls;
  }
  // tabs_context_mcp answers with a JSON object; any other text has no tab list
  if (!text.trimStart().startsWith('{')) return null;
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json?.availableTabs)) return json.availableTabs.map((t) => String(t?.url ?? ''));
  } catch (error) {
    // a reply that looks like JSON but isn't (cut short, say): no tab list
    noteIgnored('read the Claude in Chrome tab list', error);
  }
  return null;
}

/** The text blocks of a tool result's content (a string, or an array of blocks). */
const textsOf = (content) =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? contentBlocks(content)
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
      : [];

/** What one session's Claude in Chrome results last said its tab group holds. */
class ChromeTabs {
  /**
   * @param {{ chatOf?: () => string | undefined }} [o] chatOf: the chat the session serves, whose sites handed to the
   *   user's Chrome for a sign-in (browser/handoffPages.cjs) are the user's pages, which keep nothing alive
   */
  /** @param {{ chatOf?: () => string | undefined, handedOff?: (chatId: string | undefined, url: string) => boolean }} [o] handedOff: whether a page is a site handed to the user's Chrome for a sign-in (the app's browser layer knows; a process without one has none) */
  constructor({ chatOf = () => undefined, handedOff = () => false } = {}) {
    this.chatOf = chatOf;
    this.handedOff = handedOff;
    /** ids of Claude in Chrome tool calls whose results have not come yet */
    this.pending = new Set();
    /** the group's tab URLs as last reported; null until a result reports them */
    this.tabs = null;
  }

  /** Read one SDK message: Claude in Chrome tool calls, and the tab lists their results carry. */
  note(msg) {
    const blocks = msg?.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (msg.type === 'assistant' && b?.type === 'tool_use' && CHROME_TOOL.test(String(b.name))) this.pending.add(b.id);
      if (msg.type !== 'user' || b?.type !== 'tool_result' || !this.pending.delete(b.tool_use_id)) continue;
      for (const text of textsOf(b.content)) {
        const tabs = tabsOf(text);
        if (tabs) this.tabs = tabs;
      }
    }
  }

  /**
   * The group holds a page the chat works in: ending the CLI would close the group (and its tabs) with it. A site
   * handed to the user's Chrome only for a sign-in does not count (#1403).
   */
  holdsPages() {
    return !!this.tabs && this.tabs.some((url) => !BLANK.has(url) && !this.handedOff(this.chatOf(), url));
  }

  /** The session has a tab group, or a call under way that may open one: the CLI's exit is what closes it. */
  hasGroup() {
    return this.pending.size > 0 || (!!this.tabs && this.tabs.length > 0);
  }

  /** The group holds tabs and every one is blank: the CLI closes such a group as it exits. */
  blankOnly() {
    return !!this.tabs && this.tabs.length > 0 && this.tabs.every((url) => BLANK.has(url));
  }
}

/**
 * What a session with Claude in Chrome is told about its first input into a page (appended to Claude
 * Code's system prompt). Two things in the extension (1.0.100) and Chrome lose that input, the same in
 * the official CLI with --chrome:
 * - A tab Chrome is not showing has not been drawn since its page loaded. Until it is, the page gets the
 *   mouse moves of a click but not its press and release, and no key events, while the tool reports
 *   success. Only a screenshot (or zoom) draws such a tab first; clicks and typing do not.
 * - That first draw also applies the site's zoom level when it is not 100%, after the screenshot read the
 *   viewport. The coordinate frame of that first screenshot is then off by the zoom factor (25% at
 *   125%), so a click at coordinates read from it misses. Element refs use the live layout, and a later
 *   screenshot has the right frame.
 */
const INPUT_GUIDANCE =
  'Claude in Chrome loses the first clicks and typing in a page it has not drawn since the page loaded (a new tab, or a page that loaded while Chrome is in the background): the tool reports success but the page gets no press or key events. ' +
  'A screenshot draws the tab, and on a site whose zoom level is not 100% that first draw also rescales the page, so coordinates read from the first screenshot after a load miss. ' +
  'So after you open a tab or a new page loads in it, take a screenshot of it before your first click, typing or key press there; then click by element ref (from find or read_page), or take coordinates only from a later screenshot (a second screenshot in the same browser_batch works). ' +
  'form_input, find, read_page and get_page_text are not affected. After an action that should change the page, confirm the change before you report it done.';

module.exports = { ChromeTabs, tabsOf, CHROME_TOOL, BLANK, INPUT_GUIDANCE };
