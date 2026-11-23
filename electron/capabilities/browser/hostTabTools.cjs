// The browser_tabs_* tools for every harness: list, open, duplicate, close, select and mark a chat's tabs of the built-in browser.
const { mkdirPrivate } = require('../../platform/privateFiles.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { originOf } = require('./origins.cjs');
const { oneLine } = require('./host.cjs');
const { readHistory, holdsHistory } = require('./historyCopy.cjs');
const { tabArg } = require('./hostToolArgs.cjs');
const { isViewTab } = require('./views.cjs');

/**
 * The handlers, by tool name (createBrowserTools adds them to the others).
 * @param {{ tabs: InstanceType<typeof import('./host.cjs').BrowserTabs>,
 *           folders: ((chatId: string) => { uploads: string, downloads: string | null }) | null,
 *           navigateTab: (tab: any, url: string, ctx: any) => Promise<string>,
 *           gateNavigation: (tab: any, target: string, ctx: any) => Promise<void>,
 *           landed: (tab: any, r: { url: string }, target: string, ctx: any) => Promise<void>,
 *           status: (tab: any) => string, today: () => string }} o
 *   gateNavigation: the site check of a navigation the tools start; landed: the check of where it ended (a redirect);
 *   today: the line naming today (calendarDay.mjs todayLine), told beside the tabs so "this week" or "30 days ago" is read, not reckoned
 */
function tabTools({ tabs, folders, navigateTab, gateNavigation, landed, status, today }) {
  const tabsList = (chatId) => {
    const cur = tabs.current(chatId);
    const list = tabs.list(chatId);
    const lines = list.map(
      (t) =>
        `- ${t.id}${t === cur ? ' (current)' : ''}${t.kind === 'popup' ? ' (popup window)' : ''}${t.mark ? ` [${t.mark}]` : ''}: "${oneLine(t.title, 120)}" ${oneLine(t.url, 300) || 'about:blank'}`,
    );
    return lines.length ? `Tabs in this chat:\n${lines.join('\n')}` : 'No tabs in this chat.';
  };

  /**
   * browser_tabs_create's duplicate (#1362): a new tab of the chat beside the source, with a copy of its back/forward history,
   * loading its current page again after the same site check as a navigation. The two tabs are independent afterwards.
   */
  const duplicate = async (sourceId, ctx) => {
    const source = await tabs.resolve(ctx.chatId, sourceId);
    const copy = await tabs.run(source, async () => {
      await tabs.ready(source, ctx.chatId);
      const read = readHistory(source.backend);
      if (!read)
        throw new ToolError(
          `${source.id} has no history that can be copied (only web pages can be). Open its page in a new tab with browser_tabs_create and url instead.`,
          'bad_args',
        );
      const url = read.entries[read.index].url;
      if (originOf(url)) await gateNavigation(source, url, ctx);
      // the user may have used the tab while asked: copy its history as it is now, still on the site they allowed
      const now = readHistory(source.backend);
      if (!now || originOf(now.entries[now.index].url) !== originOf(url))
        throw new ToolError(`${source.id} moved while the user was being asked. Look at it again before duplicating it.`, 'tab_changed');
      return now;
    });
    const url = copy.entries[copy.index].url;
    // main writes the history into the new view before anything else reaches it (views.cjs create)
    const tab = await tabs.create(ctx.chatId, { focus: false, history: copy, after: source.legacy ? null : source.id });
    // only a view main created takes a copied history (views off, the pane's <webview> loaded its blank page already);
    // a view that loaded nothing answers no debugger command, so one whose history was not written is closed before any is sent
    const view = isViewTab(tab.backend);
    /** whether the copy is a tab the agent asked for: its history written, or with views off its page opened */
    let kept = view && holdsHistory(tab.backend, copy);
    try {
      if (view && !kept) throw new ToolError(`The history of ${source.id} could not be copied to a new tab. Try again.`, 'failed');
      return await tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        if (!view) {
          const out = await navigateTab(tab, url, ctx);
          kept = true;
          ctx.touched = tab;
          return `${out} The back/forward history of ${source.id} could not be copied here: Back starts from this page.`;
        }
        const r = await tabs.loaded(tab);
        await landed(tab, r, url, ctx);
        ctx.touched = tab;
        const pages = copy.entries.length;
        return `Duplicated ${source.id} as ${tab.id}, with its back/forward history (${pages} page${pages === 1 ? '' : 's'}). ${tab.id} is now the current tab. ${status(tab)}${r.note ? ` ${r.note}` : ''}`;
      });
    } catch (error) {
      // a copy that never got its history (or its page) is no tab the agent asked for; one that did stays, whatever its page did
      if (!kept) await tabs.close(ctx.chatId, tab.id).catch((e) => noteIgnored('close a duplicate tab that was not copied', e));
      throw error;
    }
  };

  /**
   * The chat's folders as the agent is told them, each made before it is named: an agent writes the file it uploads
   * straight into the folder it was told about (#1570). A host that saves no downloads there (the user's Chrome) gives
   * no downloads folder, and none is named. A folder that could not be made is never named: the text says it is
   * unavailable and why.
   */
  const foldersText = (chatId) => {
    if (/** @type {any} */ (tabs).localDataAllowed?.(chatId) === false) return '';
    const f = folders?.(chatId);
    if (!f) return '';
    try {
      // what a chat uploads and downloads is the user's: only they can open these folders
      mkdirPrivate(f.uploads);
      if (f.downloads) mkdirPrivate(f.downloads);
    } catch (e) {
      return `\nNo upload folder: ${oneLine(/** @type {Error} */ (e).message, 300)}. browser_file_upload can't be used in this chat.`;
    }
    return `\nUpload folder (browser_file_upload reads only from here; save or copy a file into it to upload it): ${f.uploads}${f.downloads ? `\nDownloads from tabs you drive are saved to: ${f.downloads}` : ''}`;
  };

  return {
    async browser_tabs_context(_args, ctx) {
      if (!tabs.list(ctx.chatId).length) await tabs.create(ctx.chatId, { focus: true });
      return `${tabsList(ctx.chatId)}${foldersText(ctx.chatId)}\n${today()}`;
    },

    async browser_tabs_create(args, ctx) {
      if (args.duplicate != null && args.duplicate !== '') {
        if (args.url) throw new ToolError('Give url or duplicate, not both.', 'bad_args');
        return duplicate(String(args.duplicate), ctx);
      }
      const tab = await tabs.create(ctx.chatId, { focus: false });
      let text = `Created new tab with tabId: ${tab.id}. It is now the current tab.`;
      if (args.url)
        text += ` ${await tabs.run(tab, async () => {
          await tabs.ready(tab, ctx.chatId);
          const out = await navigateTab(tab, String(args.url), ctx);
          ctx.touched = tab;
          return out;
        })}`;
      return text;
    },

    async browser_tabs_close(args, ctx) {
      const tab = await tabs.close(ctx.chatId, tabArg(args));
      return `Closed tab ${tab.id}.`;
    },

    async browser_tabs_select(args, ctx) {
      const tab = tabs.select(ctx.chatId, tabArg(args));
      return `Switched to tab ${tab.id}. ${status(tab)}`;
    },

    async browser_tabs_mark(args, ctx) {
      const tab = tabs.mark(ctx.chatId, tabArg(args), args.status);
      return args.status === 'handoff'
        ? `Marked ${tab.id} as handoff: it stays open after this turn and is handed to the user to continue. Tell them what to do there.`
        : `Marked ${tab.id} as deliverable: it stays open after this turn for the user, including a later message in this chat.`;
    },
  };
}

module.exports = { tabTools };
