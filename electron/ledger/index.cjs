// The request ledger in main (issue #1316): one RequestLedger per app under <userData>/ledger, fed by a tap per harness
// family (Codex, Claude Code, ACP) from events the adapters already receive, so it records with no window open. The
// Privacy switch (prefs.requestLog, on unless set to false) is read at most every couple of seconds.
const os = require('node:os');
const path = require('node:path');
const { RequestLedger } = require('./store.cjs');
const { CodexLedgerTap } = require('./codexTap.cjs');
const { ClaudeLedgerTap } = require('./claudeTap.cjs');
const { AcpLedgerTap } = require('./acpTap.cjs');

/** How long a read of the Privacy switch stands. */
const PREF_MS = 2000;
/**
 * @typedef {{ store: InstanceType<typeof RequestLedger>, codex: InstanceType<typeof CodexLedgerTap>,
 *   claude: InstanceType<typeof ClaudeLedgerTap>, acp: InstanceType<typeof AcpLedgerTap> }} AppLedger
 */

/**
 * @param {object} o
 * @param {() => string} o.userData read when the ledger writes: main sets its userData folder after making this
 * @param {string} [o.home]
 * @param {() => Record<string, any>} o.prefs the saved prefs (ui-state.json)
 * @param {(nativeId: string) => string} o.chatOf a native thread id or session key to its MoPilot chat id
 * @param {(threadId: string, turnId: string) => import('./line.cjs').LedgerAccount | null} o.codexAccount
 * @param {(evt: any) => import('./line.cjs').LedgerAccount | null} o.claudeAccount
 * @param {() => number} [o.now]
 * @returns {AppLedger}
 */
function createRequestLedger(o) {
  const now = o.now ?? Date.now;
  let pref = { at: -Infinity, on: true };
  const enabled = () => {
    if (now() - pref.at > PREF_MS) pref = { at: now(), on: o.prefs()?.requestLog !== false };
    return pref.on;
  };
  const store = new RequestLedger({ dir: () => path.join(o.userData(), 'ledger'), enabled, home: o.home, now });
  const record = (r) => store.record(r);
  return {
    store,
    codex: new CodexLedgerTap({ record, chatOf: o.chatOf, accountOf: o.codexAccount }),
    claude: new ClaudeLedgerTap({ record, chatOf: o.chatOf, accountOf: o.claudeAccount }),
    acp: new AcpLedgerTap({ record, chatOf: o.chatOf }),
  };
}

/**
 * Main's ledger (electron/app/sessions.cjs): its folder in userData, the Privacy switch in the saved prefs, Codex turns
 * named by the pool's login (Accounts.turnAccount), Claude Code sessions by electron/harness/claude/index.cjs, whose events it observes.
 * @param {{ app: { getPath: (name: 'userData') => string }, readState: () => Record<string, any>,
 *   claude: { observe: (fn: (evt: any) => void) => unknown, ledgerAccount: (evt: any) => import('./line.cjs').LedgerAccount },
 *   live: { accounts?: { turnAccount: (threadId: string, turnId: string) => import('./line.cjs').LedgerAccount | null } | null },
 *   chatOf: (nativeId: string) => string }} o
 */
function openRequestLedger({ app, readState, claude, live, chatOf }) {
  const ledger = createRequestLedger({
    userData: () => app.getPath('userData'),
    home: os.homedir(),
    prefs: () => readState().prefs,
    chatOf,
    codexAccount: (threadId, turnId) => live.accounts?.turnAccount(threadId, turnId) ?? null,
    claudeAccount: claude.ledgerAccount,
  });
  claude.observe((evt) => ledger.claude.event(evt));
  return ledger;
}

module.exports = { createRequestLedger, openRequestLedger };
