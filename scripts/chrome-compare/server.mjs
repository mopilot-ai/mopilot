// The Chrome comparison's page server: two loopback origins serving the tasks' fixture pages, recording what pages post, and a sign-in for the optional signed-in task.
import http from 'node:http';
import { ACCOUNT, fixturePages } from './tasks.mjs';

const MAX_BODY = 1 << 20;

/** Reads a JSON request body (at most MAX_BODY); null when it is not JSON. */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

/**
 * Starts the server for `tasks`. `records` maps a path to the bodies posted to it, in order; reset()
 * empties it between runs. /login signs the browser in (a session cookie), /whoami says who is signed in.
 * @param {{ tasks: typeof import('./tasks.mjs').TASKS, createServer?: typeof http.createServer }} o
 */
export async function startFixtureServer({ tasks, createServer = http.createServer }) {
  /** @type {Record<string, any[]>} */
  const records = {};
  /** @type {Record<string, string | { type: string, disposition: string, body: string }>} */
  let pages = {};
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST') {
      (records[url.pathname] ??= []).push(await readJson(req));
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      return res.end();
    }
    if (url.pathname === '/login') {
      res.writeHead(302, { 'set-cookie': `session=${ACCOUNT.user}; Path=/; HttpOnly; SameSite=Lax`, location: '/account' });
      return res.end();
    }
    if (url.pathname === '/whoami') {
      const signedIn = /(?:^|;\s*)session=tester(?:;|$)/.test(String(req.headers.cookie || ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(signedIn ? ACCOUNT : {}));
    }
    const html = pages[url.pathname];
    if (html === undefined) {
      res.writeHead(404);
      return res.end();
    }
    // a file (a download): served with its type and disposition, and recorded as fetched
    if (typeof html === 'object') {
      (records[url.pathname] ??= []).push({ fetched: true });
      res.writeHead(200, { 'content-type': html.type, 'content-disposition': html.disposition });
      return res.end(html.body);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  const main = createServer(handle);
  const frame = createServer(handle);
  const base = `http://127.0.0.1:${await listen(main)}`;
  const frameOrigin = `http://localhost:${await listen(frame)}`;
  pages = fixturePages(tasks, { frameOrigin });
  return {
    base,
    frameOrigin,
    records,
    reset() {
      for (const k of Object.keys(records)) delete records[k];
    },
    close() {
      main.close();
      frame.close();
    },
  };
}
