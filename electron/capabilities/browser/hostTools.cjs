// The browser_* tools: full control of MoPilot's built-in browser for any harness. Specs are
// plain JSON Schema (SPECS in hostToolSpecs.cjs) and handlers are harness-neutral (createBrowserTools), so the
// capability Registry - and through it sage-mcp, Claude's SDK MCP server and ACP session MCP - or an
// adapter that registers tools natively (Codex dynamicTools) can expose the same set.
//
// Site permission: only navigations the tools start to a new origin ask the user (once, for this
// chat, or always; a loopback origin never "always"). On a page, actions don't ask again, but a
// site the user denied in this chat, or allowed read only, or a read-only chat, still refuses them.
// File upload needs the user's confirmation for each call, JavaScript for the first run on a site each turn, unless the chat has Full access.
// browser_script (script.cjs) runs many steps as one Playwright-style script through the same checks.
//
// Site risk (siteRisk.cjs, IAB-03): a blocked page refuses everything; a high-risk page needs the
// user's approval in this chat before anything reads it, and every action on it asks the user (one
// card, Full access included). A sensitive action - a delete, purchase, transfer, sent message,
// payment or password change, as the page agent describes the element it targets - asks on any site;
// in Full access only payment details and password changes still ask (OriginGrants.act).
// Agents never type into password fields or act on a bot check (botCheck.cjs): browser_request_signin (IAB-05) hands
// the tab to the user and ends the agent's turn (userTurn.cjs): agent input to it stays paused until the user is done or
// replies, and screenshots and page reads mask password fields.
// browser_request_credentials (credentials.cjs) has MoPilot fill a login the user gives in its own sheet;
// the model only gets a status.
//
// Every refusal carries a stable reason, whether retrying can help and what to do next (refusals.cjs).
// After an action that changes a page, the result ends with what changed in the page tree the model
// last read (pageDiff.cjs), or the full tree when there is nothing to compare with.
const { localBrowserData } = require('../contract/localBrowserData.cjs');
const { memoryTools } = require('./memoryTools.cjs');
const { asksForCredential, askedInChrome, siteOf, HANDOFF_CONTINUES } = require('./userTurn.cjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { readPageAnswer, pageTextAnswer } = require('./pageTreeFile.cjs');
const { calendarNow, datesNote, todayLine } = require('../../../shared/calendarDay.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const path = require('node:path');
const { ToolError, checkArgs } = require('../contract/registry.cjs');
const { originOf } = require('./origins.cjs');
const { normalizeUrl, redactUrl, oneLine, modifierBits } = require('./host.cjs');
const { SESSION_INIT, browserScript, ScriptSessions } = require('./script.cjs');
const { mapping } = require('./capture.cjs');
const { holdMs } = require('./heldInput.cjs');
const { explainRefusal, explained } = require('./refusals.cjs');
const { PageSnapshots } = require('./pageDiff.cjs');
const { requestCredentials } = require('./credentials.cjs');
const { tabTools } = require('./hostTabTools.cjs');
const { pageGates } = require('./hostPageGates.cjs');
const { createActionGate } = require('./hostActionGate.cjs');
const { noteHidden } = require('./hiddenText.cjs');
const { BROWSER_SPECS: SPECS, ACTIONS } = require('./devtools/tools.cjs'); // page tools + the deferred devtools group
const { heldFor, sleep, tabArg, targetOf, tabStatus: status, asContent } = require('./hostToolArgs.cjs');
const { ScreenshotShelf, screenshotTools } = require('./hostScreenshots.cjs');
const { webmcpTools, pageToolNotes } = require('./webmcpTools.cjs');

/**
 * The tools, ready for Registry.register (or any adapter): { name, description, schema, policy, authorizesItself, handler }.
 * @param {{ tabs: InstanceType<typeof import('./host.cjs').BrowserTabs>, grants: InstanceType<typeof import('./origins.cjs').OriginGrants>,
 *           enabled?: () => true | string,
 *           localDataAllowed?: (chatId: string, tab?: any) => boolean,
 *           confirm?: ((ctx: { chatId: string, segmentId: string }, req: { tool: string, origin: string, summary: string }) => Promise<boolean>) | null,
 *           folders?: ((chatId: string) => { uploads: string, downloads: string }) | null,
 *           sessions?: InstanceType<typeof import('./script.cjs').ScriptSessions>,
 *           snapshots?: InstanceType<typeof PageSnapshots> | null,
 *           credentials?: InstanceType<typeof import('./credentials.cjs').CredentialHandoff> | null,
 *           chromeRoute?: ((chatId: string) => string | null) | null,
 *           memory?: { history: () => { search(o: any): any[] }, bookmarks: () => { search(o: any): any[] } } | null,
 *           scriptApprovals?: Map<string, { segmentId: string, origins: Set<string> }>, shelf?: InstanceType<typeof ScreenshotShelf>, chromeShots?: Parameters<typeof screenshotTools>[0]['chromeShots'], calendar?: () => ReturnType<typeof calendarNow> }} o
 *   sessions: the chats' browser_script sessions (registerBrowserTools ends them with each turn)
 *   snapshots: the page trees the model last read, for page diffs after actions (none: no diffs)
 *   credentials: the sheets of browser_request_credentials (none: the tool refuses)
 *   chromeRoute: names the user's own Chrome when the chat's browser tools drive it (the tool refuses there)
 *   memory: the built-in browser's history and bookmark stores, for browser_history_search and browser_bookmarks_search (none: they refuse)
 *   scriptApprovals: the sites whose JavaScript each chat's current turn allowed (registerBrowserTools clears a chat's at its turn end)
 *   calendar: today where the user is (shared/calendarDay.mjs), told with browser_tabs_context and with the dates a result names
 *   shelf: the chats' recent screenshots by id, which browser_file_upload's `screenshots` attaches (hostScreenshots.cjs); chromeShots: browser_save_screenshot for a tab of the chat's Chrome group (chromeScreenshots.cjs, #1539)
 */
function createBrowserTools({
  tabs,
  grants,
  enabled = () => true,
  confirm = null,
  folders = null,
  sessions = new ScriptSessions({ init: SESSION_INIT }),
  snapshots = null,
  credentials = null,
  chromeRoute = null,
  memory = null,
  localDataAllowed = (chatId, tab) => /** @type {any} */ (tabs).localDataAllowed?.(chatId, tab) ?? true,
  scriptApprovals = new Map(),
  shelf = new ScreenshotShelf(),
  chromeShots = null,
  calendar = () => calendarNow(),
}) {
  const localData = (ctx, tab = null) => {
    if (localDataAllowed(ctx.chatId, tab) !== true)
      throw new ToolError('This tool uses browser data on this Mac and is unavailable for a chat on another Host.', 'unavailable');
  };
  const live = () => {
    const on = enabled();
    if (on !== true) throw new ToolError(typeof on === 'string' ? on : 'Browser control is turned off.', 'disabled');
  };
  const full = (ctx) => {
    try {
      return grants.anchor({ chatId: ctx.chatId, segmentId: ctx.segmentId }) === 'full';
    } catch {
      return false;
    }
  };

  // the site checks of a page: before an action (pageGate, which may ask) and while it runs (checkPage)
  const { checkPage, pageGate, gateNavigation, taintGate, readable } = pageGates({ grants, tabs, live });
  const refused = grants.browser === 'chrome' ? 'chrome' : null; // a chrome_* refusal names Chrome: strips act there

  const actionGate = createActionGate({ tabs, grants, pageGate, checkPage, refused, chromeRoute });

  /**
   * The sites whose JavaScript the user allowed in a chat's current turn: one card per site per turn, not one per run.
   * Cleared when the chat's turn ends (registerBrowserTools); the segment check covers a switch within a turn.
   */
  const scriptAllowed = scriptApprovals;
  /** Asks for a confirmation (JavaScript, uploads), unless the chat has Full access; on a high-risk site, always (one card). `oncePerTurn`: a yes covers that site until the turn ends. */
  const confirmed = async (ctx, tool, tab, summary, { oncePerTurn = false } = {}) => {
    if (grants.riskOf(tab.url).level === 'high') {
      const what = { tool, summary: `${tool}: ${oneLine(summary, 280)}`, script: tool === 'JavaScript' };
      await tabs.awaitUser(tab, grants.act(tab.url, ctx, what), ctx.signal);
      return void checkPage(tab, 'write', ctx);
    }
    // a tainted turn's JavaScript or upload asks with the flagged text quoted, Full access included (G3)
    if (await taintGate(tab, tab.url, ctx, tool, summary, { kind: tool === 'File upload' ? 'upload' : 'script' })) return;
    if (full(ctx)) return;
    if (!confirm) throw new ToolError(`${tool} is turned off for this chat.`, 'disabled');
    const origin = originOf(tab.url);
    let turn = scriptAllowed.get(ctx.chatId);
    if (!turn || turn.segmentId !== ctx.segmentId) scriptAllowed.set(ctx.chatId, (turn = { segmentId: ctx.segmentId, origins: new Set() }));
    if (oncePerTurn && origin && turn.origins.has(origin)) return void checkPage(tab, 'write', ctx);
    const ok = await tabs.awaitUser(tab, confirm(ctx, { tool, origin: origin || 'this page', summary: oneLine(summary, 300) }), ctx.signal);
    if (!ok) throw new ToolError('The user did not allow this.', 'denied');
    if (oncePerTurn && origin) turn.origins.add(origin);
    checkPage(tab, 'write', ctx);
  };

  /** What an action changed in the tab's page: a <page_diff> or <page_tree>, or null when it can't be read now. */
  const pageView = async (tab, ctx) => {
    if (!snapshots) return null;
    try {
      return await tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        if (!readable(tab, ctx)) return null;
        const { filter, depth, maxChars } = snapshots.options(tab);
        const { lines, truncated } = await tabs.readPage(tab, { filter, depth, ref: null, maxChars });
        return snapshots.update(tab, { url: tab.url, lines, truncated });
      });
    } catch {
      // the action itself succeeded: a page that can't be read now just has no diff
      return null;
    }
  };

  const shots = screenshotTools({ tabs, folders, shelf, pageGate, status, riskOf: (url) => grants.riskOf(url), chromeShots, chromeRoute });
  const blockedNote = (r) => (r === 'dialog' ? ' A dialog or file chooser opened; see browser_state.' : '');

  /** A redirect to another origin is part of the navigation that landed there: it needs its own permission. */
  const landed = async (tab, r, target, ctx) => {
    const to = originOf(r.url);
    if (!to || to === originOf(target)) return;
    try {
      await tabs.awaitUser(tab, grants.require(r.url, 'read', ctx, { offer: 'write', localAlways: false }), ctx.signal);
    } catch (e) {
      await tabs.navigate(tab, 'about:blank').catch((error) => {
        // best effort: leave the page; the permission error below is what the caller sees
        noteIgnored('leave a redirect target the user did not allow', error);
      });
      throw e;
    }
  };

  const navigateTab = async (tab, url, ctx) => {
    let r;
    let target;
    if (url === 'back' || url === 'forward' || url === 'reload') {
      target = url === 'reload' ? tab.url : tabs.historyTarget(tab, url);
      if (!target) throw new ToolError(`There is no page to go ${url} to.`, 'bad_args');
      await gateNavigation(tab, target, ctx);
      r = await tabs.history(tab, url);
    } else {
      target = normalizeUrl(url);
      await gateNavigation(tab, target, ctx);
      r = await tabs.navigate(tab, target);
    }
    if (!r.download) await landed(tab, r, target, ctx); // a download left the tab where it was: nothing landed
    return `Navigated ${tab.id} to ${oneLine(r.url, 300)}${r.title ? ` (${oneLine(r.title, 120)})` : ''}.${r.note ? ` ${r.note}` : ''}`;
  };

  /** name -> (args, ctx) => content (without the browser_state block) */
  const impl = {
    async browser_navigate(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        // Stop, as the pane's: the page keeps what it rendered, and nothing new loads, so no site check
        const out =
          args.url === 'stop'
            ? `${tabs.stop(tab) ? `Stopped loading ${tab.id}; it keeps what loaded so far.` : `${tab.id} was not loading.`} ${status(tab)}`
            : await navigateTab(tab, String(args.url), ctx);
        ctx.touched = tab;
        return out;
      });
    },

    ...tabTools({ tabs, folders, navigateTab, gateNavigation, landed, status, today: () => todayLine(calendar()) }),

    async browser_request_signin(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      if (!originOf(tab.url))
        throw new ToolError(`Open the sign-in page in ${tab.id} first (browser_navigate), then hand it to the user.`, 'bad_args');
      const credential = await asksForCredential(tab);
      tabs.requestSignin(tab, { reason: String(args.reason ?? ''), credential });
      return `Handed ${tab.id} to the user ("${credential ? 'Sign in to' : 'Your turn on'} ${siteOf(tab)}"). ${HANDOFF_CONTINUES} ${status(tab)}`;
    },

    async browser_request_credentials(args, ctx) {
      const route = askedInChrome(ctx.chatId, chromeRoute?.(ctx.chatId), String(args.reason ?? ''));
      if (route)
        throw new ToolError(
          `This chat's browser is ${route}, where MoPilot can't fill a login. Ask the user to sign in themselves in their Chrome, then continue (browser_request_signin would open the built-in browser instead).`,
          'wrong_browser',
        );
      if (!credentials) throw new ToolError('Secure sign-in is unavailable here.', 'wrong_browser');
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      // a write: a site allowed for reading asks first (#1319 G22), a read-only answer refuses
      await pageGate(tab, 'write', ctx);
      localData(ctx, tab);
      return requestCredentials({ tabs, handoff: credentials, checkOwner: () => localData(ctx, tab) }, tab, args, ctx);
    },

    async browser_read_page(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'read', ctx);
        const maxChars = Math.max(1000, Math.min(50000, Number(args.max_chars) || 50000));
        const depth = Math.max(1, Math.round(Number(args.depth) || 15));
        const filter = ['visible', 'interactive', 'all'].includes(args.filter) ? args.filter : 'visible';
        const ref = args.ref_id ?? args.ref ?? null;
        const { lines, truncated } = await tabs.readPage(tab, { filter, depth, ref, maxChars });
        // the whole page is what later actions are compared with
        if (!ref) snapshots?.seen(tab, { url: tab.url, opts: { filter, depth, maxChars }, lines });
        const folder = folders?.(ctx.chatId)?.downloads;
        return readPageAnswer(tabs, tab, { filter, depth, ref, maxChars }, { lines, truncated, save: !!args.save_to, folder });
      });
    },

    async browser_find(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'read', ctx);
        const lines = await tabs.find(tab, String(args.query), 20);
        snapshots?.saw(tab, lines);
        return lines.length
          ? `${lines.length} match${lines.length === 1 ? '' : 'es'} in ${tab.id}:\n${lines.join('\n')}`
          : `Nothing in ${tab.id} matches "${oneLine(args.query, 120)}". Try other words, or browser_read_page with filter "all".`;
      });
    },

    async browser_get_page_text(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'read', ctx);
        const maxChars = Math.max(1000, Math.min(200000, Number(args.max_chars) || 50000));
        const r = await tabs.pageText(tab, maxChars);
        return pageTextAnswer(tab, r, maxChars);
      });
    },

    ...memoryTools(memory),

    async browser_computer(args, ctx) {
      ctx.messageKind = args.message_kind; // what a message this call sends is (errandGrants.cjs), never an earlier call's
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      const action = String(args.action);
      if (action === 'wait') {
        const s = Math.max(0, Math.min(30, Number(args.duration ?? 1)));
        await sleep(s * 1000, ctx.signal);
        return `Waited ${s} second${s === 1 ? '' : 's'}. ${status(tab)}`;
      }
      return tabs.run(tab, async () => {
        const target = targetOf(args);
        switch (action) {
          case 'screenshot':
          case 'zoom': {
            if (action === 'zoom' && !Array.isArray(args.region)) throw new ToolError('zoom needs region [x0, y0, x1, y1].', 'bad_args');
            await tabs.ready(tab, ctx.chatId);
            await pageGate(tab, 'read', ctx);
            const st = await tabs.ready(tab, ctx.chatId, { input: true });
            const shot = await tabs.capture(tab, st, { region: action === 'zoom' ? args.region : null, scale: args.scale });
            const k = mapping(shot, st).kx;
            const what = shot.rect
              ? `Zoom of region [${shot.rect.x}, ${shot.rect.y}, ${shot.rect.x + shot.rect.width}, ${shot.rect.y + shot.rect.height}]`
              : 'Screenshot';
            return [
              {
                type: 'text',
                text: `${what} of ${tab.id}: image ${shot.width}x${shot.height}. Coordinate frame: ${st.w}x${st.h} (full viewport, CSS pixels); give coordinates in that frame${Math.abs(k - 1) > 0.01 ? ` (image pixel × ${k.toFixed(3)}${shot.rect ? ` + region origin` : ''})` : shot.rect ? ' (image pixel + region origin)' : ''}. ${status(tab)}`,
              },
              { type: 'image', data: shot.data, mimeType: 'image/jpeg', from: tab.url },
            ];
          }
          case 'scroll_to': {
            await tabs.ready(tab, ctx.chatId);
            await pageGate(tab, 'read', ctx);
            if (!target.ref) throw new ToolError('scroll_to needs a ref.', 'bad_args');
            await tabs.scrollTo(tab, target.ref);
            await tabs.settle(tab, { grace: 100 });
            return `Scrolled ${target.ref} into view. ${status(tab)}`;
          }
          case 'hover':
          case 'scroll': {
            await tabs.ready(tab, ctx.chatId);
            await pageGate(tab, 'read', ctx);
            const st = await tabs.ready(tab, ctx.chatId, { input: true });
            const p =
              action === 'scroll' && !target.ref && target.coordinate == null
                ? { x: st.w / 2, y: st.h / 2 }
                : await tabs.point(tab, st, target);
            const r =
              action === 'hover'
                ? await tabs.hover(tab, p)
                : await tabs.scroll(tab, p, args.scroll_direction || 'down', args.scroll_amount ?? 3);
            await tabs.settle(tab, { grace: action === 'hover' ? 100 : 200 });
            if (action === 'scroll') ctx.touched = tab;
            return `${action === 'hover' ? 'Moved the pointer to' : `Scrolled ${args.scroll_direction || 'down'} at`} (${Math.round(p.x)}, ${Math.round(p.y)}).${blockedNote(r)} ${status(tab)}`;
          }
          case 'left_click':
          case 'right_click':
          case 'middle_click':
          case 'double_click':
          case 'triple_click': {
            await tabs.ready(tab, ctx.chatId);
            await pageGate(tab, 'write', ctx);
            const st = await tabs.ready(tab, ctx.chatId, { input: true });
            let p = await tabs.point(tab, st, target);
            const asked = await actionGate(tab, ctx, {
              kind: 'click',
              target: target.ref ? { ref: target.ref } : { point: p },
              summary: `${action.replace('_', ' ')} ${p.name ? `"${oneLine(p.name, 80)}"` : `at (${Math.round(p.x)}, ${Math.round(p.y)})`}`,
            });
            // the element the user approved, where it is now: the page may have scrolled while the card was open
            if (asked && target.ref) p = await tabs.point(tab, await tabs.ready(tab, ctx.chatId, { input: true }), target);
            const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
            const clickCount = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
            const hold = holdMs(args.duration, 1000);
            const r = await tabs.click(tab, p, { button, clickCount, modifiers: modifierBits(args.modifiers), holdMs: hold });
            if (r !== 'dialog') await tabs.settle(tab);
            ctx.touched = tab;
            // the element's name, quoted as JSON: the thread's narration shows it ("Clicked “Submit”")
            return `${action.replace('_', ' ')}${heldFor(hold)} at (${Math.round(p.x)}, ${Math.round(p.y)})${target.ref ? ` on ${target.ref}${p.name ? ` ${JSON.stringify(oneLine(p.name, 80))}` : ''}` : ''}.${blockedNote(r)} ${status(tab)}`;
          }
          case 'left_click_drag': {
            await tabs.ready(tab, ctx.chatId);
            await pageGate(tab, 'write', ctx);
            const st = await tabs.ready(tab, ctx.chatId, { input: true });
            const fromArg = args.start_coordinate ?? (args.from && Number.isFinite(args.from.x) ? [args.from.x, args.from.y] : null);
            if (!fromArg) throw new ToolError('left_click_drag needs start_coordinate.', 'bad_args');
            const from = await tabs.point(tab, st, { coordinate: fromArg });
            let to = await tabs.point(tab, st, target);
            const asked = await actionGate(tab, ctx, {
              kind: 'drag',
              target: { point: from },
              summary: `drag from (${Math.round(from.x)}, ${Math.round(from.y)}) to (${Math.round(to.x)}, ${Math.round(to.y)})`,
            });
            // a ref target is where its element is now (the page may have moved while the card was open)
            if (asked && target.ref) to = await tabs.point(tab, await tabs.ready(tab, ctx.chatId, { input: true }), target);
            const r = await tabs.drag(tab, from, to);
            if (r !== 'dialog') await tabs.settle(tab);
            ctx.touched = tab;
            return `Dragged from (${Math.round(from.x)}, ${Math.round(from.y)}) to (${Math.round(to.x)}, ${Math.round(to.y)}).${blockedNote(r)} ${status(tab)}`;
          }
          case 'type':
          case 'key': {
            if (typeof args.text !== 'string' || !args.text) throw new ToolError(`${action} needs text.`, 'bad_args');
            await tabs.ready(tab, ctx.chatId);
            await pageGate(tab, 'write', ctx);
            await tabs.ready(tab, ctx.chatId, { input: true });
            await actionGate(
              tab,
              ctx,
              action === 'type'
                ? { kind: 'type', text: args.text, summary: `type ${args.text.length} character${args.text.length === 1 ? '' : 's'}` }
                : { kind: 'key', keys: args.text, summary: `press ${oneLine(args.text, 100)}` },
            );
            const hold = action === 'key' ? holdMs(args.duration, 1000) : 0;
            const r =
              action === 'type' ? await tabs.typeText(tab, args.text) : await tabs.keys(tab, args.text, args.repeat ?? 1, { holdMs: hold });
            if (r !== 'dialog') await tabs.settle(tab, { grace: action === 'type' ? 100 : undefined });
            ctx.touched = tab;
            return `${action === 'type' ? `Typed ${args.text.length} character${args.text.length === 1 ? '' : 's'}` : `Pressed ${oneLine(args.text, 100)}${(args.repeat ?? 1) > 1 ? ` ×${args.repeat}` : ''}${heldFor(hold)}`}.${blockedNote(r)} ${status(tab)}`;
          }
          default:
            throw new ToolError(`Unknown action: ${oneLine(action, 40)}. Use one of: ${ACTIONS.join(', ')}.`, 'bad_args');
        }
      });
    },

    async browser_form_input(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      const ref = args.ref ?? args.target?.ref;
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'write', ctx);
        await actionGate(tab, ctx, { kind: 'fill', value: args.value, target: { ref }, summary: `set ${oneLine(ref, 40)}` });
        const r = await tabs.formInput(tab, ref, args.value);
        await tabs.settle(tab, { grace: 100 });
        ctx.touched = tab;
        return `Set ${ref} to ${JSON.stringify(r.value)}. ${status(tab)}`;
      });
    },

    async browser_javascript_exec(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'write', ctx);
        await confirmed(ctx, 'JavaScript', tab, args.text, { oncePerTurn: true });
        const out = await tabs.exec(tab, args.text);
        await tabs.settle(tab, { grace: 100 });
        ctx.touched = tab;
        return `${out.length > 50000 ? `${prefixUnits(out, 50000)}\n[Result truncated at 50,000 characters.]` : out}`;
      });
    },

    async browser_read_console_messages(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId, { allowDialog: true });
        await pageGate(tab, 'read', ctx);
        const list = tabs.console(tab, { onlyErrors: !!args.onlyErrors, pattern: args.pattern || null, limit: args.limit ?? 100 });
        if (!list.length)
          return `No console messages${args.onlyErrors ? ' with errors' : ''} in ${tab.id} (messages are kept from when browser control first reached the tab).`;
        return list
          .map(
            (e) =>
              `[${new Date(e.at).toISOString().slice(11, 23)}] ${e.level}: ${oneLine(e.text, 2000)}${e.source ? ` (${oneLine(e.source, 200)})` : ''}`,
          )
          .join('\n');
      });
    },

    async browser_read_network_requests(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId, { allowDialog: true });
        await pageGate(tab, 'read', ctx);
        if (args.requestId) {
          const { request, body } = await tabs.responseBody(tab, String(args.requestId));
          return `${request.method} ${redactUrl(request.url)} → ${request.status ?? '?'} ${request.mime}\n\n${body.length > 50000 ? `${prefixUnits(body, 50000)}\n[Body truncated at 50,000 characters.]` : body}`;
        }
        const list = tabs.requests(tab, { urlPattern: args.urlPattern || null, limit: args.limit ?? 100 });
        if (!list.length)
          return `No network requests${args.urlPattern ? ' match' : ''} in ${tab.id} (requests are kept from when browser control first reached the tab).`;
        return list
          .map(
            (r) =>
              `${r.id} ${r.method} ${r.error ? `failed (${r.error})` : (r.status ?? 'pending')} ${r.type || '-'} ${oneLine(redactUrl(r.url), 500)}${r.ms != null ? ` ${r.ms}ms` : ''}`,
          )
          .join('\n');
      });
    },

    async browser_resize_window(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        if (!args.preset && (args.width == null || args.height == null))
          throw new ToolError('Give width and height, or a preset.', 'bad_args');
        return `${await tabs.resize(tab, args)} ${status(tab)}`;
      });
    },

    async browser_handle_dialog(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      // not queued behind the action the dialog is blocking
      await tabs.ready(tab, ctx.chatId, { allowDialog: true });
      const message = tab.dialog?.message ?? '';
      // the dialog the card is about: the answer goes to no other
      const expect = tab.dialog?.own ?? null;
      await actionGate(tab, ctx, {
        kind: 'dialog',
        accept: !!args.accept,
        message,
        summary: `${args.accept ? 'accept' : 'dismiss'} the dialog${message ? ` "${oneLine(message, 120)}"` : ''}`,
      });
      const out = `${await tabs.handleDialog(tab, !!args.accept, args.promptText, expect)} ${status(tab)}`;
      ctx.touched = tab;
      return out;
    },

    async browser_file_upload(args, ctx) {
      const tab = await tabs.resolve(ctx.chatId, tabArg(args));
      localData(ctx, tab);
      const files = shots.uploadFiles(args, ctx.chatId);
      const ref = args.ref ?? args.target?.ref ?? null;
      return tabs.run(tab, async () => {
        await tabs.ready(tab, ctx.chatId);
        await pageGate(tab, 'write', ctx);
        await confirmed(
          ctx,
          'File upload',
          tab,
          `Upload ${files.map((x) => path.basename(x)).join(', ')} to ${originOf(tab.url) || 'this page'}`,
        );
        localData(ctx, tab);
        await tabs.setFiles(tab, ref, files);
        await tabs.settle(tab, { grace: 100 });
        ctx.touched = tab;
        return `Set ${files.length} file${files.length === 1 ? '' : 's'} on ${ref || 'the file chooser'}. ${status(tab)}`;
      });
    },

    async browser_batch(args, ctx) {
      const content = [];
      const steps = args.actions || [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] || {};
        const name = String(step.name || '').startsWith('browser_') ? String(step.name) : `browser_${step.name}`;
        const input = step.input && typeof step.input === 'object' ? step.input : {};
        const fail = async (message) => {
          const left = steps.length - i - 1;
          content.push({
            type: 'text',
            text: `${i + 1}. ${name} failed: ${message}${left ? `\nNot executed: the ${left} later action${left === 1 ? '' : 's'}.` : ''}`,
          });
          // what the earlier steps changed on the page
          const view = ctx.touched ? await pageView(ctx.touched, ctx) : null;
          if (view) content.push({ type: 'text', text: view });
          content.push({ type: 'text', text: tabs.state(ctx.chatId) });
          throw new ToolError(
            content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
            'batch_failed',
          );
        };
        if (ctx.signal?.aborted) await fail('the turn was stopped.');
        if (name === 'browser_batch' || name === 'browser_script' || !impl[name])
          await fail(`${name} is not a browser tool that can run in a batch.`);
        const bad = checkArgs(SPECS[name].inputSchema, input);
        if (bad) await fail(bad);
        try {
          live();
          const out = await require('./batchImages.cjs').staleAfter(content, name, input, impl[name](input, ctx));
          for (const c of [].concat(out)) content.push(typeof c === 'string' ? { type: 'text', text: `${i + 1}. ${name}: ${c}` } : c);
        } catch (e) {
          if (e instanceof ToolError && e.code === 'batch_failed') throw e;
          await fail(String(explainRefusal(e, refused)?.message || e));
        }
      }
      return content;
    },

    ...shots.impl,
    ...webmcpTools({ tabs, grants, pageGate, checkPage, tabArg }),

    async browser_script(args, ctx) {
      // a step still waiting for the user's card when the script ends (out of time, failed) must not act after it
      const ended = new AbortController();
      const asking = { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, ended.signal]) : ended.signal };
      try {
        return await browserScript(args, ctx, {
          tabs,
          gate: (tab, need) => explained(pageGate(tab, need, asking), refused),
          // the page diff after the script is for the last tab it acted on
          act: async (tab, action) => {
            const asked = await explained(actionGate(tab, asking, action), refused);
            ctx.touched = tab;
            return asked;
          },
          navigate: async (tab, url) => {
            const out = await explained(navigateTab(tab, url, asking), refused);
            ctx.touched = tab;
            return out;
          },
          confirmed: (tab, summary) => explained(confirmed(asking, 'JavaScript', tab, summary, { oncePerTurn: true }), refused),
          sessions,
        });
      } finally {
        ended.abort();
      }
    },
  };

  // Wrap the handlers themselves: browser_batch dispatches here without re-entering the Registry.
  for (const name of Object.keys(impl)) {
    if (!localBrowserData(name)) continue;
    const run = impl[name];
    impl[name] = (args, ctx) => {
      localData(ctx);
      return run(args, ctx);
    };
  }

  return Object.entries(SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    schema: spec.inputSchema,
    policy: spec.policy,
    // site permission and confirmations are asked inside (only a page's origin says what to ask)
    authorizesItself: true,
    handler: async (args, ctx) => {
      // this call's own context: the tab its actions changed (`touched`) gets a page diff
      const call = { ...ctx, touched: null };
      let out;
      try {
        live();
        out = await impl[name](args, call);
      } catch (e) {
        throw explainRefusal(e, refused);
      }
      const view = call.touched ? await pageView(call.touched, call) : null;
      await noteHidden(ctx, { tabs, name, args, ctx: call, tabArg }); // what the page hides, for G3's screen
      const items = shots.tag(ctx.chatId, asContent(out));
      // how far the dates the result names are from today (#1381 stab1), then the page diff and the state
      const after = view ? [...datesNote(items, calendar()), { type: 'text', text: view }] : datesNote(items, calendar());
      // a page's tools (WebMCP) the model has not heard of yet: on discovery, change or removal only
      return [...items, ...after, ...pageToolNotes(tabs, ctx), { type: 'text', text: tabs.state(ctx.chatId) }];
    },
  }));
}

/**
 * Registers the tools in a capability Registry; returns a function that unregisters them. A chat's
 * browser_script session and the page trees its agent read end with its turn (and with the chat),
 * and all sessions when unregistered.
 */
function registerBrowserTools(registry, deps) {
  const sessions = deps.sessions ?? new ScriptSessions({ init: SESSION_INIT });
  const snapshots = deps.snapshots ?? new PageSnapshots();
  // a JavaScript approval lasts the turn it was given in: the thread (segment) goes on to the next turns
  const scriptApprovals = new Map();
  const offs = createBrowserTools({ ...deps, sessions, snapshots, scriptApprovals }).map((t) => registry.register(t));
  const unlisten = deps.tabs.onTurnEnd((chatId) => {
    sessions.end(chatId);
    snapshots.reset(chatId);
    scriptApprovals.delete(chatId);
    // a credential sheet lasts its turn, as approval cards do (#1834)
    deps.credentials?.endChat(chatId);
  });
  return () => {
    offs.forEach((off) => off());
    unlisten();
    sessions.endAll();
  };
}

/**
 * Whether the browser_* tools may run, for `enabled`: only the remote switches decide. The in-app browser is
 * its own target, so the Your Chrome channel choice (which only routes sage_browser_*) never turns it off.
 */
function inAppBrowserEnabled(isFlagEnabled) {
  return isFlagEnabled('shared.browser.parityTools') && isFlagEnabled('shared.browser.panelCdp') ? true : 'Browser control is turned off.';
}

module.exports = {
  createBrowserTools,
  registerBrowserTools,
  inAppBrowserEnabled,
  BROWSER_TOOL_NAMES: Object.keys(SPECS),
};
