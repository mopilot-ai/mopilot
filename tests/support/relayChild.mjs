// A relay in its own process (a fake database and a verifier that takes its time), so a test can attack it and see whether the process survives; prints its port.
import { createRelay } from '../../relay/src/server.mjs';
import { loadConfig } from '../../relay/src/config.mjs';

const config = loadConfig({ AUTH_PUBLIC_KEY: 'x', DATABASE_URL: 'postgres://unused' });
const delay = Number(process.argv[2] ?? 0);
const relay = createRelay({
  config,
  db: { query: async () => ({ rows: [] }) },
  verifier: {
    verify: () => new Promise((resolve) => setTimeout(() => resolve(null), delay)),
    verifyRevocation: async () => null,
  },
  send: null,
});
const port = await relay.listen(0, '127.0.0.1');
console.log(JSON.stringify({ port }));
