// Two fake mail accounts (the draft card's Send) for the E2E and dev runs: main registers them only with SAGE_DEBUG_TOOLS=1, beside the test connector. Each signs in through MoMo's real flow with an in-process token endpoint, and its one tool, send_mail, only writes the mail into a list in memory: nothing is reached, nobody is written to, and no real mailbox is ever named. `failNext` makes the next send fail, as a provider's error would.
const crypto = require('node:crypto');
const oauth = require('../../gateway/oauth.cjs');
const { SEND_TOOL } = require('../../../shared/momoDraftSend.mjs');

const SCOPES = Object.freeze(['mail.send']);
/** The two accounts: ids, names and the addresses they send from (the .test domain never resolves). */
const ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'test-mail-home',
    label: 'Test mail (home)',
    account: 'home@mail.test',
  }),
  Object.freeze({
    id: 'test-mail-work',
    label: 'Test mail (work)',
    account: 'work@mail.test',
  }),
]);

/**
 * @param {{ id: string, label: string, account: string }} who
 * @param {{ now?: () => number, sent?: object[] }} [o] sent: where a sent mail is kept (the test reads it)
 * @returns {import('./hub.cjs').Connector & { failNext: (error?: Error | null) => void }}
 */
function fakeMailConnector(who, { now = Date.now, sent = [] } = {}) {
  const issued = async () => ({
    accessToken: `test-${crypto.randomBytes(8).toString('hex')}`,
    refreshToken: `test-${crypto.randomBytes(8).toString('hex')}`,
    expiresAt: now() + 3600_000,
    scopes: [...SCOPES],
  });
  /** @type {Error | null} */
  let failing = null;
  return {
    id: who.id,
    label: who.label,
    scopes: [...SCOPES],
    oauth: {
      authorizeUrl: 'https://mail.test/authorize',
      tokenUrl: 'https://mail.test/token',
      clientId: 'mopilot-test',
    },
    flow: {
      listenForCode: oauth.listenForCode,
      exchangeCode: issued,
      refreshTokens: issued,
    },
    failNext(error = new Error('the test provider refused')) {
      failing = error;
    },
    tools: {
      [SEND_TOOL]: {
        kind: 'change',
        needsPress: true,
        description: 'Send a mail from this test account.',
        summary: (a) => `Send “${String(a?.subject || 'No subject').slice(0, 80)}” from ${who.account}`,
        run: async (a) => {
          if (failing) {
            const error = failing;
            failing = null;
            throw error;
          }
          sent.push({
            from: who.account,
            to: a?.to ?? [],
            subject: a?.subject ?? '',
            body: a?.body ?? '',
            at: now(),
          });
          return { sent: true };
        },
      },
    },
  };
}

module.exports = { fakeMailConnector, ACCOUNTS };
