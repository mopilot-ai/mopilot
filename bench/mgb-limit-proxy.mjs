// The MoPilot 12-Grid Bench provider proxy (#1381, F8): Claude Code in the bench's Claude instance talks to Anthropic
// through it (ANTHROPIC_BASE_URL), and when the runner arms it for a run it answers one model request with the
// usage-limit error, then lets everything through again. Runs only in the benchmark VM.
// Usage: MGB_TOKEN=<the runner's token> node bench/mgb-limit-proxy.mjs [port=8830] [upstream=https://api.anthropic.com]
import { createServer } from 'node:http';
import { requireVm } from './lib/guard.mjs';
import { TOKEN_HEADER } from './lib/mgb/apps/server.mjs';
import { createLimiter, limitResponse } from './lib/mgb/limiter.mjs';

requireVm('bench/mgb-limit-proxy.mjs');
const port = Number(process.argv[2] ?? 8830);
const upstream = new URL(process.argv[3] ?? 'https://api.anthropic.com');
const token = process.env.MGB_TOKEN ?? '';
if (token.length < 16) throw new Error('set MGB_TOKEN (16+ characters), the same one the runner uses');
const limiter = createLimiter();

createServer((req, res) => {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const path = req.url ?? '/';
    // the runner's control endpoints: never reachable without its token
    if (path.startsWith('/__limit/')) {
      if (req.headers[TOKEN_HEADER] !== token) return res.writeHead(404).end();
      try {
        if (path === '/__limit/arm' && req.method === 'POST') {
          const { tag, afterRequests } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          limiter.arm(tag, afterRequests);
        } else if (path === '/__limit/disarm' && req.method === 'POST') limiter.disarm();
        // '/__limit/state' only reads
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(limiter.state()));
      } catch (e) {
        return res.writeHead(400).end(String(/** @type {Error} */ (e).message));
      }
    }
    if (limiter.decide(req.method ?? 'GET', path) === 'limit') {
      const out = limitResponse(Math.floor(Date.now() / 1000) + 3600);
      return res.writeHead(out.status, out.headers).end(out.body);
    }
    try {
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)),
      );
      const r = await fetch(new URL(path, upstream), {
        method: req.method,
        headers: /** @type {Record<string, string>} */ (headers),
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
        // @ts-ignore Node's fetch streams a request body only with duplex: 'half'
        duplex: 'half',
      });
      res.writeHead(
        r.status,
        Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))),
      );
      // streamed answers (server-sent events) go through as they arrive
      for await (const part of /** @type {any} */ (r.body ?? [])) res.write(part);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy error: ${/** @type {Error} */ (e).message}`);
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`MGB provider proxy on http://127.0.0.1:${port} → ${upstream.origin}`));
