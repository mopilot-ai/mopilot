// The two site-permission tables main's browser tools check (design D4): the in-app browser's and Your Chrome's, with the cards they ask on and when nobody is there to answer one.
const path = require('node:path');
const { OriginGrants } = require('../capabilities/browser/origins.cjs');
const { SiteRisk, remoteLookup } = require('../capabilities/browser/siteRisk.cjs');
const { chatAnchorOf } = require('../capabilities/anchor.cjs');
const { usesSavedSites } = require('./computerAccess.cjs');

/** The sensitive actions (siteRisk.cjs) a phone never approves: money moving and a password changing are confirmed on the Mac. */
const MAC_ONLY_KINDS = new Set(['payment', 'payment_entry', 'purchase', 'transfer', 'password_change']);

/**
 * @param {{ live: any, dir: string, prefs: any, isFlagEnabled: (key: string) => boolean }} o
 *   live: main's late-bound services (sessions, controller, computerUse.broker, codexSiteBlocks); dir: where
 *   the tables are saved; prefs: the UI prefs the chat's anchor reads
 * @returns {{ browserGrants: InstanceType<typeof OriginGrants>, chromeGrants: InstanceType<typeof OriginGrants> }}
 */
function siteTables({ live, dir, prefs, isFlagEnabled }) {
  // "Allow and switch to Auto" on a site card (#1523): the window switches the chat to Auto, which a harness may take only
  // at its next turn; until this turn ends the chat's ordinary sites count as Auto here, in both browsers. A stricter mode
  // (read only) still wins.
  /** @type {Set<string>} */
  const autoThisTurn = new Set();
  const anchor = ({ chatId }) => {
    const a = chatAnchorOf(chatId, { sessions: live.sessions, controller: live.controller, prefs, remote: live.remoteOwners });
    return a === 'ask' && autoThisTurn.has(chatId) ? 'auto' : a;
  };
  // a remote owner of computer access (#1364) neither gets nor adds to the saved sites
  const usesSaved = usesSavedSites(live);
  // an ACP harness working with no prompt has nobody to answer a site or action card (#1319 G11): both refuse at once
  const attended = ({ chatId }) =>
    live.controller.adapterOf(chatId)?.toolsOutsidePrompt === true && !live.sessions.get(chatId)?.activeTurn
      ? 'a tool call outside a prompt'
      : null;
  // site risk classes (IAB-03): offline; the remote check only with its flag on and an endpoint set
  const risk = new SiteRisk({
    remote: process.env.MOPILOT_SITE_RISK_URL ? remoteLookup({ endpoint: process.env.MOPILOT_SITE_RISK_URL }) : null,
    remoteEnabled: () => isFlagEnabled('shared.browser.siteRiskRemote'),
  });
  // Codex Browser Use blocks (its config.toml and managed policy) are the user's own policy: they apply to MoPilot's
  // own browser tools in every chat, whatever its harness now or before a switch (#1319 G13)
  const external = (/** @type {string} */ url) => live.codexSiteBlocks?.reason(url) ?? null;
  // the page of a chat that runs on a machine is on that machine (its browser), not on this Mac: a card says so
  /** @param {string} chatId @returns {string | null} */
  const machineOf = (chatId) => {
    const hostId = live.hostOwnership?.get(chatId).hostId;
    return hostId && hostId !== 'local' ? (live.hostNameOf?.(hostId) ?? 'another machine') : null;
  };
  /** The card a table asks on (electron/capabilities/contract/approvals.cjs): the level needed and the levels to choose from; it names its browser. */
  /** @param {Parameters<ConstructorParameters<typeof OriginGrants>[0]['ask']>[0]} req */
  const askSite = async ({ chatId, browser, origin, need, allowAlways, risk: siteRisk, signal }) => {
    const onMachine = machineOf(chatId);
    const answer = await live.computerUse.broker.ask(
      chatId,
      'browserOrigin',
      {
        harness: live.controller.ref(chatId).kind,
        browser,
        origin,
        level: need,
        ...(onMachine ? { onMachine } : {}),
        ...(allowAlways === false || allowAlways === 'read' ? { allowAlways } : {}),
        ...(siteRisk ? { risk: siteRisk } : {}),
        levels: [
          { id: 'read', label: 'Read only' },
          { id: 'write', label: 'Read and write' },
        ],
      },
      { signal },
    );
    // Allow and switch to Auto: this step once, and Auto for the rest of the turn; a remote owner (#1364) never goes above Ask
    if (answer?.decision !== 'allow' || answer.then !== 'auto') return answer;
    if (!live.remoteOwners?.get(chatId)) autoThisTurn.add(chatId);
    return { ...answer, scope: 'once' };
  };
  // the chat's turn ended (either table tells it): a switch to Auto made on a site card is the chat's mode's from now on
  const turnEnd = (/** @type {string} */ chatId) => void autoThisTurn.delete(chatId);
  // an action on a high-risk site, or a sensitive action anywhere (in Full access only payment details and
  // password changes): the confirmation card, each time unless an ordinary action was allowed for the task or the site's
  // ordinary actions for good
  /** @param {Parameters<NonNullable<ConstructorParameters<typeof OriginGrants>[0]['confirmAction']>>[0]} req */
  const confirmAction = async ({
    chatId,
    browser,
    origin,
    tool,
    summary,
    actionTarget,
    sensitive,
    risk: siteRisk,
    signal,
    task,
    errand,
    commits,
    always,
  }) => {
    const onMachine = machineOf(chatId);
    const answer = await live.computerUse.broker.ask(
      chatId,
      'computerConfirm',
      {
        harness: live.controller.ref(chatId).kind,
        browser,
        app: { bundleId: origin, name: origin },
        verb: sensitive ? sensitive.verb : 'act on a high-risk site',
        // money moving or a password changing (siteRisk.cjs kinds): its card is answered on the Mac only (electron/remote/methods/card.cjs)
        ...(sensitive?.kind && MAC_ONLY_KINDS.has(sensitive.kind) ? { macOnly: sensitive.kind } : {}),
        summary,
        ...(actionTarget ? { actionTarget } : {}),
        tool,
        ...(onMachine ? { onMachine } : {}),
        ...(siteRisk ? { risk: siteRisk } : {}),
        // an ordinary action on a high-risk site: the card also offers "Allow for this task" (#2328)
        ...(task ? { task: true } : {}),
        // an ordinary action on a high-risk site: "Always allow on this site" (#5464)
        ...(always ? { siteAlways: true } : {}),
        // an ordinary message: "Allow messages for this errand" (errandGrants.cjs); one that commits says why it asks each time
        ...(errand ? { errand: true } : commits ? { commits } : {}),
      },
      { signal },
    );
    if (answer?.decision !== 'allow') return false;
    if (errand && answer.scope === 'errand') return 'errand';
    if (always && answer.scope === 'always') return 'always';
    return task && answer.scope === 'task' ? 'task' : true;
  };
  // the Registry's taint ledger (G3): a tainted turn's send, delete or submit asks in either browser
  const taint = () => live.capabilities?.taint ?? null;
  // one table per browser (D4): the grants saved before the split stay the in-app browser's; Your Chrome starts with none and asks again
  const browserGrants = new OriginGrants({
    browser: 'iab',
    file: path.join(dir, 'browser-sites.json'),
    anchor,
    risk,
    external,
    ask: askSite,
    confirmAction,
    attended,
    usesSaved,
    turnEnd,
    taint,
  });
  const chromeGrants = new OriginGrants({
    browser: 'chrome',
    file: path.join(dir, 'browser-sites-chrome.json'),
    anchor,
    risk,
    // and the user's Chrome's administrator's blocked sites, from MoPilot's extension (#1632)
    external: (url) => external(url) ?? live.chromeRelay?.policyBlock(url) ?? null,
    ask: askSite,
    confirmAction,
    attended,
    usesSaved,
    turnEnd,
    taint,
  });
  return { browserGrants, chromeGrants };
}

/**
 * The card for one JavaScript run or upload in a browser (the generic "can't be undone" confirmation, each call),
 * naming that browser like the site cards do, so the card reads as the browser's and says which one.
 * @param {any} live main's late-bound services (controller, computerUse.broker)
 * @param {'iab' | 'chrome'} browser
 */
const confirmCall =
  (live, browser) =>
  async (
    /** @type {{ chatId: string, signal?: AbortSignal | null }} */ { chatId, signal = null },
    /** @type {{ tool: string, origin: string, summary?: string }} */ { tool, origin, summary },
  ) => {
    const answer = await live.computerUse.broker.ask(
      chatId,
      'computerConfirm',
      {
        harness: live.controller.ref(chatId).kind,
        browser,
        app: { bundleId: origin, name: origin },
        verb: tool === 'JavaScript' ? 'run JavaScript' : 'upload files',
        summary,
        tool,
      },
      { signal },
    );
    return answer?.decision === 'allow';
  };

module.exports = { siteTables, confirmCall, MAC_ONLY_KINDS };
