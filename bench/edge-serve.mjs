// Serves the edge-case fixture site (bench/lib/edgePages.mjs) on localhost and 127.0.0.1 (two origins), and over HTTPS
// with a self-signed certificate when one is given, logging every page's events to a JSONL file.
// Usage: node bench/edge-serve.mjs [port=8790] [log=bench/results/edge-events.jsonl] [tls-key tls-cert]
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import path from 'node:path';
import { BENCH_DIR } from './lib/config.mjs';
import { edgeHandle } from './lib/edgePages.mjs';
import { holdStalled } from './lib/edgeParity.mjs';

const [port = '8790', log = path.join(BENCH_DIR, 'results/edge-events.jsonl'), key, cert] = process.argv.slice(2);
mkdirSync(path.dirname(log), { recursive: true });
/** @type {any[]} */
const events = [];

/** Logs one event for /api/events and the run's JSONL file. @param {Record<string, any>} event */
function record(event) {
  events.push(event);
  appendFileSync(log, `${JSON.stringify(event)}\n`);
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function serve(req, res) {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      // a malformed Host header: answered, never a crash of the server for the rest of the run
      res.writeHead(400).end('bad request');
      return;
    }
    const out = edgeHandle(
      { method: req.method ?? 'GET', url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') },
      events,
    );
    if (out.event) record(out.event);
    // a stalled answer (PW-1's report): headers now, and whether the browser stopped it is an event of its own
    if (out.stall) return holdStalled(res, /** @type {any} */ (out), record);
    res.writeHead(out.status, { 'cache-control': 'no-store', ...out.headers }).end(out.body);
  });
}

const p = Number(port);
for (const host of ['127.0.0.1', '::1']) {
  // ::1 is best effort: some machines have no IPv6 loopback, and localhost then resolves to 127.0.0.1 alone
  createServer(serve)
    .on('error', (e) => console.error(`http on ${host}: ${e.message}`))
    .listen(p, host);
  if (key && cert) {
    createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, serve)
      .on('error', (e) => console.error(`https on ${host}: ${e.message}`))
      .listen(p + 1, host);
  }
}
console.log(`edge fixtures on http://localhost:${p}${key ? ` and https://localhost:${p + 1}` : ''}, events in ${log}`);
