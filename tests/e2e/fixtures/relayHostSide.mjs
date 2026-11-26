// The machine's side of tests/e2e/app-crypto-electron.spec.ts, on plain Node (as a Host runs): a relay (the relay's own server on an in-process database, tests/support/relayKit.ts), and a Host's relay links (host/src/relayLink.mjs) in front of an echo socket, so what the app sends through its relay tunnel comes back. It prints one JSON line with what the app needs (the relay's address, an account token, and where to ask the Host to enroll), serves the enrollment over HTTP on loopback, and ends with its stdin.
//   node tests/e2e/fixtures/relayHostSide.mjs <work dir>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createServer } from 'node:http';
import { loadConfig } from '../../../relay/src/config.mjs';
import { createVerifier } from '../../../relay/src/auth.mjs';
import { createRelay } from '../../../relay/src/server.mjs';
import { createRelayLinks } from '../../../host/src/relayLink.mjs';
import { makeDb, makeKeys } from '../../support/relayKit.ts';

const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });
const keys = await makeKeys();
const { db } = await makeDb();
const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
const relay = createRelay({ config, db, verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }), send: null });
const port = await relay.listen(0, '127.0.0.1');

// the Host's own socket: an echo, so what comes back went there and back
const hostSock = path.join(dir, 'host.sock');
const echo = net.createServer((s) => s.pipe(s));
await new Promise((r) => echo.listen(hostSock, () => r(undefined)));
const links = createRelayLinks({ configDir: path.join(dir, 'host-config'), socketPath: hostSock });

// what the app's paired connection would carry to the Host: `host.relayEnroll` and `host.relayForget`
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const { method, params } = JSON.parse(body);
      const result = method === 'host.relayEnroll' ? links.enroll(params) : links.forget(params);
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', () => r(undefined)));
const apiPort = /** @type {import('node:net').AddressInfo} */ (api.address()).port;

process.stdout.write(
  `${JSON.stringify({ relayUrl: `ws://127.0.0.1:${port}/v1/ws`, token: await keys.sign('u-electron', 'mac-electron'), host: `http://127.0.0.1:${apiPort}` })}\n`,
);
process.stdin.resume();
process.stdin.on('end', async () => {
  links.close();
  echo.close();
  api.close();
  await relay.close();
  process.exit(0);
});
