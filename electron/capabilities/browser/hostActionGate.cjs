// The browser tools' action gate: what every browser_* action and browser_script step passes before it changes a page (hostTools.cjs).
const { ToolError } = require('../contract/registry.cjs');
const { sensitiveAction, needsIntent, typesText } = require('./siteRisk.cjs');
const { submitTaint } = require('./submitTaint.cjs');
const { taskCovers } = require('./taskGrants.cjs');
const { messageOf } = require('./errandGrants.cjs');
const { oneLine } = require('./host.cjs');
const { refuseBotCheck, HANDOFF, SIGN_IN } = require('./botCheck.cjs');

/**
 * @param {{ tabs: any, grants: any, pageGate: Function, checkPage: Function, refused: 'chrome' | null, chromeRoute?: ((chatId: string) => string | null) | null }} o
 */
function createActionGate({ tabs, grants, pageGate, checkPage, refused, chromeRoute = null }) {
  /**
   * Before an action that changes the page: password fields refuse typing, a bot check refuses any action (botCheck.cjs), a
   * sensitive action or any action on a high-risk site asks the user (grants.act). `action`: { kind: 'click' | 'key' | 'type' |
   * 'fill' | 'drag' | 'select' | 'check' | 'dialog', target?: { ref } | { point }, keys?, accept?,
   * message?, summary }. Every browser_* action and browser_script step goes through here.
   */
  return async (tab, ctx, action) => {
    // the site's own card first, wherever the action came from: a write on a site allowed for reading asks (#1319 G22)
    await pageGate(tab, 'write', ctx);
    const intent = needsIntent(action) ? await tabs.intent(tab, action.target || {}) : null;
    checkPage(tab, 'write', ctx);
    const route = refused || chromeRoute?.(ctx.chatId) ? 'chrome' : 'pane'; // the user's Chrome: no pane hand-off or sign-in
    if (intent?.secret && typesText(action))
      throw new ToolError(
        `${intent.name ? `"${oneLine(intent.name, 80)}"` : 'This field'} is a password field: agents never type passwords. ${SIGN_IN[route]}`,
        'password_field',
      );
    refuseBotCheck(intent, action, HANDOFF[route]);
    const sensitive = sensitiveAction(intent, action);
    const summary = `${action.summary}${sensitive?.detail && !String(action.summary).includes(sensitive.detail) ? ` ("${sensitive.detail}")` : ''}`;
    // "Allow for this task" on a financial site covers an ordinary action (#2328); a send carries its declared kind and typed text
    const [ordinary, message] = [taskCovers(intent, action), messageOf(tab, action, sensitive, ctx)];
    const taint = submitTaint(intent, action);
    const asked = await tabs.awaitUser(
      tab,
      // a tainted turn's submit asks too (G3)
      grants.act(tab.url, ctx, { tool: action.kind, summary, sensitive, ordinary, message, taint }),
      ctx.signal,
    );
    checkPage(tab, 'write', ctx);
    // the page may have changed while the card was open: typing goes where the focus is now, a click where it lands now
    const now = asked && intent ? await tabs.intent(tab, action.target || {}) : null;
    if (now?.secret && typesText(action))
      throw new ToolError(
        `The focus moved to a password field while the user was being asked: agents never type passwords. ${SIGN_IN[route]}`,
        'password_field',
      );
    refuseBotCheck(now, action, HANDOFF[route]);
    if (asked && taint && taint.to !== (submitTaint(now, action)?.to ?? ''))
      throw new ToolError('The form destination changed while you answered. Read the page and try again.', 'page_changed');
    if (ordinary && asked && !taskCovers(now, action))
      throw new ToolError('The control changed while you answered. Read the page and try again.', 'page_changed');
    // whether consent was required: even task-covered actions recheck the page before input
    return !!asked;
  };
}

module.exports = { createActionGate };
