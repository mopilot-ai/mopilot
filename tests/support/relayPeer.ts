// The model relay's peer check (electron/identity/accounts/relay.cjs admits) for tests whose client is the test process itself: every
// connection is taken as the app-server's, without lsof. tests/relayPeer.test.ts checks the real decision.
export const admitAll = { verifyPeer: async () => null };
