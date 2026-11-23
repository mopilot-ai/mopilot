// A test connector (#2999 C0) for the E2E runs: main registers it only with SAGE_DEBUG_TOOLS=1. Its sign-in is MoMo's real one (PKCE, the loopback wait for the browser's redirect, which the test makes itself), but its token endpoint is in-process: no provider is reached, and its .test URLs never resolve. Its two tools keep notes in memory, one read and one change.
const crypto = require('node:crypto');
const oauth = require('../../gateway/oauth.cjs');

const FAKE_ID = 'test-account';
const SCOPES = Object.freeze(['notes.read', 'notes.write']);

/** @param {{ now?: () => number }} [o] @returns {import('./hub.cjs').Connector} */
function fakeConnector({ now = Date.now } = {}) {
  const issued = async () => ({
    accessToken: `test-${crypto.randomBytes(8).toString('hex')}`,
    refreshToken: `test-${crypto.randomBytes(8).toString('hex')}`,
    expiresAt: now() + 3600_000,
    scopes: [...SCOPES],
  });
  /** @type {string[]} */
  const notes = [];
  return {
    id: FAKE_ID,
    label: 'Test account',
    scopes: [...SCOPES],
    oauth: { authorizeUrl: 'https://connector.test/authorize', tokenUrl: 'https://connector.test/token', clientId: 'mopilot-test' },
    flow: { listenForCode: oauth.listenForCode, exchangeCode: issued, refreshTokens: issued },
    tools: {
      list: {
        kind: 'read',
        description: 'List the test notes.',
        summary: () => 'List the test notes',
        run: async () => ({ notes: [...notes] }),
      },
      add: {
        kind: 'change',
        description: 'Add a test note.',
        summary: (a) => `Add the note "${String(a?.text ?? '')}"`,
        run: async (a) => {
          notes.push(String(a?.text ?? ''));
          return { added: true };
        },
      },
    },
  };
}

module.exports = { fakeConnector, FAKE_ID };
