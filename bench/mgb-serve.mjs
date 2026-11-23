// Serves the MoPilot 12-Grid Bench fixture apps (bench/lib/mgb/apps) on <app>.localhost, one origin each, with the
// runner's token-guarded /__mgb/load and /__mgb/state. Usage: MGB_TOKEN=<16+ chars> node bench/mgb-serve.mjs [port=8820]
import { createServer } from 'node:http';
import { APPS } from './lib/mgb/apps/index.mjs';
import { createStore, dispatch } from './lib/mgb/apps/server.mjs';

const port = Number(process.argv[2] ?? 8820);
const token = process.env.MGB_TOKEN ?? '';
const store = createStore(APPS, token);

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function serve(req, res) {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let out;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      out = dispatch(
        store,
        { method: req.method ?? 'GET', url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') },
        Date.now(),
      );
    } catch (e) {
      // a malformed request or an app bug: answered, never a crash of the server for the rest of the run
      console.error(`${req.method} ${req.headers.host}${req.url}: ${/** @type {Error} */ (e).stack ?? e}`);
      out = { status: 500, headers: { 'content-type': 'text/plain' }, body: 'server error' };
    }
    try {
      res.writeHead(out.status, { 'cache-control': 'no-store', ...out.headers }).end(Buffer.from(out.body, out.encoding ?? 'utf8'));
    } catch (e) {
      console.error(`${req.method} ${req.headers.host}${req.url}: ${/** @type {Error} */ (e).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('server error');
    }
  });
}

for (const host of ['127.0.0.1', '::1']) {
  // ::1 is best effort: *.localhost resolves to either loopback
  createServer(serve)
    .on('error', (e) => console.error(`http on ${host}: ${e.message}`))
    .listen(port, host);
}
console.log(`MGB fixtures on http://<app>.localhost:${port}: ${APPS.map((a) => a.name).join(', ')}`);
