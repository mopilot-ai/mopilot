// The site checks of a page for the browser_* tools: before an action (pageGate, which may put the site card up), the re-check while it runs (checkPage), a navigation's (gateNavigation) and a tainted turn's card (taintGate, G3).
const { ToolError } = require('../contract/registry.cjs');
const { span } = require('../contract/callPhases.cjs');
const { originOf } = require('./origins.cjs');
const { taintCard } = require('./originAction.cjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');

/**
 * @param {{ grants: any, tabs: { awaitUser: (tab: any, p: Promise<unknown>, signal?: AbortSignal) => Promise<unknown>,
 *           gif?: { touch: (tab: any) => Promise<void> } | null,
 *           devtools?: { touch: (tab: any) => void } | null, traces?: { touch: (tab: any) => Promise<void> } | null }, live: () => void }} o
 *   live: throws when browser control is turned off; tabs.gif: the chat recordings a page that passed feeds (gifRecorder.cjs)
 */
function pageGates({ grants, tabs, live }) {
  /**
   * What the page allows: a denied or read-only site refuses, a blocked one too; a high-risk site
   * nobody allowed in this chat asks the user first (reading it included), and so does a write on a
   * site allowed for reading only ('reask': pageGate puts the card up).
   */
  const pageVerdict = (tab, need, ctx) => {
    live();
    const verdict = grants.peek(tab.url, need, ctx);
    const origin = originOf(tab.url) || tab.url;
    // a blocked risk class, or a Codex Browser Use block (origins.cjs external, in every chat)
    if (verdict === 'blocked') throw new ToolError(grants.blockNote(tab.url), 'blocked');
    if (verdict === 'denied') throw new ToolError(`The user did not allow ${origin} in this chat.`, 'denied');
    if (verdict === 'read_only') throw readOnly(origin);
    return verdict;
  };
  const readOnly = (origin) =>
    new ToolError(
      `${origin} is read only for this chat: you can read its pages but not click, type or change anything there. Don't retry or work around this; ask the user in chat whether to allow read and write (they can also change it in Settings → Browser).`,
      'read_only',
    );
  /**
   * The re-check during an action (after a card, after inspecting its target): what pageVerdict refuses, and a write
   * whose site went back to read only meanwhile ('reask'), which is never let through without the card (#1319 G22):
   * the next action's pageGate asks. A yes on this call's own card (`ctx.siteAllowed`) covers its re-checks: an
   * "Allow once" isn't stored, and covers the call only.
   */
  const checkPage = (tab, need, ctx) => {
    const verdict = pageVerdict(tab, need, ctx);
    // a write on a site allowed for reading: an http(s) page, so it has an origin
    const origin = originOf(tab.url);
    if (verdict === 'reask' && !ctx.siteAllowed?.has(origin)) throw readOnly(origin);
    return verdict;
  };
  const pageGate = async (tab, need, ctx) => {
    const verdict = pageVerdict(tab, need, ctx);
    // one card per site per call: a yes earlier in this call (the tool's own gate, then its action's) covers it
    let requireApproval = verdict === 'reask' && !ctx.siteAllowed?.has(originOf(tab.url));
    if (verdict === 'ask') {
      const risk = grants.riskOf(tab.url);
      requireApproval = risk.level === 'high' || risk.credentials;
    }
    if (requireApproval) {
      await tabs.awaitUser(tab, grants.require(tab.url, need, ctx, { offer: 'write', localAlways: false }), ctx.signal);
      // the user said yes for this site: the rest of this call goes on under that answer
      (ctx.siteAllowed ??= new Set()).add(originOf(tab.url));
      checkPage(tab, need, ctx);
    }
    // a page the chat may read: a frame of it for the chat's recording (gifRecorder.cjs)
    if (tabs.gif) void tabs.gif.touch(tab);
    // and for its running video and HAR recordings (devtools/tools.cjs)
    tabs.devtools?.touch(tab);
    // and the turn's trace, while the user has turn replays on (devtools/turnTrace.cjs)
    void tabs.traces?.touch(tab);
  };
  /**
   * A tainted turn's JavaScript, upload or navigation (contract/taintLedger.cjs): the card quoting the flagged text, Full
   * access included. True when it asked (and the user allowed); false when the turn's taint asks nothing of it.
   * @param {any} tab @param {string} url @param {any} ctx @param {string} tool @param {string} summary
   * @param {import('./originAction.cjs').TaintAction} taint
   */
  const taintGate = async (tab, url, ctx, tool, summary, taint) => {
    if (!taintCard(grants, ctx.chatId, url, null, taint)) return false;
    // a read-only chat can't ask (act() refuses every action there): say why this one is refused
    if (grants.anchor(ctx) === 'readOnly')
      throw new ToolError(
        `Text read in this turn tried to instruct the agent, so this step (${tool}) needs the user's confirmation, which a read-only chat can't ask for.`,
        'read_only',
      );
    await tabs.awaitUser(tab, grants.act(url, ctx, { tool, summary: prefixUnits(String(summary), 200), taint }), ctx.signal);
    return true;
  };
  /** A navigation the tools start: a new origin asks the user (the card offers read and write), and a tainted turn's
   * address carrying data from another site asks too. */
  const gateNavigation = (tab, target, ctx) => span('gate', () => gateNavigationRun(tab, target, ctx));
  const gateNavigationRun = async (tab, target, ctx) => {
    const to = originOf(target);
    // within the page's own site an ordinary page needs no new card; a high-risk page (risk is per path), a URL with
    // credentials (it asks every time), a block or a denial still go through the grants
    const risk = to && to === originOf(tab.url) ? grants.riskOf(target) : null;
    const seen = risk ? grants.peek(target, 'read', ctx) : null;
    if (!risk || risk.level !== 'normal' || risk.credentials || seen === 'denied' || seen === 'blocked')
      await tabs.awaitUser(tab, grants.require(target, 'read', ctx, { offer: 'write', localAlways: false }), ctx.signal);
    await taintGate(tab, target, ctx, 'navigate', `navigate to ${target}`, { kind: 'navigate', to: target });
  };
  /** Whether the tab's page may be read without asking (as pageGate would let a read through). */
  const readable = (tab, ctx) => {
    try {
      const verdict = checkPage(tab, 'read', ctx);
      if (verdict !== 'ask') return verdict === 'ok';
      const risk = grants.riskOf(tab.url);
      return risk.level !== 'high' && !risk.credentials;
    } catch {
      return false;
    }
  };
  return { pageVerdict, checkPage, pageGate, gateNavigation, taintGate, readable };
}

module.exports = { pageGates };
