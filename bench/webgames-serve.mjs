// Serves a built WebGames dist offline and logs every completion a page reports, so a task passes only when the
// page itself saw it solved. Usage: node bench/webgames-serve.mjs <dist> [port=8800] [log=bench/results/webgames-completions.jsonl]
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { BENCH_DIR } from './lib/config.mjs';
import { completionEntry, contentType, staticFile } from './lib/webgames.mjs';

const [dist, port = '8800', log = path.join(BENCH_DIR, 'results/webgames-completions.jsonl')] = process.argv.slice(2);
if (!dist) throw new Error('usage: node bench/webgames-serve.mjs <dist> [port] [log]');
mkdirSync(path.dirname(log), { recursive: true });
const isFile = (/** @type {string} */ f) => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (url.pathname === '/api/record-completion') appendFileSync(log, completionEntry(body, req.headers['user-agent']));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
    });
    return;
  }
  const file = staticFile(dist, url.pathname, isFile);
  res.writeHead(200, { 'content-type': contentType(file) }).end(readFileSync(file));
}).listen(Number(port), '127.0.0.1', () => console.log(`webgames on http://127.0.0.1:${port}, completions in ${log}`));
